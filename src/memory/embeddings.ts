/**
 * Clementine TypeScript — Embedding Provider.
 *
 * Provides vector embeddings for memory chunks to enable semantic search.
 * Uses a lightweight local approach (TF-IDF vectors stored as Float32Array blobs)
 * that runs without external API calls or heavy WASM dependencies.
 *
 * The embedding column (BLOB) in the chunks table stores serialized Float32Arrays.
 * Query-time: embed the query, compute cosine similarity against stored vectors.
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
