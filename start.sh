#!/usr/bin/env sh
# Pass Live for Linux and macOS: run ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install version 22 or newer from https://nodejs.org (or your package manager), then run ./start.sh again."
  exit 1
fi
exec node server.js "$@"
