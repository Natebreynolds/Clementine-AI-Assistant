/**
 * 1.18.199 — pin the chat path's MCP server registration to fullSurface.
 *
 * Live failure on 2026-05-12 13:35:33: Ross was mid-conversation about
 * sending a market-leader outreach batch. Owner replied "sure". The chat
 * path called `buildExtraMcpForRunAgent({ scopeText: 'sure', ... })` —
 * `routeToolSurface('sure')` matched no MCPs, skill-resolver matched no
 * skills, result was an empty MCP server set for that turn. Ross then
 * said "DataForSEO isn't in scope for this session context" mid-task and
 * fell back to running `workflow list mcp tools` to figure out what he
 * even had access to.
 *
 * The fix: chat always uses fullSurface=true. The profile's allowlist
 * still bounds what each agent can see. The SDK's tool-search defers
 * individual schema loading. No more "tool vanished mid-conversation".
 *
 * This test pins the contract — if a future change re-introduces
 * per-message MCP scoping on the chat path, this test must fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock `buildExtraMcpForRunAgent` to capture the exact arguments the
// chat path passes to it. We don't care about the return value here;
// the assertion is on what the router *requested*.
const buildExtraMcpForRunAgentSpy = vi.fn(async () => ({
  servers: {},
  composioConnected: [] as string[],
  externalConnected: [] as string[],
  droppedClaudeAi: [] as string[],
  droppedComposio: [] as string[],
}));

vi.mock('../src/agent/run-agent-mcp.js', () => ({
  buildExtraMcpForRunAgent: buildExtraMcpForRunAgentSpy,
}));

describe('chat path MCP server registration (1.18.199)', () => {
  beforeEach(() => {
    buildExtraMcpForRunAgentSpy.mockClear();
  });

  it('module exports the expected shape', async () => {
    const mod = await import('../src/agent/run-agent-mcp.js');
    expect(mod.buildExtraMcpForRunAgent).toBe(buildExtraMcpForRunAgentSpy);
  });

  it('chat router source pins fullSurface=true (regression guard)', async () => {
    // Static-text guard: assert the router source calls
    // buildExtraMcpForRunAgent with `fullSurface: true` and does NOT
    // call it with `scopeText: originalText` (the regressed pattern).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const routerPath = path.resolve(__dirname, '..', 'src', 'gateway', 'router.ts');
    const src = await fs.readFile(routerPath, 'utf-8');

    // 1. Chat path should call buildExtraMcpForRunAgent with fullSurface: true.
    const chatCallRegex = /buildExtraMcpForRunAgent\(\{\s*fullSurface:\s*true/;
    expect(
      chatCallRegex.test(src),
      'router.ts chat path must call buildExtraMcpForRunAgent with `fullSurface: true`. ' +
      'Per-message scopeText routing causes tools to vanish on short user replies — see 1.18.199 commit message.',
    ).toBe(true);

    // 2. Chat path should NOT pass scopeText into the call. (Other callers
    //    may still pass scopeText — e.g. background tasks that legitimately
    //    want narrow scoping — but chat must not.)
    //    We assert the specific bug pattern is gone: scopeText: originalText.
    const buggyPattern = /buildExtraMcpForRunAgent\(\{\s*scopeText:\s*originalText/;
    expect(
      buggyPattern.test(src),
      'router.ts must NOT call buildExtraMcpForRunAgent with `scopeText: originalText` on the chat path. ' +
      'That was the 2026-05-12 regression that yanked dataforseo mid-conversation when the owner ' +
      'replied "sure".',
    ).toBe(false);

    // 3. The skill-resolver MCP widening (skillHintedMcpServers) should
    //    no longer be passed on the chat path. It's still defined in
    //    run-agent-mcp.ts for other callers, but chat shouldn't use it.
    //    Check inside the chat-specific buildExtraMcpForRunAgent call.
    const chatCallBlock = src.match(/const chatMcp = isBuilderSession[\s\S]*?\}\);/);
    expect(chatCallBlock, 'chat MCP call block should exist in router.ts').toBeTruthy();
    if (chatCallBlock) {
      expect(
        chatCallBlock[0],
        'chat path must not pass `skillHintedMcpServers` — that hint mechanism is for other callers.',
      ).not.toMatch(/skillHintedMcpServers/);
    }
  });
});
