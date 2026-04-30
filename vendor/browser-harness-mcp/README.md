# Browser Harness MCP Bridge

Stdio MCP server that wraps [browser-use/browser-harness](https://github.com/browser-use/browser-harness) so Clementine can drive your real Chrome via CDP.

**Status:** Phase 1 plumbing — tools return `[stub]` placeholders until the harness primitives are wired in.

## Setup

```bash
clementine browser install   # clone harness + install Python deps
clementine browser enable    # register MCP server in ~/.clementine/mcp-servers.json
clementine restart
```

To remove: `clementine browser disable` (the venv and harness clone are kept; delete `~/.clementine/browser-harness*` to fully remove).

## Tools

| Tool | Tier | Description |
|------|------|-------------|
| `browser_status` | 1 | Diagnostic: install state + CDP URL |
| `browser_screenshot` | 1 | Capture active tab |
| `browser_inspect` | 1 | Read page HTML or selector |
| `browser_navigate` | 2 | Open a URL in connected Chrome |
| `browser_run_python` | 3 | Execute Python in `agent-workspace/` (approval required) |

Tier policies are enforced by Clementine's `src/agent/hooks.ts`. Tier 3 actions require explicit approval and run only with a per-domain allowlist (Phase 2).
