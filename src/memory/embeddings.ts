/**
 * Clementine TypeScript — Embedding Provider.
 *
 * Two paths share this module:
 *
 *  1. Sparse TF-IDF (legacy, sync). 512-dim, built from in-memory vocab.
 *     Always available, runs synchronously, no external deps. Stored in
 *     chunks.embedding (BLOB).
 *
 *  2. Dense neural (preferred when available, async). Uses
 *     `@xenova/transformers` to run a local sentence-embedding model
 *     (default: Snowflake/snowflake-arctic-embed-m-v1.5, 768-dim) entirely
 *     on-device. Stored in chunks.embedding_dense (BLOB) with
 *     chunks.embedding_dense_model tracking which model produced it.
 *
 * Runtime behavior:
 *  - At store insert time, sync TF-IDF is computed (cheap, no I/O).
 *  - At query time, the agent first tries embedDense() (async). If that
 *    succeeds, dense search is used. Otherwise it falls back to TF-IDF.
 *  - Dense backfill runs out-of-band via `clementine memory:reembed`.
 *
 * The dense model is lazy-loaded on first use. Model files (~440MB for
 * arctic-embed-m) cache to ~/.clementine/models/ so subsequent runs are fast.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.embeddings' });

/** Dimension of the TF-IDF embedding vectors. */
const EMBEDDING_DIM = 512;

/** IDF vocabulary — built from corpus, cached to disk. */
let idfVocab: Map<string, number> | null = null;
let vocabWords: string[] = [];

const VOCAB_PATH = path.join(BASE_DIR, '.embedding-vocab.json');

/**
 * Load or initialize the IDF vocabulary.
 * The vocabulary maps the top-N words to their IDF weights.
 */
function loadVocab(): void {
  if (idfVocab) return;

  if (existsSync(VOCAB_PATH)) {
    try {
      const data = JSON.parse(readFileSync(VOCAB_PATH, 'utf-8'));
      idfVocab = new Map(Object.entries(data));
      vocabWords = [...idfVocab.keys()];
      return;
    } catch {
      logger.debug('Failed to load embedding vocab — will rebuild');
    }
  }

  // Start with empty vocab — will be built on first buildVocab() call
  idfVocab = new Map();
  vocabWords = [];
}

/**
 * Build the IDF vocabulary from a corpus of text chunks.
 * Should be called periodically (e.g., during evening consolidation) with all chunk contents.
 */
export function buildVocab(documents: string[]): void {
  if (documents.length === 0) return;

  // Compute document frequency for each word
  const df = new Map<string, number>();
  const N = documents.length;

  for (const doc of documents) {
    const words = new Set(tokenize(doc));
    for (const word of words) {
      df.set(word, (df.get(word) ?? 0) + 1);
    }
  }

  // Select top EMBEDDING_DIM words by document frequency (must appear in at least 2 docs)
  const sorted = [...df.entries()]
    .filter(([, count]) => count >= 2 && count < N * 0.95) // skip too-rare and too-common
    .sort((a, b) => b[1] - a[1])
    .slice(0, EMBEDDING_DIM);

  idfVocab = new Map();
  vocabWords = [];
  for (const [word, count] of sorted) {
    const idf = Math.log(N / (1 + count));
    idfVocab.set(word, idf);
    vocabWords.push(word);
  }

  // Persist to disk
  try {
    mkdirSync(path.dirname(VOCAB_PATH), { recursive: true });
    writeFileSync(VOCAB_PATH, JSON.stringify(Object.fromEntries(idfVocab)));
    logger.info({ vocabSize: vocabWords.length, corpusSize: N }, 'Embedding vocabulary built');
  } catch (err) {
    logger.debug({ err }, 'Failed to persist embedding vocabulary');
  }
}

/**
 * Tokenize text into lowercase words, filtering short words and stop words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute a TF-IDF embedding vector for a text string.
 * Returns a Float32Array of length EMBEDDING_DIM, or null if vocab isn't ready.
 */
export function embed(text: string): Float32Array | null {
  loadVocab();
  if (!idfVocab || vocabWords.length === 0) return null;

  const words = tokenize(text);
  if (words.length === 0) return null;

  // Compute term frequency
  const tf = new Map<string, number>();
  for (const word of words) {
    tf.set(word, (tf.get(word) ?? 0) + 1);
  }

  // Build TF-IDF vector
  const vec = new Float32Array(vocabWords.length);
  for (let i = 0; i < vocabWords.length; i++) {
    const word = vocabWords[i];
    const termFreq = tf.get(word) ?? 0;
    const idf = idfVocab!.get(word) ?? 0;
    vec[i] = termFreq * idf;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value in [-1, 1] where 1 = identical, 0 = orthogonal.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // Already L2-normalized, so dot product = cosine similarity
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer (from SQLite BLOB) back to Float32Array.
 */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) {
    view[i] = buf[i];
  }
  return new Float32Array(ab);
}

/**
 * Check if the embedding system is ready (vocabulary loaded with sufficient words).
 */
export function isReady(): boolean {
  loadVocab();
  return vocabWords.length >= 50; // need at least 50 vocab words
}

