#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:?Pass the GHCR backend image with an immutable sha256 digest}
[[ "$image" =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$ ]] || { echo "Invalid immutable image reference" >&2; exit 1; }
test -f .env.docker || { echo "Provision .env.docker on the VPS first" >&2; exit 1; }
# Do not commit release state until the new deployment passes readiness checks.
export BACKEND_IMAGE="$image"
compose=(docker compose --env-file .env.docker -f compose.yml -f compose.prod.yml)
"${compose[@]}" config --quiet
"${compose[@]}" pull backend migrate
"${compose[@]}" up -d --wait --wait-timeout 120 postgres redis
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 backend
umask 077
printf 'BACKEND_IMAGE=%s\n' "$image" > .env.release
echo "Backend deployment passed readiness checks."
