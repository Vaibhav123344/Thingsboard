#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="${SCRIPT_DIR}/build/bin/llama-server"
MODEL="${SCRIPT_DIR}/models/gpt-oss20b.gguf"

if [[ ! -f "$MODEL" ]]; then
  echo "ERROR: Model not found at $MODEL"
  exit 1
fi

echo "Starting llama-server on port 8080..."
exec "$BINARY" \
  --model      "$MODEL" \
  --port       8080 \
  --host       0.0.0.0 \
  --ctx-size   8192 \
  --n-gpu-layers 99 \
  --flash-attn   \
  --parallel   2 \
  --cont-batching \
  --log-disable