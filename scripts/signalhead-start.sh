#!/usr/bin/env bash
# Starts the traffic light in the background and detaches from this terminal.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nohup node "$root/src/cli.js" start >/dev/null 2>&1 &
disown
echo "traffic light started"
