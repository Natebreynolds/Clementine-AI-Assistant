#!/usr/bin/env python3
"""
Clementine ↔ browser-harness MCP bridge.

Stdio MCP server that exposes browser-harness primitives to the Claude Agent
SDK. Fails gracefully: if browser-harness or its deps aren't installed, the
server still starts and every tool returns a clear "not installed" message
so the rest of Clementine keeps working.

Wire-up:
  mcpServers in ~/.clementine/mcp-servers.json:
    {
      "browser-harness": {
        "type": "stdio",
        "command": "<venv>/bin/python3",
        "args": ["<package>/vendor/browser-harness-mcp/server.py"],
        "env": {
          "BROWSER_HARNESS_HOME": "~/.clementine/browser-harness",
          "BROWSER_CDP_URL": "ws://localhost:9222"
        }
      }
    }

Run `clementine browser install` and `clementine browser enable` to set up.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Best-effort: load browser-harness from the user's data home.
HARNESS_HOME = Path(
    os.environ.get(
        "BROWSER_HARNESS_HOME",
        Path.home() / ".clementine" / "browser-harness",
    )
).expanduser()

CDP_URL = os.environ.get("BROWSER_CDP_URL", "ws://localhost:9222")

_HARNESS_AVAILABLE = False
_HARNESS_ERROR: str | None = None

try:
    if (HARNESS_HOME / "src").is_dir():
        sys.path.insert(0, str(HARNESS_HOME / "src"))
    # The actual harness module — import is lazy to keep startup cheap.
    import browser_harness  # type: ignore  # noqa: F401
    _HARNESS_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    _HARNESS_ERROR = f"{type(e).__name__}: {e}"

try:
    from mcp.server.fastmcp import FastMCP
except Exception as e:  # noqa: BLE001
    sys.stderr.write(
        "browser-harness MCP: 'mcp' package not installed. "
        "Run `clementine browser install` to set up.\n"
        f"Underlying error: {e}\n"
    )
    sys.exit(1)


server = FastMCP("browser-harness")


def _not_ready_message() -> str:
    if _HARNESS_AVAILABLE:
        return ""
    return (
        "browser-harness is not installed. Run `clementine browser install` "
        "to clone the harness into ~/.clementine/browser-harness and install "
        f"Python dependencies. (Underlying: {_HARNESS_ERROR})"
    )


@server.tool()
def browser_status() -> str:
    """Report whether browser-harness is installed and the CDP target it's pointed at."""
    parts = [
        f"harness_installed: {_HARNESS_AVAILABLE}",
        f"harness_home: {HARNESS_HOME}",
        f"cdp_url: {CDP_URL}",
    ]
    if not _HARNESS_AVAILABLE and _HARNESS_ERROR:
        parts.append(f"error: {_HARNESS_ERROR}")
    return "\n".join(parts)


@server.tool()
def browser_navigate(url: str) -> str:
    """Open a URL in the connected Chrome via CDP. Tier 2 (logged)."""
    msg = _not_ready_message()
    if msg:
        return msg
    # TODO: implement via browser_harness CDP helpers
    return f"[stub] would navigate to {url} via {CDP_URL}"


@server.tool()
def browser_screenshot() -> str:
    """Capture a screenshot of the active tab and return its file path. Tier 1."""
    msg = _not_ready_message()
    if msg:
        return msg
    # TODO: implement via browser_harness CDP helpers
    return f"[stub] would screenshot active tab via {CDP_URL}"


@server.tool()
def browser_inspect(selector: str = "body") -> str:
    """Read the current page HTML or a specific selector. Tier 1 (read-only)."""
    msg = _not_ready_message()
    if msg:
        return msg
    # TODO: implement via browser_harness CDP helpers
    return f"[stub] would inspect '{selector}' via {CDP_URL}"


@server.tool()
def browser_run_python(code: str) -> str:
    """Run Python in the harness workspace. Tier 3 (autonomous-blocked, requires approval)."""
    msg = _not_ready_message()
    if msg:
        return msg
    # TODO: thread through agent-workspace/agent_helpers.py — see SKILL.md
    return f"[stub] would run python ({len(code)} bytes) in {HARNESS_HOME}/agent-workspace"


if __name__ == "__main__":
    # FastMCP handles stdio transport automatically.
    server.run()
