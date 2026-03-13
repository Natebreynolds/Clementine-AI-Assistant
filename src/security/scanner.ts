/**
 * Clementine TypeScript — 5-layer prompt injection scanner.
 *
 * All layers are synchronous, zero-dependency, and CPU-only.
 * Target overhead: <5ms per message.
 */

import {
  STRUCTURAL_PATTERNS,
  SEMANTIC_AXES,
  SEMANTIC_WARN_THRESHOLD,
  SEMANTIC_BLOCK_THRESHOLD,
  BLACKLIST_PHRASES,
  BLACKLIST_FUZZY_DISTANCE,
  LENGTH_WARN,
  LENGTH_BLOCK,
  ENTROPY_WARN,
  ENTROPY_BLOCK,
  ENTROPY_MIN_FOR_LONG,
  ENTROPY_LONG_THRESHOLD,
  COMPOSITE_WARN,
  COMPOSITE_BLOCK,
} from './patterns.js';
import { IntegrityMonitor } from './integrity.js';

// ── Types ──────────────────────────────────────────────────────────

export interface LayerResult {
  layer: number;
  name: string;
  triggered: boolean;
  detail: string;
}

export interface ScanResult {
  verdict: 'pass' | 'warn' | 'block';
  reasons: string[];
  score: number;
  layers: LayerResult[];
}

// ── Utilities ──────────────────────────────────────────────────────

/** Compute Shannon entropy over character frequencies. */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of text) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = text.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Compute Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ── InjectionScanner ───────────────────────────────────────────────

export class InjectionScanner {
  private integrity: IntegrityMonitor;

  constructor(integrity: IntegrityMonitor) {
    this.integrity = integrity;
  }

  /** Refresh integrity baselines (call after legitimate vault writes). */
  refreshIntegrity(): void {
    this.integrity.refresh();
  }

  /** Refresh integrity baselines only if stale (skip if refreshed within maxAgeMs). */
  refreshIfStale(maxAgeMs = 5000): void {
    this.integrity.refreshIfStale(maxAgeMs);
  }

