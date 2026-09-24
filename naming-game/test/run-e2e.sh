#!/usr/bin/env bash
# Starts the server with test hooks, runs the browser suite, stops the server.
set -e
cd "$(dirname "$0")/.."
PORT=${PORT:-3456}
NG_TEST_HOOKS=1 PORT=$PORT node src/server.js > /tmp/ng-server.log 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null" EXIT
for i in $(seq 1 50); do curl -s "http://localhost:$PORT/api/rooms" >/dev/null && break; sleep 0.1; done
python3 test/e2e.py "http://localhost:$PORT"
