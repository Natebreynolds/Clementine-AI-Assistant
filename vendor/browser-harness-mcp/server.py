#!/usr/bin/env python3
"""
Clementine ↔ browser-harness MCP bridge (Phase 1.5).

Stdio MCP server that exposes browser-harness primitives to the Claude Agent
SDK. Wraps `browser_harness.helpers` (CDP control) and `browser_harness.admin`
(daemon lifecycle).

Fails gracefully: if browser-harness or its deps aren't installed, the server
still starts and every tool returns a clear "not installed" message so the
rest of Clementine keeps working.

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

import base64
import io
import os
import sys
import textwrap
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

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
_HELPERS: Any = None
_ADMIN: Any = None

try:
    if (HARNESS_HOME / "src").is_dir():
        sys.path.insert(0, str(HARNESS_HOME / "src"))
    from browser_harness import helpers as _HELPERS  # type: ignore
    from browser_harness import admin as _ADMIN  # type: ignore
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
_DAEMON_READY = False


def _ensure_ready() -> str | None:
    """Returns an error string if the harness isn't usable, None when ready.

    Calls ensure_daemon() lazily so the daemon doesn't spin up unless a tool
    is actually invoked (and so Chrome doesn't get prodded just from MCP
    handshake).
    """
    global _DAEMON_READY
    if not _HARNESS_AVAILABLE:
        return (
            "browser-harness is not installed. Run `clementine browser install` "
            "to clone the harness into ~/.clementine/browser-harness and install "
            f"Python dependencies. (Underlying: {_HARNESS_ERROR})"
        )
    if _DAEMON_READY:
        return None
    try:
        # ensure_daemon is idempotent and self-heals stale daemons / cold Chrome
        _ADMIN.ensure_daemon(_open_inspect=False)
        _DAEMON_READY = True
        return None
    except Exception as e:  # noqa: BLE001
        return (
            f"Could not connect to Chrome via CDP at {CDP_URL}.\n"
            f"  Reason: {type(e).__name__}: {e}\n"
            f"  Fix: run `clementine browser connect` to relaunch Chrome with "
            f"--remote-debugging-port=9222."
        )


def _format_result(value: Any) -> str:
    """Turn helper return values into human/agent-readable text."""
    if value is None:
        return "ok"
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, (dict, list, tuple)):
        try:
            import json
            return json.dumps(value, default=str, indent=2)
        except Exception:  # noqa: BLE001
            return repr(value)
    return repr(value)


@server.tool()
def browser_status() -> str:
    """Diagnostic: install state, CDP target, daemon liveness, current page."""
    parts = [
        f"harness_installed: {_HARNESS_AVAILABLE}",
        f"harness_home: {HARNESS_HOME}",
        f"cdp_url: {CDP_URL}",
    ]
    if not _HARNESS_AVAILABLE:
        if _HARNESS_ERROR:
            parts.append(f"error: {_HARNESS_ERROR}")
        return "\n".join(parts)

    try:
        alive = _ADMIN.daemon_alive()
        parts.append(f"daemon_alive: {alive}")
    except Exception as e:  # noqa: BLE001
        parts.append(f"daemon_check_error: {type(e).__name__}: {e}")

    err = _ensure_ready()
    if err:
        parts.append(f"daemon_ready: false")
        parts.append(f"reason: {err}")
        return "\n".join(parts)

    try:
        info = _HELPERS.page_info()
        parts.append(f"daemon_ready: true")
        parts.append(f"current_page: {_format_result(info)}")
    except Exception as e:  # noqa: BLE001
        parts.append(f"page_info_error: {type(e).__name__}: {e}")

    return "\n".join(parts)


@server.tool()
def browser_navigate(url: str, new_tab: bool = True) -> str:
    """Navigate to a URL.

    By default opens a new tab so the user's current tab isn't clobbered. Set
    new_tab=False to navigate the active tab in place.
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        if new_tab:
            _HELPERS.new_tab(url)
        else:
            _HELPERS.goto_url(url)
        _HELPERS.wait_for_load(timeout=15.0)
        info = _HELPERS.page_info()
        return f"Navigated to {url}\n{_format_result(info)}"
    except Exception as e:  # noqa: BLE001
        return f"Navigation failed: {type(e).__name__}: {e}"


@server.tool()
def browser_screenshot(full_page: bool = False, max_dim: int | None = 1600) -> str:
    """Capture a screenshot of the active tab and return it as a base64 PNG.

    full_page=True captures beyond the viewport. max_dim downscales the longest
    edge to keep the response small (default 1600px).
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        # capture_screenshot returns bytes when path=None
        png_bytes = _HELPERS.capture_screenshot(path=None, full=full_page, max_dim=max_dim)
        if isinstance(png_bytes, bytes):
            b64 = base64.b64encode(png_bytes).decode("ascii")
            return f"data:image/png;base64,{b64}"
        # Fallback if helper returned a path
        return f"screenshot saved to: {png_bytes}"
    except Exception as e:  # noqa: BLE001
        return f"Screenshot failed: {type(e).__name__}: {e}"


@server.tool()
def browser_page_info() -> str:
    """Return current URL, title, and viewport info for the active tab."""
    err = _ensure_ready()
    if err:
        return err
    try:
        return _format_result(_HELPERS.page_info())
    except Exception as e:  # noqa: BLE001
        return f"page_info failed: {type(e).__name__}: {e}"


@server.tool()
def browser_list_tabs() -> str:
    """List all open browser tabs."""
    err = _ensure_ready()
    if err:
        return err
    try:
        return _format_result(_HELPERS.list_tabs(include_chrome=False))
    except Exception as e:  # noqa: BLE001
        return f"list_tabs failed: {type(e).__name__}: {e}"


@server.tool()
def browser_eval_js(expression: str) -> str:
    """Run a JavaScript expression in the active tab and return the result.

    Use for reading page state — e.g. document.querySelector('h1').textContent,
    or document.querySelectorAll('.item').length. Tier 2 (logged) — does not
    write to the page or click anything by itself, but the agent could read
    sensitive content.
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        return _format_result(_HELPERS.js(expression))
    except Exception as e:  # noqa: BLE001
        return f"js eval failed: {type(e).__name__}: {e}"


