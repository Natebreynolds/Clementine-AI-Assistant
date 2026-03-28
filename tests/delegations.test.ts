import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), 'clem-test-del-' + Date.now());
const AGENTS_BASE = path.join(TEST_DIR, 'agents');

// Replicate readAllDelegations logic for testing
function readAllDelegations(agentsBase: string) {
  const all: Array<Record<string, unknown> & { _agentDir: string }> = [];
  if (!existsSync(agentsBase)) return all;
  for (const slug of readdirSync(agentsBase).filter(d => !d.startsWith('_') && statSync(path.join(agentsBase, d)).isDirectory())) {
    const delDir = path.join(agentsBase, slug, 'delegations');
    if (!existsSync(delDir)) continue;
    for (const f of readdirSync(delDir).filter(f => f.endsWith('.json'))) {
      try {
        const task = JSON.parse(readFileSync(path.join(delDir, f), 'utf-8'));
        all.push({ ...task, _agentDir: slug });
      } catch { continue; }
    }
  }
  return all;
}

beforeEach(() => {
  mkdirSync(AGENTS_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Delegation CRUD', () => {
  it('creates a delegation file in the target agent directory', () => {
    const toAgent = 'ross';
    const delDir = path.join(AGENTS_BASE, toAgent, 'delegations');
    mkdirSync(delDir, { recursive: true });

    const delegation = {
      id: 'del001',
      fromAgent: 'clementine',
      toAgent,
      task: 'Write outreach emails',
      expectedOutput: '5 personalized emails',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      goalId: 'goal123',
    };
    writeFileSync(path.join(delDir, `${delegation.id}.json`), JSON.stringify(delegation, null, 2));

    expect(existsSync(path.join(delDir, 'del001.json'))).toBe(true);
    const loaded = JSON.parse(readFileSync(path.join(delDir, 'del001.json'), 'utf-8'));
    expect(loaded.task).toBe('Write outreach emails');
    expect(loaded.goalId).toBe('goal123');
  });

  it('readAllDelegations scans all agent delegation directories', () => {
    // Create delegations for two agents
    const rossDir = path.join(AGENTS_BASE, 'ross', 'delegations');
    const sashaDir = path.join(AGENTS_BASE, 'sasha', 'delegations');
    mkdirSync(rossDir, { recursive: true });
    mkdirSync(sashaDir, { recursive: true });

    writeFileSync(path.join(rossDir, 'a.json'), JSON.stringify({ id: 'a', toAgent: 'ross', fromAgent: 'clementine', task: 'Task A', status: 'pending' }));
    writeFileSync(path.join(rossDir, 'b.json'), JSON.stringify({ id: 'b', toAgent: 'ross', fromAgent: 'sasha', task: 'Task B', status: 'completed' }));
    writeFileSync(path.join(sashaDir, 'c.json'), JSON.stringify({ id: 'c', toAgent: 'sasha', fromAgent: 'clementine', task: 'Task C', status: 'in_progress' }));

    const all = readAllDelegations(AGENTS_BASE);
    expect(all.length).toBe(3);

    const ids = all.map(d => d.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);

    // Filter by agent
    const rossOnly = all.filter(d => d.toAgent === 'ross');
    expect(rossOnly.length).toBe(2);
  });

  it('filters delegations by status', () => {
    const delDir = path.join(AGENTS_BASE, 'test-agent', 'delegations');
    mkdirSync(delDir, { recursive: true });

    writeFileSync(path.join(delDir, 'p.json'), JSON.stringify({ id: 'p', status: 'pending', toAgent: 'test-agent' }));
    writeFileSync(path.join(delDir, 'c.json'), JSON.stringify({ id: 'c', status: 'completed', toAgent: 'test-agent' }));
    writeFileSync(path.join(delDir, 'i.json'), JSON.stringify({ id: 'i', status: 'in_progress', toAgent: 'test-agent' }));

    const all = readAllDelegations(AGENTS_BASE);
    const pending = all.filter(d => d.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe('p');
  });

  it('handles empty or missing delegation directories gracefully', () => {
    // Agent dir with no delegations subdirectory
    mkdirSync(path.join(AGENTS_BASE, 'empty-agent'), { recursive: true });

    const all = readAllDelegations(AGENTS_BASE);
    expect(all.length).toBe(0);
  });

  it('handles malformed JSON files gracefully', () => {
    const delDir = path.join(AGENTS_BASE, 'bad-agent', 'delegations');
    mkdirSync(delDir, { recursive: true });

    writeFileSync(path.join(delDir, 'good.json'), JSON.stringify({ id: 'good', status: 'pending', toAgent: 'bad-agent' }));
    writeFileSync(path.join(delDir, 'bad.json'), 'not valid json{{{');

    const all = readAllDelegations(AGENTS_BASE);
    expect(all.length).toBe(1);
    expect(all[0].id).toBe('good');
  });
});
