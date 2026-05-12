import { describe, expect, it } from 'vitest';
import { classifyToolCall, isToolResultSuccessful } from '../src/agent/side-effect-classifier.js';

describe('side-effect classifier', () => {
  it('classifies common read-only and mutating tools without provider assumptions', () => {
    expect(classifyToolCall('Read').kind).toBe('read_only');
    expect(classifyToolCall('TodoWrite').kind).toBe('read_only');
    expect(classifyToolCall('Write').kind).toBe('side_effect');
    expect(classifyToolCall('mcp__dataforseo__search_keywords').kind).toBe('read_only');
    expect(classifyToolCall('mcp__gmail__GMAIL_SEND_EMAIL').kind).toBe('side_effect');
    expect(classifyToolCall('mcp__salesforce__UPDATE_RECORD').kind).toBe('side_effect');
  });

  it('keeps unknown Bash in its own bucket', () => {
    expect(classifyToolCall('Bash', { command: 'ls -la' }).kind).toBe('read_only');
    expect(classifyToolCall('Bash', { command: 'sf data update record --sobject Contact --record-id 003x --values A=b' }).kind).toBe('side_effect');
    expect(classifyToolCall('Bash', { command: 'node scripts/custom-workflow.js' }).kind).toBe('unknown');
  });

  it('recognizes successful generic MCP result shapes', () => {
    expect(isToolResultSuccessful({ successful: true, error: null, data: { status_code: 202 } })).toMatchObject({
      successful: true,
      statusCode: 202,
    });
    expect(isToolResultSuccessful({ error: 'bad request', data: { status_code: 400 } })).toMatchObject({
      successful: false,
      error: 'bad request',
    });
    expect(isToolResultSuccessful({ successful: false })).toMatchObject({ successful: false });
    expect(isToolResultSuccessful('{"data":{"status_code":204},"error":null}')).toMatchObject({
      successful: true,
      statusCode: 204,
    });
  });
});
