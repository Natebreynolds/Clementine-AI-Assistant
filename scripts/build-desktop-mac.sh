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

notarytool_args=()
if [[ "$has_password_creds" == true ]]; then
  notarytool_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
elif [[ "$has_api_key_creds" == true ]]; then
  notarytool_args=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [[ "$has_keychain_profile" == true ]]; then
  notarytool_args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  if [[ -n "${APPLE_KEYCHAIN:-}" ]]; then
    notarytool_args=(--keychain "$APPLE_KEYCHAIN" "${notarytool_args[@]}")
  fi
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

if [[ ${#notarytool_args[@]} -gt 0 ]]; then
  package_version="$(node -p "require('./package.json').version")"
  shopt -s nullglob
  dmg_files=("$ROOT_DIR"/release/Clementine-"$package_version"-mac-*.dmg)
  shopt -u nullglob

  for dmg_file in "${dmg_files[@]}"; do
    echo "Notarizing DMG wrapper: $(basename "$dmg_file")"
    xcrun notarytool submit "$dmg_file" --wait "${notarytool_args[@]}"
    xcrun stapler staple "$dmg_file"
    xcrun stapler validate "$dmg_file"

    case "$(uname -m)" in
      arm64) app_builder="$ROOT_DIR/node_modules/app-builder-bin/mac/app-builder_arm64" ;;
      x86_64) app_builder="$ROOT_DIR/node_modules/app-builder-bin/mac/app-builder_amd64" ;;
      *) app_builder="" ;;
    esac
    if [[ -n "$app_builder" && -x "$app_builder" ]]; then
      "$app_builder" blockmap --input "$dmg_file" --output "$dmg_file.blockmap"
    fi

    if [[ -f "$ROOT_DIR/release/latest-mac.yml" ]]; then
      node --input-type=module - "$dmg_file" "$ROOT_DIR/release/latest-mac.yml" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [dmgPath, latestPath] = process.argv.slice(2);
const url = basename(dmgPath);
const sha512 = createHash('sha512').update(readFileSync(dmgPath)).digest('base64');
const size = statSync(dmgPath).size;
const lines = readFileSync(latestPath, 'utf8').split(/\r?\n/);

for (let index = 0; index < lines.length; index++) {
  if (lines[index].trim() === `- url: ${url}`) {
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (/^\S/.test(lines[cursor]) || /^\s*-\s+url:/.test(lines[cursor])) break;
      if (lines[cursor].trim().startsWith('sha512:')) lines[cursor] = `    sha512: ${sha512}`;
      if (lines[cursor].trim().startsWith('size:')) lines[cursor] = `    size: ${size}`;
    }
    break;
  }
}

writeFileSync(latestPath, `${lines.join('\n').replace(/\n*$/, '')}\n`);
NODE
    fi
  done
fi
