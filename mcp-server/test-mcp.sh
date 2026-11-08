#!/usr/bin/env bash
# Minimal smoke test: send MCP initialize + tools/list via stdio.
set -euo pipefail

cd "$(dirname "$0")"
source ../.dev.vars

(
cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
sleep 2
) | CLIENT_PRIVATE_KEY=$CLIENT_PRIVATE_KEY timeout 8 ./node_modules/.bin/tsx src/index.ts 2>/dev/null | head -20
