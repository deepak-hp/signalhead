#!/usr/bin/env bash
# Runs the suite on Linux. Used to verify Linux support from a Windows box via
# WSL, and equally useful on a real Linux machine.
set -u

NODE="$(command -v node || true)"
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
fi
if [ -z "$NODE" ]; then
  echo "no node found on this Linux system" >&2
  exit 1
fi

echo "node    : $("$NODE" -v)"
echo "kernel  : $(uname -sr)"
echo "distro  : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/sig-linux-check"

# Copy out of /mnt so the run is on a native filesystem, and so Windows-built
# node_modules can never be picked up by accident.
rm -rf "$WORK"
mkdir -p "$WORK"
( cd "$SRC" && tar cf - src test scripts package.json ) | ( cd "$WORK" && tar xf - )

cd "$WORK"
echo "=== test suite ==="
"$NODE" --test
RC=$?

echo
echo "=== CLI smoke test ==="
"$NODE" src/cli.js start --no-overlay --port 4799 >/tmp/sig-linux.log 2>&1 &
SRV=$!
for _ in $(seq 1 20); do
  curl -sf http://127.0.0.1:4799/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf http://127.0.0.1:4799/health && echo
SIGNALHEAD_PORT=4799 "$NODE" src/cli.js set busy --agent linux --session smoke --detail "checking"
SIGNALHEAD_PORT=4799 "$NODE" src/cli.js fuel 55 --agent linux --session smoke --label "plan quota"
SIGNALHEAD_PORT=4799 "$NODE" src/cli.js status
SIGNALHEAD_PORT=4799 "$NODE" src/cli.js doctor | tail -n 20
SIGNALHEAD_PORT=4799 "$NODE" src/cli.js stop
kill $SRV 2>/dev/null

exit $RC
