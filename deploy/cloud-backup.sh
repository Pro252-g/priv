#!/bin/sh
set -eu
umask 077
backup_id=${IEP_BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}
case "$backup_id" in ''|*[!A-Za-z0-9_-]*) echo 'Invalid backup ID' >&2; exit 1;; esac
if ! mkdir /backups/.lock 2>/dev/null; then echo 'Another backup may be running; review /backups/.lock' >&2; exit 1; fi
trap 'rmdir /backups/.lock' EXIT
node /app/scripts/backup-data.mjs --output "/backups/$backup_id"
node /app/scripts/backup-data.mjs --verify "/backups/$backup_id"
printf 'Verified backup: /backups/%s\n' "$backup_id"
