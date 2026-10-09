#!/bin/sh
# Run as root on an Ubuntu 24.04 edge host after placing the checkout at /opt/iep/app.
set -eu
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer with sudo on the edge host.' >&2; exit 1; fi
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$app_dir" != /opt/iep/app ]; then echo 'Install the checkout at /opt/iep/app (systemd unit uses this path).' >&2; exit 1; fi
if [ ! -f "$app_dir/edge/worker.py" ] || [ ! -f "$app_dir/edge/requirements.txt" ]; then echo 'Edge worker files are missing.' >&2; exit 1; fi
apt-get update
apt-get install -y python3 python3-venv python3-pip ffmpeg ca-certificates curl libglib2.0-0
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python >=3.11 required"'
if ! id iep-edge >/dev/null 2>&1; then adduser --system --group --home /var/lib/iep-edge --shell /usr/sbin/nologin iep-edge; fi
usermod -a -G video iep-edge
install -d -m 700 -o iep-edge -g iep-edge /var/lib/iep-edge
install -d -m 750 -o root -g iep-edge /etc/iep
# Do not overwrite private configuration. Keep code and the virtual environment root-owned.
python3 -m venv "$app_dir/edge/.venv"
"$app_dir/edge/.venv/bin/python" -m pip install -r "$app_dir/edge/requirements.txt"
install -m 644 "$app_dir/deploy/iep-edge@.service" /etc/systemd/system/iep-edge@.service
systemctl daemon-reload
printf 'Runtime installed. Configure private edge-INSTANCE.json/env, run check, then enable iep-edge@INSTANCE.\n'