  /** Run all 5 layers and return a composite verdict. */
  scan(text: string): ScanResult {
    const reasons: string[] = [];
    const layers: LayerResult[] = [];
    let score = 0;
    let forceBlock = false;

    // ── Layer 1: Structural Pattern Scan ────────────────────────

    let l1Triggered = false;
    const l1Details: string[] = [];

    for (const pattern of STRUCTURAL_PATTERNS) {
      if (pattern.regex.test(text)) {
        l1Triggered = true;
        score += pattern.weight;
        const reason = `L1: structural match — ${pattern.label}`;
        reasons.push(reason);
        l1Details.push(pattern.label);
      }
    }

    layers.push({
      layer: 1,
      name: 'Structural Pattern Scan',
      triggered: l1Triggered,
      detail: l1Triggered ? `Matched: ${l1Details.join(', ')}` : 'No matches',
    });

    // ── Layer 2: Semantic Anomaly Score ─────────────────────────

    const lower = text.toLowerCase();
    let semanticComposite = 0;
    let totalWeight = 0;
    const l2Details: string[] = [];

    for (const axis of SEMANTIC_AXES) {
      let matches = 0;
      for (const keyword of axis.keywords) {
        if (lower.includes(keyword)) matches++;
      }
      const axisScore = axis.keywords.length > 0 ? matches / axis.keywords.length : 0;
      semanticComposite += axisScore * axis.weight;
      totalWeight += axis.weight;

      if (matches > 0) {
        l2Details.push(`${axis.name}: ${matches}/${axis.keywords.length}`);
      }
    }

    const normalizedSemantic = totalWeight > 0 ? semanticComposite / totalWeight : 0;
    const l2Triggered = normalizedSemantic >= SEMANTIC_WARN_THRESHOLD;

    if (normalizedSemantic >= SEMANTIC_BLOCK_THRESHOLD) {
      score += 0.4;
      reasons.push(`L2: high semantic anomaly (${normalizedSemantic.toFixed(2)})`);
    } else if (l2Triggered) {
      score += normalizedSemantic * 0.3;
      reasons.push(`L2: elevated semantic anomaly (${normalizedSemantic.toFixed(2)})`);
    }

    layers.push({
      layer: 2,
      name: 'Semantic Anomaly Score',
      triggered: l2Triggered,
      detail: l2Details.length > 0
        ? `Axes: ${l2Details.join('; ')} (composite: ${normalizedSemantic.toFixed(2)})`
        : `No anomalies (composite: ${normalizedSemantic.toFixed(2)})`,
    });

    // ── Layer 3: Context Integrity Check ────────────────────────

    const integrityResults = this.integrity.check();
    const tampered = integrityResults.filter((r) => r.tampered);
    const l3Triggered = tampered.length > 0;

    if (l3Triggered) {
      forceBlock = true;
      for (const t of tampered) {
        const shortFile = t.file.split('/').slice(-2).join('/');
        reasons.push(`L3: integrity violation — ${shortFile} was modified`);
      }
    }

    layers.push({
      layer: 3,
      name: 'Context Integrity Check',
      triggered: l3Triggered,
      detail: l3Triggered
        ? `Tampered: ${tampered.map((t) => t.file.split('/').pop()).join(', ')}`
        : 'All checksums valid',
    });

    // ── Layer 4: Blacklist Filter ───────────────────────────────

    const normalized = lower.replace(/\s+/g, ' ').trim();
    let l4Triggered = false;
    const l4Details: string[] = [];

    // Exact match
    for (const phrase of BLACKLIST_PHRASES) {
      if (normalized.includes(phrase)) {
        l4Triggered = true;
        score += 0.3;
        l4Details.push(`exact: "${phrase}"`);
        reasons.push(`L4: blacklist exact match — "${phrase}"`);
      }
    }

    // Fuzzy match (only if no exact matches found)
    if (!l4Triggered) {
      for (const phrase of BLACKLIST_PHRASES) {
        const phraseLen = phrase.length;
        // Scale fuzzy tolerance by phrase length — short phrases get tighter matching
        // to avoid false positives like "you are always" ≈ "you are dan"
        const maxDist = phraseLen >= 20 ? BLACKLIST_FUZZY_DISTANCE : 1;
        const windowMin = Math.max(0, phraseLen - maxDist);
        const windowMax = phraseLen + maxDist;

        // Slide a window across the normalized text
        for (let start = 0; start <= normalized.length - windowMin; start++) {
          for (let end = start + windowMin; end <= Math.min(start + windowMax, normalized.length); end++) {
            const substring = normalized.slice(start, end);
            if (levenshtein(substring, phrase) <= maxDist) {
              l4Triggered = true;
              score += 0.2;
              l4Details.push(`fuzzy: "${phrase}"`);
              reasons.push(`L4: blacklist fuzzy match — "${phrase}"`);
              break;
            }
          }
          if (l4Triggered) break;
        }
        if (l4Triggered) break;  // One fuzzy match is enough
      }
    }

    layers.push({
      layer: 4,
      name: 'Blacklist Filter',
      triggered: l4Triggered,
      detail: l4Triggered ? `Matched: ${l4Details.join(', ')}` : 'No matches',
    });

    // ── Layer 5: Entropy & Length Heuristics ─────────────────────

    let l5Triggered = false;
    const l5Details: string[] = [];
    const msgLen = text.length;
    const entropy = shannonEntropy(text);

    // Length checks
    if (msgLen > LENGTH_BLOCK) {
      l5Triggered = true;
      score += 0.3;
      l5Details.push(`length ${msgLen} > block threshold ${LENGTH_BLOCK}`);
      reasons.push(`L5: message too long (${msgLen} chars)`);
    } else if (msgLen > LENGTH_WARN) {
      l5Triggered = true;
      score += 0.1;
      l5Details.push(`length ${msgLen} > warn threshold ${LENGTH_WARN}`);
      reasons.push(`L5: message unusually long (${msgLen} chars)`);
    }

    // High entropy (encoded payloads)
    if (entropy > ENTROPY_BLOCK) {
      l5Triggered = true;
      score += 0.25;
      l5Details.push(`entropy ${entropy.toFixed(2)} > block threshold ${ENTROPY_BLOCK}`);
      reasons.push(`L5: very high entropy (${entropy.toFixed(2)}) — possible encoded payload`);
    } else if (entropy > ENTROPY_WARN) {
      l5Triggered = true;
      score += 0.1;
      l5Details.push(`entropy ${entropy.toFixed(2)} > warn threshold ${ENTROPY_WARN}`);
      reasons.push(`L5: high entropy (${entropy.toFixed(2)})`);
    }

    // Low entropy on long messages (repetitive padding)
    if (msgLen > ENTROPY_LONG_THRESHOLD && entropy < ENTROPY_MIN_FOR_LONG) {
      l5Triggered = true;
      score += 0.15;
      l5Details.push(`low entropy ${entropy.toFixed(2)} on long message — repetitive padding`);
      reasons.push(`L5: suspiciously low entropy on long message (${entropy.toFixed(2)})`);
    }

    layers.push({
      layer: 5,
      name: 'Entropy & Length Heuristics',
      triggered: l5Triggered,
      detail: l5Details.length > 0
        ? l5Details.join('; ')
        : `OK (length: ${msgLen}, entropy: ${entropy.toFixed(2)})`,
    });

    // ── Verdict ─────────────────────────────────────────────────

    // Clamp score to 0–1
    score = Math.min(1.0, Math.max(0, score));

    let verdict: 'pass' | 'warn' | 'block';
    if (forceBlock || score >= COMPOSITE_BLOCK) {
      verdict = 'block';
    } else if (score >= COMPOSITE_WARN || reasons.length > 0) {
      verdict = 'warn';
    } else {
      verdict = 'pass';
    }

    return { verdict, reasons, score, layers };
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _scanner: InjectionScanner | null = null;

export function getScanner(): InjectionScanner {
  if (!_scanner) {
    _scanner = new InjectionScanner(new IntegrityMonitor());
  }
  return _scanner;
}

export const scanner = getScanner();
