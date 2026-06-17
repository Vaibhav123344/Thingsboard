#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS="${ROOT}/logs/zephyr.pids"

echo "Stopping Zephyr..."

# Stop host processes
if [[ -f "${PIDS}" ]]; then
  while IFS=" " read -r pid name; do
    kill -0 "$pid" 2>/dev/null && kill "$pid" && echo "  Stopped ${name} [${pid}]"
  done < "${PIDS}"
  rm -f "${PIDS}"
fi

# Stop Docker containers
cd "${ROOT}"
docker compose stop livekit-server stt-service tts-service
echo "  Stopped Docker containers"
echo "Done."