/**
 * Stable hash of the current vocabulary's word→dimension mapping. When this
 * changes, previously-stored embedding vectors become silently incorrect
 * because dimension N now represents a different word. Callers (MemoryStore
 * backfill) use this hash to detect staleness and invalidate stored vectors.
 */
export function getVocabHash(): string {
  loadVocab();
  if (vocabWords.length === 0) return '';
  // Order-sensitive: dimension assignment depends on insertion order.
  return createHash('sha1').update(vocabWords.join('|')).digest('hex').slice(0, 16);
}

// ── Dense neural embeddings (transformers.js) ─────────────────────────

/** Default dense model. Override with EMBEDDING_DENSE_MODEL env. */
const DEFAULT_DENSE_MODEL = 'Snowflake/snowflake-arctic-embed-m-v1.5';
/** Output dimension. Both arctic-embed-m and bge-base produce 768-dim vectors. */
const DENSE_DIMENSION = 768;
/** Where transformers.js caches model weights. */
const MODEL_CACHE_DIR = path.join(BASE_DIR, 'models');

/** Configured model id (lazy-resolved). */
function getDenseModelId(): string {
  return process.env.EMBEDDING_DENSE_MODEL || DEFAULT_DENSE_MODEL;
}

/** Cached pipeline. Promise-shaped so concurrent first-use callers share one load. */
let densePipelinePromise: Promise<unknown> | null = null;
/** Tristate readiness: undefined = not tried, true = loaded, false = load failed. */
let denseLoadState: undefined | true | false = undefined;

/** Force re-initialization on next embed call (used by memory:reembed --provider). */
export function resetDensePipeline(): void {
  densePipelinePromise = null;
  denseLoadState = undefined;
}

async function getDensePipeline(): Promise<unknown> {
  if (densePipelinePromise) return densePipelinePromise;
  densePipelinePromise = (async () => {
    try {
      mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    } catch { /* non-fatal */ }
    const transformers = (await import('@xenova/transformers')) as unknown as {
      pipeline: (task: string, model: string) => Promise<unknown>;
      env: { cacheDir?: string; localURL?: string; allowLocalModels?: boolean };
    };
    transformers.env.cacheDir = MODEL_CACHE_DIR;
    transformers.env.allowLocalModels = true;
    const modelId = getDenseModelId();
    logger.info({ modelId, cacheDir: MODEL_CACHE_DIR }, 'Loading dense embedding model (first use downloads ~440MB)');
    const pipe = await transformers.pipeline('feature-extraction', modelId);
    denseLoadState = true;
    logger.info({ modelId }, 'Dense embedding model loaded');
    return pipe;
  })().catch((err) => {
    denseLoadState = false;
    logger.warn({ err }, 'Dense embedding model failed to load — falling back to TF-IDF');
    densePipelinePromise = null;
    throw err;
  });
  return densePipelinePromise;
}

/** Compute a dense neural embedding. isQuery=true prefixes with the
 *  arctic-embed retrieval instruction; isQuery=false embeds passages raw. */
export async function embedDense(text: string, isQuery: boolean = false): Promise<Float32Array | null> {
  if (!text || !text.trim()) return null;
  try {
    const pipe = await getDensePipeline();
    const input = isQuery
      ? `Represent this sentence for searching relevant passages: ${text}`
      : text;
    // arctic-embed uses CLS pooling per its model card; bge models accept
    // either cls or mean. CLS is the safe default for the arctic family.
    const output = await (pipe as (text: string, opts: unknown) => Promise<{ data: Float32Array }>)(
      input,
      { pooling: 'cls', normalize: true },
    );
    // output.data is a Float32Array view — copy so the underlying buffer
    // doesn't get reused by the next call.
    return new Float32Array(output.data);
  } catch (err) {
    logger.debug({ err }, 'Dense embed failed');
    return null;
  }
}

/** Sequential batch — transformers.js doesn't easily batch on-CPU and
 *  parallelism produces tiny gains while doubling memory. Used by backfill. */
export async function embedDenseBatch(texts: string[]): Promise<Array<Float32Array | null>> {
  const results: Array<Float32Array | null> = [];
  for (const text of texts) {
    results.push(await embedDense(text, false));
  }
  return results;
}

export function denseDimension(): number {
  return DENSE_DIMENSION;
}

export function currentDenseModel(): string {
  return getDenseModelId();
}

/** Has the dense model loaded successfully at least once?
 *  Returns false if not yet attempted or load previously failed. */
export function isDenseReady(): boolean {
  return denseLoadState === true;
}

/** Probe whether dense embeddings are usable in this process. Triggers
 *  the model load if it hasn't happened yet. Used at daemon startup so
 *  later query-time embeds don't pay the load cost. */
export async function probeDenseReady(): Promise<boolean> {
  try {
    await getDensePipeline();
    return true;
  } catch {
    return false;
  }
}

const STOP_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
  'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an',
  'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so',
  'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
  'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them',
  'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its',
  'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our',
  'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
  'any', 'these', 'give', 'day', 'most', 'was', 'are', 'has', 'had',
  'been', 'were', 'did', 'does', 'done', 'being',
]);
