# Browser Harness MCP Bridge

Stdio MCP server that wraps [browser-use/browser-harness](https://github.com/browser-use/browser-harness) so Clementine can drive your real Chrome via CDP.

## Setup

```bash
clementine browser install   # clone harness + install Python deps
clementine browser enable    # register MCP server in ~/.clementine/mcp-servers.json
clementine browser connect   # quit Chrome and relaunch with --remote-debugging-port=9222
clementine restart
```

To remove: `clementine browser disable` (the venv and harness clone are kept; delete `~/.clementine/browser-harness*` to fully remove).

## Tools

| Tool | Tier | Description |
|------|------|-------------|
| `browser_status` | 1 | Diagnostic: install state, daemon liveness, current page |
| `browser_screenshot` | 1 | Capture active tab as base64 PNG |
| `browser_page_info` | 1 | Current URL, title, viewport |
| `browser_list_tabs` | 1 | Enumerate open tabs |
| `browser_eval_js` | 2 | Run a JavaScript expression and return result |
| `browser_navigate` | 2 | Open a URL (new tab by default) |
| `browser_click_xy` | 3 | Click at viewport coordinates |
| `browser_type_text` | 3 | Type into focused input |
| `browser_press_key` | 3 | Press Enter/Tab/Escape/etc. |
| `browser_scroll` | 3 | Scroll the page |
| `browser_run_python` | 3 | Execute Python in harness context (full helpers in scope) |

Tier policies are enforced by Clementine's `src/agent/hooks.ts`. Tier 3 actions require explicit approval and run only with a per-domain allowlist (Phase 2).
