#!/usr/bin/env bash
# Starts the traffic light at login on Linux desktops (GNOME, KDE, XFCE...).
set -e
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/ai-traffic-light.desktop"
sed "s|^Exec=.*|Exec=node $(dirname "$here")/src/cli.js start|" "$here/aitl.desktop" > "$target"
echo "installed $target"
