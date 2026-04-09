#!/usr/bin/env bash
set -euo pipefail

# ── Clementine Installer ─────────────────────────────────────────────
# One-command install: system deps, npm packages, build, CLI, setup.
# Safe to re-run — skips anything already installed.
# ──────────────────────────────────────────────────────────────────────

# ── Colors ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

STEP=0
WARNINGS=0

# ── Helpers ───────────────────────────────────────────────────────────
step()  { STEP=$((STEP + 1)); echo -e "\n  ${BOLD}[${STEP}] $1${RESET}"; }
ok()    { echo -e "    ${GREEN}OK${RESET}  $1"; }
warn()  { echo -e "    ${YELLOW}WARN${RESET}  $1"; WARNINGS=$((WARNINGS + 1)); }
fail()  { echo -e "    ${RED}FAIL${RESET}  $1"; echo; exit 1; }
info()  { echo -e "    ${DIM}$1${RESET}"; }
run()   { echo -e "    ${CYAN}Running:${RESET} $1"; eval "$1"; }

command_exists() { command -v "$1" &>/dev/null; }

# ── Cleanup trap ──────────────────────────────────────────────────────
trap 'if [ $? -ne 0 ]; then echo -e "\n  ${RED}Installation failed.${RESET} Check the output above for details.\n"; fi' EXIT

# ── Banner ────────────────────────────────────────────────────────────
echo
echo -e "${CYAN}"
cat << 'BANNER'
 ██████╗██╗     ███████╗███╗   ███╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗
██╔════╝██║     ██╔════╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝
██║     ██║     █████╗  ██╔████╔██║█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗
██║     ██║     ██╔══╝  ██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝
╚██████╗███████╗███████╗██║ ╚═╝ ██║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗
 ╚═════╝╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝
BANNER
echo -e "${RESET}"

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo -e "  ${BOLD}Installer${RESET}  ${DIM}v${VERSION}${RESET}"

# ── Platform detection ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
HAS_BREW=false
HAS_APT=false
MISSING_BREW=false

case "$OS" in
  Darwin)
    OS="darwin"
    echo -e "  ${DIM}Platform: macOS (${ARCH})${RESET}"
    if command_exists brew; then
      HAS_BREW=true
    else
      MISSING_BREW=true
    fi
    ;;
  Linux)
    OS="linux"
    echo -e "  ${DIM}Platform: Linux (${ARCH})${RESET}"
    if command_exists apt-get; then
      HAS_APT=true
    fi
    ;;
  *)
    echo -e "\n  ${RED}Unsupported platform: ${OS}${RESET}"
    echo -e "  Clementine supports macOS and Linux (apt-based)."
    exit 1
    ;;
esac

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Pre-flight checks
# ══════════════════════════════════════════════════════════════════════
step "Checking prerequisites"

# Node.js
if command_exists node; then
  NODE_VERSION=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ] && [ "$NODE_MAJOR" -le 24 ]; then
    ok "Node.js ${NODE_VERSION}"
  else
    fail "Node.js ${NODE_VERSION} — need v20-24 LTS.
         Switch version:  nvm install 22 && nvm use 22
         Then re-run:     bash install.sh"
  fi
else
  fail "Node.js not found. Clementine requires Node.js 20-24 LTS.
       Install via nvm:
         curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
         nvm install 22
       Then re-run: bash install.sh"
fi

# npm
if command_exists npm; then
  ok "npm $(npm --version)"
else
  fail "npm not found. Should be bundled with Node.js — check your Node installation."
fi

# Git repo
if [ -d ".git" ]; then
  ok "Git repository detected"
else
  fail "Not a git repository. Clone first:
       git clone https://github.com/Natebreynolds/Clementine-AI-Assistant.git clementine
       cd clementine && bash install.sh"
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 2: System dependencies
# ══════════════════════════════════════════════════════════════════════
step "Installing system dependencies"

if [ "$MISSING_BREW" = true ]; then
  warn "Homebrew not found. Some dependencies may need manual install."
  info "Install Homebrew: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
fi

# ── Build tools ───────────────────────────────────────────────────────
if [ "$OS" = "darwin" ]; then
  if xcode-select -p &>/dev/null; then
    ok "Xcode Command Line Tools"
  else
    info "Installing Xcode Command Line Tools (a dialog may appear)..."
    xcode-select --install 2>/dev/null || true
    echo -e "    ${YELLOW}Waiting for Xcode CLT installation to complete...${RESET}"
    until xcode-select -p &>/dev/null; do
      sleep 5
    done
    ok "Xcode Command Line Tools installed"
  fi
elif [ "$OS" = "linux" ]; then
  NEED_BUILD=false
  if ! command_exists gcc; then NEED_BUILD=true; fi
  if ! command_exists make; then NEED_BUILD=true; fi

  if [ "$NEED_BUILD" = true ]; then
    if [ "$HAS_APT" = true ]; then
      info "Installing build-essential and python3..."
      sudo apt-get update -qq
      sudo apt-get install -y -qq build-essential python3
      ok "Build tools installed"
    else
      warn "gcc/make not found and no apt-get available. Install build tools manually."
    fi
  else
    ok "Build tools (gcc, make)"
  fi

  # Python3 (node-gyp needs it)
  if command_exists python3; then
    ok "python3"
  elif [ "$HAS_APT" = true ]; then
    sudo apt-get install -y -qq python3
    ok "python3 installed"
  else
    warn "python3 not found. Native modules may fail to compile."
  fi
