#!/bin/bash
set -euo pipefail
umask 077
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
printf '%s\n' 'One-time IITB login setup. The ongoing monitor runs in Google Apps Script.'
printf '%s\n' 'Enter IITB credentials and phone OTP only in the official IITB browser window.'
runtime_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [[ -x "$runtime_node" ]]; then
  node_bin="$runtime_node"
else
  node_bin="$(command -v node || true)"
fi
if [[ -z "$node_bin" ]] || ! "$node_bin" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 22 or newer, then reopen this launcher.'
  read -r -p 'Press Return to close. ' || true
  exit 1
fi
export PATH="$(dirname "$node_bin"):$PATH"
if [[ ! -f node_modules/playwright/cli.js ]]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
"$node_bin" node_modules/playwright/cli.js install chromium
"$node_bin" login/server.mjs --local &
helper_pid=$!
cleanup() { kill "$helper_pid" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
ready=false
for attempt in {1..40}; do
  if ! kill -0 "$helper_pid" >/dev/null 2>&1; then break; fi
  if /usr/sbin/lsof -a -p "$helper_pid" -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1 && curl --fail --silent --max-time 1 http://127.0.0.1:3000/ >/dev/null; then ready=true; break; fi
  sleep 0.25
done
if [[ "$ready" == true ]]; then
  open http://127.0.0.1:3000/
  wait "$helper_pid" || true
else
  printf '%s\n' 'Setup could not start. Close any earlier setup window and try again.'
fi
read -r -p 'Press Return to close. ' || true