@server.tool()
def browser_click_xy(x: int, y: int, button: str = "left", clicks: int = 1) -> str:
    """Click at viewport coordinates (x, y). Tier 3 (autonomous-blocked).

    To click a specific element, use browser_eval_js to find its bounding box,
    then call this. Example JS to get center coords:
      const r = el.getBoundingClientRect();
      [r.left + r.width/2, r.top + r.height/2]
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        _HELPERS.click_at_xy(x, y, button=button, clicks=clicks)
        return f"clicked ({x}, {y}) {button} x{clicks}"
    except Exception as e:  # noqa: BLE001
        return f"click failed: {type(e).__name__}: {e}"


@server.tool()
def browser_type_text(text: str) -> str:
    """Type text into the focused input. Tier 3 (autonomous-blocked).

    Combine with browser_click_xy to click a field first. Use browser_press_key
    for special keys like Enter / Tab / Escape.
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        _HELPERS.type_text(text)
        return f"typed {len(text)} chars"
    except Exception as e:  # noqa: BLE001
        return f"type failed: {type(e).__name__}: {e}"


@server.tool()
def browser_press_key(key: str) -> str:
    """Press a single key in the focused element. Tier 3.

    Examples: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'a', 'A'.
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        _HELPERS.press_key(key)
        return f"pressed {key}"
    except Exception as e:  # noqa: BLE001
        return f"press_key failed: {type(e).__name__}: {e}"


@server.tool()
def browser_scroll(dy: int = -300, dx: int = 0, x: int | None = None, y: int | None = None) -> str:
    """Scroll the page. Negative dy scrolls down (counter-intuitive: dy is the
    delta the *content* moves, so dy=-300 moves the content up = scrolls down).

    x/y default to the viewport center.
    """
    err = _ensure_ready()
    if err:
        return err
    try:
        if x is None or y is None:
            info = _HELPERS.page_info() or {}
            vw = info.get("viewport", {}).get("width", 1280)
            vh = info.get("viewport", {}).get("height", 800)
            x = x if x is not None else int(vw // 2)
            y = y if y is not None else int(vh // 2)
        _HELPERS.scroll(x, y, dy=dy, dx=dx)
        return f"scrolled dy={dy} dx={dx} at ({x}, {y})"
    except Exception as e:  # noqa: BLE001
        return f"scroll failed: {type(e).__name__}: {e}"


@server.tool()
def browser_run_python(code: str) -> str:
    """Run Python in the harness context with helpers pre-imported. Tier 3.

    Escape hatch for anything the typed tools above don't cover. All helpers
    from browser_harness.helpers are in scope: goto_url, new_tab, page_info,
    list_tabs, current_tab, switch_tab, click_at_xy, type_text, press_key,
    scroll, capture_screenshot, js, wait, wait_for_load, dispatch_key,
    upload_file, etc.

    Captures stdout. Last expression value is returned if there's no print.
    """
    err = _ensure_ready()
    if err:
        return err

    # Dedent so the agent doesn't have to worry about leading whitespace
    code = textwrap.dedent(code)

    namespace: dict[str, Any] = {"__name__": "__harness_inline__"}
    # Pre-import every helper into the namespace
    for name in dir(_HELPERS):
        if not name.startswith("_"):
            namespace[name] = getattr(_HELPERS, name)

    out = io.StringIO()
    err_buf = io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(err_buf):
            # Compile as 'exec' so multi-line statements work; if it ends with a
            # bare expression, evaluate that and append the value to output.
            try:
                tree = compile(code, "<harness-inline>", "exec")
                exec(tree, namespace)  # noqa: S102
            except SyntaxError:
                # Maybe it's a single expression
                exec(compile(code, "<harness-inline>", "single"), namespace)  # noqa: S102
        captured = out.getvalue()
        captured_err = err_buf.getvalue()
        result_parts = []
        if captured:
            result_parts.append(captured.rstrip())
        if captured_err:
            result_parts.append(f"[stderr]\n{captured_err.rstrip()}")
        if not result_parts:
            result_parts.append("(no output)")
        return "\n".join(result_parts)
    except Exception:  # noqa: BLE001
        tb = traceback.format_exc()
        captured = out.getvalue()
        prefix = (captured.rstrip() + "\n") if captured else ""
        return f"{prefix}[exception]\n{tb}"


if __name__ == "__main__":
    # FastMCP handles stdio transport automatically.
    server.run()
