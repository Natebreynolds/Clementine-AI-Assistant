#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env.signing"
load_env_file "$ROOT_DIR/.env.release"
load_env_file "$HOME/.clementine/signing.env"

if [[ -n "${APPLE_ID_PASSWORD:-}" && -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_ID_PASSWORD"
fi

if [[ -n "${CLEMENTINE_NOTARY_PROFILE:-}" && -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  export APPLE_KEYCHAIN_PROFILE="$CLEMENTINE_NOTARY_PROFILE"
fi

has_password_creds=false
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  has_password_creds=true
fi

has_api_key_creds=false
if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  has_api_key_creds=true
fi

has_keychain_profile=false
if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  has_keychain_profile=true
fi

if [[ "$has_password_creds" != true && "$has_api_key_creds" != true && "$has_keychain_profile" != true ]]; then
  cat >&2 <<'EOF'
No Apple notarization credentials were detected, so the release DMG would be signed but not notarized.

Set one of these before running npm run desktop:dist:
  - APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
  - APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
  - APPLE_KEYCHAIN_PROFILE

This script also accepts:
  - APPLE_ID_PASSWORD as an alias for APPLE_APP_SPECIFIC_PASSWORD
  - CLEMENTINE_NOTARY_PROFILE as an alias for APPLE_KEYCHAIN_PROFILE

One-time local keychain setup:
  xcrun notarytool store-credentials clementine --apple-id <apple-id> --team-id 4AR3Y8XD72 --sync
  CLEMENTINE_NOTARY_PROFILE=clementine npm run desktop:dist

For a local signed-but-unnotarized test build:
  npm run desktop:dist:unnotarized
EOF
  if [[ "${CLEMENTINE_ALLOW_UNNOTARIZED:-}" != "1" ]]; then
    exit 1
  fi
fi

npm run desktop:prepare
"$ROOT_DIR/node_modules/.bin/electron-builder" --mac
