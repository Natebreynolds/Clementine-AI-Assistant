import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdvisorRules, _resetLoaderState } from '../src/agent/advisor-rules/loader.js';

describe('advisor rules loader', () => {
  let baseDir: string;
  let pkgBuiltinDir: string;

  beforeEach(() => {
    _resetLoaderState();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-rules-'));
    pkgBuiltinDir = mkdtempSync(path.join(tmpdir(), 'clementine-rules-pkg-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(pkgBuiltinDir, { recursive: true, force: true });
  });

  it('loads valid YAML rules and sorts by priority', () => {
    writeFileSync(path.join(pkgBuiltinDir, 'high.yaml'), `
schemaVersion: 1
id: high-priority
description: high
priority: 100
when:
  - kind: noRecentRuns
then:
  - kind: setModel
    model: x
`);
    writeFileSync(path.join(pkgBuiltinDir, 'low.yaml'), `
schemaVersion: 1
id: low-priority
description: low
priority: 10
when:
  - kind: noRecentRuns
then:
  - kind: setModel
    model: y
`);
    const rules = loadAdvisorRules({ baseDir, pkgBuiltinDir });
    expect(rules.length).toBe(2);
    expect(rules[0].id).toBe('low-priority');
    expect(rules[1].id).toBe('high-priority');
  });

  it('skips invalid YAML files with a warning, does not throw', () => {
    writeFileSync(path.join(pkgBuiltinDir, 'good.yaml'), `
schemaVersion: 1
id: good
description: good
priority: 10
when:
  - kind: noRecentRuns
then:
  - kind: setModel
    model: x
`);
    writeFileSync(path.join(pkgBuiltinDir, 'bad.yaml'), 'this is not: { valid yaml');
    writeFileSync(path.join(pkgBuiltinDir, 'wrong-shape.yaml'), `
schemaVersion: 99
id: wrong
description: x
when: []
then: []
`);
    const rules = loadAdvisorRules({ baseDir, pkgBuiltinDir });
    expect(rules.length).toBe(1);
    expect(rules[0].id).toBe('good');
  });

  it('user rules override builtins of the same id', () => {
    writeFileSync(path.join(pkgBuiltinDir, 'r.yaml'), `
schemaVersion: 1
id: shared-id
description: builtin
priority: 50
when:
  - kind: noRecentRuns
then:
  - kind: setModel
    model: builtin-model
`);
    const userDir = path.join(baseDir, 'advisor-rules', 'user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, 'override.yaml'), `
schemaVersion: 1
id: shared-id
description: user override
priority: 50
when:
  - kind: noRecentRuns
then:
  - kind: setModel
    model: user-model
`);
    const rules = loadAdvisorRules({ baseDir, pkgBuiltinDir });
    expect(rules.length).toBe(1);
    expect(rules[0].description).toBe('user override');
  });

  it('syncs builtins to ~/.clementine/advisor-rules/builtin/ for transparency', () => {
    writeFileSync(path.join(pkgBuiltinDir, 'r.yaml'), `
schemaVersion: 1
id: r
description: x
priority: 10
when:
  - kind: noRecentRuns
then:
  - kind: setModel
    model: x
`);
    loadAdvisorRules({ baseDir, pkgBuiltinDir });
    const synced = path.join(baseDir, 'advisor-rules', 'builtin', 'r.yaml');
    // confirm it exists (loadAdvisorRules sync pass should write it)
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(synced)).toBe(true);
  });
});

describe('advisor rules loader — real builtin set', () => {
  let baseDir: string;

  beforeEach(() => {
    _resetLoaderState();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-rules-real-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('loads all shipped builtin rules without errors', () => {
    // Use the default pkgBuiltinDir resolution (src/ in dev, dist/ in prod)
    const rules = loadAdvisorRules({ baseDir });
    // We ship at least 12 builtin rules (see src/agent/advisor-rules/builtin/)
    expect(rules.length).toBeGreaterThanOrEqual(12);
    // Confirm priorities are sane and ordered
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i].priority).toBeGreaterThanOrEqual(rules[i - 1].priority);
    }
    // Confirm the today-bug-relevant rule exists
    const turnLimitRule = rules.find(r => r.id === 'turn-limit-hits');
    expect(turnLimitRule).toBeDefined();
    expect(turnLimitRule?.appliesTo?.jobMode).toBe('standard');
  });
});