fi

# ── redis-server ──────────────────────────────────────────────────────
if command_exists redis-server; then
  ok "redis-server (knowledge graph)"
else
  if [ "$HAS_BREW" = true ]; then
    info "Installing redis..."
    HOMEBREW_NO_AUTO_UPDATE=1 brew install redis 2>/dev/null
    ok "redis-server installed"
  elif [ "$HAS_APT" = true ]; then
    info "Installing redis-server..."
    sudo apt-get install -y -qq redis-server
    ok "redis-server installed"
  else
    warn "redis-server not found (needed for knowledge graph, not core chat).
         Install manually: brew install redis (macOS) or apt install redis-server (Linux)"
  fi
fi

# ── libomp (OpenMP runtime for FalkorDB) ──────────────────────────────
LIBOMP_FOUND=false
if [ "$OS" = "darwin" ]; then
  for p in /opt/homebrew/opt/libomp/lib/libomp.dylib /usr/local/opt/libomp/lib/libomp.dylib; do
    [ -f "$p" ] && LIBOMP_FOUND=true && break
  done
elif [ "$OS" = "linux" ]; then
  for p in /usr/lib/libomp.so /usr/lib/x86_64-linux-gnu/libomp.so; do
    [ -f "$p" ] && LIBOMP_FOUND=true && break
  done
fi

if [ "$LIBOMP_FOUND" = true ]; then
  ok "libomp (OpenMP runtime)"
else
  if [ "$HAS_BREW" = true ]; then
    info "Installing libomp..."
    HOMEBREW_NO_AUTO_UPDATE=1 brew install libomp 2>/dev/null
    ok "libomp installed"
  elif [ "$HAS_APT" = true ]; then
    info "Installing libomp-dev..."
    sudo apt-get install -y -qq libomp-dev
    ok "libomp installed"
  else
    warn "libomp not found (needed for knowledge graph, not core chat).
         Install manually: brew install libomp (macOS) or apt install libomp-dev (Linux)"
  fi
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 3: npm install
# ══════════════════════════════════════════════════════════════════════
step "Installing npm packages"

if ! npm install --loglevel=error --no-audit 2>&1; then
  fail "npm install failed. Check the output above.
       Common fixes:
         - Rebuild native modules: npm rebuild better-sqlite3
         - Missing build tools: xcode-select --install (macOS) or apt install build-essential (Linux)
         - Clear cache: rm -rf node_modules && npm install"
fi
ok "npm install complete"

# ══════════════════════════════════════════════════════════════════════
# Phase 4: Build TypeScript
# ══════════════════════════════════════════════════════════════════════
step "Building TypeScript"

if ! npm run build 2>&1; then
  fail "Build failed. Try: rm -rf dist && npm run build"
fi
ok "Build complete"

# ══════════════════════════════════════════════════════════════════════
# Phase 5: Install CLI globally
# ══════════════════════════════════════════════════════════════════════
step "Installing CLI globally"

if npm install -g . --loglevel=error --no-audit 2>/dev/null; then
  ok "clementine CLI installed"
elif sudo npm install -g . --loglevel=error --no-audit 2>/dev/null; then
  ok "clementine CLI installed (with sudo)"
else
  fail "Could not install CLI globally.
       Try: sudo npm install -g . --loglevel=error --no-audit"
fi

# Verify
if command_exists clementine; then
  ok "clementine command available"
else
  warn "clementine not found in PATH. You may need to restart your shell."
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 6: Post-install verification
# ══════════════════════════════════════════════════════════════════════
step "Running health checks"

# Claude CLI
if command_exists claude; then
  ok "Claude Code CLI found"
else
  warn "Claude Code CLI not found.
       Install:       npm install -g @anthropic-ai/claude-code
       Authenticate:  claude login
       Clementine needs this to run, but setup can proceed without it."
fi

# Doctor (catch anything we missed — FalkorDB binaries, etc.)
echo
clementine doctor --fix || true

# ══════════════════════════════════════════════════════════════════════
# Phase 7: Configuration
# ══════════════════════════════════════════════════════════════════════
CLEMENTINE_HOME="${CLEMENTINE_HOME:-$HOME/.clementine}"
ENV_FILE="${CLEMENTINE_HOME}/.env"

step "Configuration"

if [ -f "$ENV_FILE" ]; then
  ok "Configuration already exists (${ENV_FILE})"
  info "To reconfigure: clementine config setup"
elif [ -t 0 ]; then
  # Interactive terminal — launch setup wizard
  info "Launching setup wizard..."
  echo
  clementine config setup
else
  # Non-interactive (CI, piped input)
  warn "Non-interactive environment detected. Skipping setup wizard."
  info "Run manually: clementine config setup"
fi

# ══════════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════════
echo
echo -e "  ${GREEN}${BOLD}Installation complete!${RESET}"
if [ "$WARNINGS" -gt 0 ]; then
  echo -e "  ${YELLOW}${WARNINGS} warning(s) above — review before launching.${RESET}"
fi
echo
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "    clementine launch              ${DIM}Start the daemon${RESET}"
echo -e "    clementine launch --install    ${DIM}Auto-start on login (macOS)${RESET}"
echo -e "    clementine dashboard           ${DIM}Open the web command center${RESET}"
echo -e "    clementine doctor              ${DIM}Verify everything is healthy${RESET}"
echo
