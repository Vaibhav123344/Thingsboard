#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start_all.sh — Zephyr S2S Pipeline  (STT + TTS in Docker)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VA="${ROOT}/voice-agent"
LOGS="${ROOT}/logs"
VENV="${VA}/.venv/bin/activate"
PIDS="${LOGS}/zephyr.pids"

mkdir -p "${LOGS}"
> "${PIDS}"

log_pid() { echo "${1} ${2}" >> "${PIDS}"; echo "  ✓ ${2} [PID ${1}]"; }

wait_http() {
  local url=$1 label=$2
  echo -n "  Waiting for ${label} ..."
  for i in $(seq 1 40); do
    if curl -sf "${url}" > /dev/null 2>&1; then echo " ready"; return 0; fi
    sleep 2
  done
  echo " TIMEOUT"
  return 1
}

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Zephyr S2S — Starting All Services          ║"
echo "╚══════════════════════════════════════════════╝"
cd "${ROOT}"

# ── Step 1: Docker containers ─────────────────────────────────────────────────
echo ""
echo "▶  Step 1 — Docker: LiveKit + STT + TTS"
docker compose up -d livekit-server stt-service tts-service

wait_http "http://localhost:7880"          "LiveKit  :7880"
wait_http "http://localhost:8765/health"   "STT      :8765"
wait_http "http://localhost:8766/health"   "TTS      :8766"

# ── Step 2: llama.cpp LLM (host) ──────────────────────────────────────────────
echo ""
echo "▶  Step 2 — LLM server (llama.cpp on host GPU)"
"${ROOT}/llama/run_llama.sh" > "${LOGS}/llama.log" 2>&1 &
log_pid $! "llama-server"
wait_http "http://localhost:8080/health"   "LLM      :8080"

# ── Step 3: Filler pre-render (calls TTS container) ───────────────────────────
echo ""
echo "▶  Step 3 — Filler audio"
if [[ ! -f "${VA}/fillers/checking.wav" ]]; then
  echo "  Rendering filler clips..."
  cd "${VA}" && source "${VENV}"
  python filler_prerender.py
else
  echo "  Fillers already present, skipping"
fi

# ── Step 4: Node.js backend (host) ────────────────────────────────────────────
echo ""
echo "▶  Step 4 — Node.js backend :9005"
cd "${ROOT}"
npm run dev > "${LOGS}/node.log" 2>&1 &
log_pid $! "node-backend"
wait_http "http://localhost:9005/api/livekit/token?room=x&identity=hc" \
          "Node.js  :9005"

# ── Step 5: LiveKit Agent (host) ──────────────────────────────────────────────
echo ""
echo "▶  Step 5 — Zephyr LiveKit Agent"
cd "${VA}" && source "${VENV}"

LIVEKIT_URL=ws://localhost:7880 \
LIVEKIT_API_KEY=devkey \
LIVEKIT_API_SECRET=secretkeydefaultvalue987654321012 \
python agent.py start > "${LOGS}/agent.log" 2>&1 &
log_pid $! "zephyr-agent"
sleep 3

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  All services running                        ║"
echo "╠══════════════════════════════════════════════╣"
printf "║  %-20s  %-22s ║\n" "LiveKit (Docker)"  "ws://localhost:7880"
printf "║  %-20s  %-22s ║\n" "STT     (Docker)"  "http://localhost:8765"
printf "║  %-20s  %-22s ║\n" "TTS     (Docker)"  "http://localhost:8766"
printf "║  %-20s  %-22s ║\n" "LLM     (Host)"    "http://localhost:8080"
printf "║  %-20s  %-22s ║\n" "Node.js (Host)"    "http://localhost:9005"
printf "║  %-20s  %-22s ║\n" "Agent   (Host)"    "logs/agent.log"
echo "╠══════════════════════════════════════════════╣"
echo "║  Frontend → http://localhost:3000            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""