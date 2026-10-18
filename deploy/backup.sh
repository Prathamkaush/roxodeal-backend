#!/usr/bin/env bash
set -euo pipefail
# Configure a protected environment file; never commit database or backup credentials.
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OFFSERVER_TARGET:?Set an SSH rsync target such as backup@host:/backups/mandisetu/}"
backup_dir="${BACKUP_DIR:-/srv/mandisetu/backups}"
upload_dir="${UPLOAD_DIR:-/srv/mandisetu/uploads}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$backup_dir"
pg_dump --format=custom --file="$backup_dir/db-$timestamp.dump" "$DATABASE_URL"
tar -czf "$backup_dir/files-$timestamp.tar.gz" -C "$upload_dir" .
rsync -az -e 'ssh -o BatchMode=yes' "$backup_dir/" "$OFFSERVER_TARGET"
# Configure retention and periodically test a restore before relying on backups.
