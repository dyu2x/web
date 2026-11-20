#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Install Node.js 20+ and npm first." >&2
  exit 1
fi
npm install
printf '\nNow configure Worker secrets as documented in README.md, then run:\n  npm run deploy\n'
