# Zephyr — Local S2S + LiveKit: FINAL Guide (STT + TTS Containerised)

STT and TTS services now run as Docker containers. The LiveKit agent and
llama.cpp remain on the host for direct GPU access and lowest latency.

---

## What Runs Where

```
HOST MACHINE
├── llama/run_llama.sh      → llama.cpp  :8080  (direct GPU)
├── voice-agent/agent.py    → LiveKit Agent     (direct GPU for Silero VAD)
└── frontend/               → React Dev Server  :3000

DOCKER CONTAINERS
├── livekit-server   :7880 / :7881 / 50000-60000/udp
├── stt-service      :8765   (Faster-Whisper + CUDA)
├── tts-service      :8766   (Kokoro ONNX)
└── ... existing ThingsBoard / Postgres / etc.
```

---

## Quick Reference

| Service | Port | Location | GPU |
|---|---|---|---|
| LiveKit Server | 7880 / 7881 / 50k-60k UDP | Docker | — |
| STT (Faster-Whisper) | 8765 | Docker | ✓ CUDA 12.1 |
| TTS (Kokoro ONNX) | 8766 | Docker | Optional |
| LLM (llama.cpp) | 8080 | Host | ✓ CUDA |
| Node.js Backend | 9005 | Host | — |
| LiveKit Agent | — | Host Python | ✓ (Silero VAD) |

---

## 1. One-Time — Install NVIDIA Container Toolkit

Required so Docker containers can access your GPU.

```bash
# Add NVIDIA package repo
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit

# Wire it into the Docker runtime and restart
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify — should print your GPU name
docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi
```

---

## 2. Final Project Structure

```
project-root/
├── docker-compose.yml          ← UPDATED: adds stt-service + tts-service + volumes
├── livekit.yaml                ← unchanged
├── .env                        ← unchanged
│
├── voice-agent/
│   ├── Dockerfile.stt          ← NEW
│   ├── Dockerfile.tts          ← NEW
│   ├── requirements-stt.txt    ← NEW
│   ├── requirements-tts.txt    ← NEW
│   ├── requirements.txt        ← UPDATED (agent-only, no model libs)
│   ├── .dockerignore           ← NEW
│   │
│   ├── stt_service.py          ← UNCHANGED (same code, runs inside container)
│   ├── tts_service.py          ← UNCHANGED (same code, runs inside container)
│   ├── agent.py                ← UNCHANGED
│   ├── custom_tts.py           ← UNCHANGED
│   └── filler_prerender.py     ← UNCHANGED
│
├── src/
│   └── livekitRoutes.ts        ← UNCHANGED
├── llama/
│   └── run_llama.sh            ← UNCHANGED
└── scripts/
    ├── start_all.sh            ← UPDATED
    └── stop_all.sh             ← UPDATED
```

---

## 3. STT Container — Faster-Whisper

### `voice-agent/requirements-stt.txt`

```text
faster-whisper>=1.0.3
fastapi>=0.111.0
uvicorn[standard]>=0.30.0
python-multipart>=0.0.9
```

### `voice-agent/Dockerfile.stt`

```dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Zephyr STT Service — Faster-Whisper on CUDA 12.1
# Exposes: POST /v1/audio/transcriptions  (OpenAI-compatible)
# ─────────────────────────────────────────────────────────────────────────────
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

LABEL description="Zephyr STT: Faster-Whisper small.en on CUDA 12.1"

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
# CTranslate2 / Hugging Face model cache
ENV HF_HOME=/model-cache
ENV TRANSFORMERS_CACHE=/model-cache

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3-pip curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
 && update-alternatives --install /usr/bin/python  python  /usr/bin/python3.11 1

# ── Python deps ───────────────────────────────────────────────────────────────
WORKDIR /app
COPY requirements-stt.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements-stt.txt

# ── Bake Whisper model into image layer (CPU download; CUDA used at runtime) ──
RUN python -c "\
from faster_whisper import WhisperModel; \
print('Downloading small.en...'); \
WhisperModel('small.en', device='cpu', compute_type='int8'); \
print('Model ready.')"

# ── Service code ──────────────────────────────────────────────────────────────
COPY stt_service.py .

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8765/health || exit 1

CMD ["uvicorn", "stt_service:app", \
     "--host", "0.0.0.0", "--port", "8765", \
     "--workers", "1", "--log-level", "info"]
```

---

## 4. TTS Container — Kokoro ONNX

### `voice-agent/requirements-tts.txt`

```text
# Swap onnxruntime → onnxruntime-gpu to enable GPU inference for TTS
onnxruntime>=1.18.0
kokoro-onnx>=0.4.0
soundfile>=0.12.1
pydub>=0.25.1
numpy>=1.26.0
fastapi>=0.111.0
uvicorn[standard]>=0.30.0
pydantic>=2.7.0
```

### `voice-agent/Dockerfile.tts`

```dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Zephyr TTS Service — Kokoro-82M ONNX
# Exposes: POST /tts  (WAV) and  POST /v1/audio/speech  (OpenAI-compatible)
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

LABEL description="Zephyr TTS: Kokoro-82M ONNX"

ENV PYTHONUNBUFFERED=1

# ── System packages — ffmpeg is required by pydub for MP3 output ──────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Python deps ───────────────────────────────────────────────────────────────
WORKDIR /app
COPY requirements-tts.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements-tts.txt

# ── Bake Kokoro model into image layer ────────────────────────────────────────
RUN python -c "\
from kokoro_onnx import Kokoro; \
print('Downloading Kokoro model...'); \
Kokoro.from_pretrained(); \
print('Model ready.')"

# ── Service code ──────────────────────────────────────────────────────────────
COPY tts_service.py .

EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -sf http://localhost:8766/health || exit 1

CMD ["uvicorn", "tts_service:app", \
     "--host", "0.0.0.0", "--port", "8766", \
     "--workers", "1", "--log-level", "info"]
```

---

## 5. `voice-agent/.dockerignore`

Keeps the container build context lean — excludes the agent, venv, and local caches:

```dockerignore
.venv/
__pycache__/
*.pyc
.env
fillers/
agent.py
custom_tts.py
filler_prerender.py
requirements.txt
*.log
*.gguf
```

---

## 6. Updated `docker-compose.yml`

Add the two blocks below into your existing `services:` section, and merge the two new volume names into your existing `volumes:` block.

```yaml
services:

  # ─── existing services (livekit-server, postgres, thingsboard, etc.) ────────

  stt-service:
    build:
      context: ./voice-agent
      dockerfile: Dockerfile.stt
    image: zephyr-stt:latest
    restart: always
    ports:
      - "8765:8765"
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
    volumes:
      # Named volume keeps model files across container restarts
      - stt-model-cache:/model-cache
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    networks:
      - tb-network
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8765/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s

  tts-service:
    build:
      context: ./voice-agent
      dockerfile: Dockerfile.tts
    image: zephyr-tts:latest
    restart: always
    ports:
      - "8766:8766"
    volumes:
      - tts-model-cache:/model-cache
    networks:
      - tb-network
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8766/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

  # ─── To add GPU for TTS too, uncomment inside tts-service: ──────────────────
  # environment:
  #   - NVIDIA_VISIBLE_DEVICES=all
  # deploy:
  #   resources:
  #     reservations:
  #       devices:
  #         - driver: nvidia
  #           count: 1
  #           capabilities: [gpu]
  # Also swap onnxruntime → onnxruntime-gpu in requirements-tts.txt

volumes:
  stt-model-cache:
  tts-model-cache:
  # ... your existing volume names below
```

---

## 7. Updated `voice-agent/requirements.txt`

Host-side agent only — model libraries are no longer needed locally:

```text
# ── LiveKit agent framework ───────────────────────────────────────────────────
livekit-agents[openai,silero]>=0.11.0
livekit-plugins-openai>=0.10.0
livekit-plugins-silero>=0.6.0

# Silero VAD needs PyTorch on the host
torch>=2.2.0

# ── Async HTTP (tool calls + service health checks) ───────────────────────────
aiohttp>=3.9.5

# ── Audio frame slicing in custom_tts.py ─────────────────────────────────────
numpy>=1.26.0
soundfile>=0.12.1

# ── Utilities ─────────────────────────────────────────────────────────────────
python-dotenv>=1.0.1
```

```bash
cd voice-agent && source .venv/bin/activate
pip install -r requirements.txt
```

---

## 8. First-Time Image Build

Run once before the first `start_all.sh`. This downloads the CUDA base image,
installs packages, and bakes the Whisper and Kokoro models into the layers.

```bash
cd project-root

# Build both images in parallel
# STT:  ~8-12 min (CUDA base ~3 GB + Whisper model ~250 MB)
# TTS:  ~4-7  min (Python slim + Kokoro model ~300 MB)
docker compose build stt-service tts-service

# Check images exist
docker images | grep zephyr
#   zephyr-stt   latest   ...
#   zephyr-tts   latest   ...

# Quick smoke test
docker compose up -d stt-service tts-service
sleep 15   # wait for ONNX kernel warm-up

curl -s http://localhost:8765/health | python3 -m json.tool
# {"status": "ok", "device": "cuda", "model": "small.en"}

curl -s http://localhost:8766/health | python3 -m json.tool
# {"status": "ok", "engine": "kokoro-onnx"}

curl -s -X POST http://localhost:8766/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Zephyr online.","voice":"af_bella"}' \
  --output /tmp/smoke.wav && file /tmp/smoke.wav
# /tmp/smoke.wav: RIFF (little-endian) data, WAVE audio, Microsoft PCM ...

docker compose stop stt-service tts-service
```

---

## 9. Updated `scripts/start_all.sh`

```bash
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
```

---

## 10. Updated `scripts/stop_all.sh`

```bash
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
```

---

## 11. Day-to-Day Operations

```bash
# Normal start
./scripts/start_all.sh

# Normal stop
./scripts/stop_all.sh

# Rebuild only the STT image (e.g. changed Whisper model size)
docker compose build --no-cache stt-service
docker compose up -d --no-deps stt-service

# Rebuild only the TTS image (e.g. updated tts_service.py)
docker compose build tts-service
docker compose up -d --no-deps tts-service

# View live logs from containers
docker compose logs -f stt-service
docker compose logs -f tts-service
docker compose logs -f livekit-server

# View live agent log (host process)
tail -f logs/agent.log

# Upgrade Whisper model to medium for better accuracy
# 1. Edit Dockerfile.stt: change 'small.en' → 'medium.en'
# 2. Edit stt_service.py: WhisperModel("medium.en", ...)
# 3. docker compose build --no-cache stt-service
# 4. docker compose up -d --no-deps stt-service

# Enable GPU for TTS (optional speed boost)
# 1. Edit requirements-tts.txt: onnxruntime-gpu instead of onnxruntime
# 2. Uncomment GPU block in docker-compose.yml tts-service
# 3. docker compose build --no-cache tts-service
# 4. docker compose up -d --no-deps tts-service
```

---

## 12. Files That Did NOT Change

These are **identical** to the previous guide:

| File | Notes |
|---|---|
| `voice-agent/agent.py` | Calls `localhost:8765` and `localhost:8766` — same ports |
| `voice-agent/stt_service.py` | Same logic, now runs inside container |
| `voice-agent/tts_service.py` | Same logic, now runs inside container |
| `voice-agent/custom_tts.py` | Calls `localhost:8766/tts` — same |
| `voice-agent/filler_prerender.py` | Calls `localhost:8766/tts` — same |
| `voice-agent/.env` | URLs still point to localhost ports |
| `src/livekitRoutes.ts` | Node.js tool gateway — unchanged |
| `livekit.yaml` | LiveKit config — unchanged |
| `llama/run_llama.sh` | llama.cpp startup — unchanged |
| `frontend/src/App.tsx` | LiveKit React code — unchanged |

---

## 13. Troubleshooting

### GPU not visible inside STT container

```bash
# Verify NVIDIA runtime is wired into Docker
docker info | grep -i runtime
# Should include: nvidia

# Test GPU passthrough directly
docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi

# If that fails, re-run Section 1 (NVIDIA Container Toolkit)
```

### STT container starts but uses CPU instead of CUDA

```bash
# Check the startup log
docker compose logs stt-service | grep "Loading Faster-Whisper"
# Should say:  Loading Faster-Whisper on cuda (float16)...
# If it says cpu, the deploy: block is missing from docker-compose.yml

# Verify the deploy block was parsed
docker inspect $(docker compose ps -q stt-service) | grep -A 5 DeviceRequests
```

### TTS is slow on first call after container restart

```bash
# Normal — ONNX compiles GPU/CPU kernels on first inference.
# Warm-up takes 10-20s. Subsequent calls hit the <100ms target.

# Optional: bake warm-up into the image so container starts hot
# Add to Dockerfile.tts before CMD:
# RUN python -c "from kokoro_onnx import Kokoro; \
#   k=Kokoro.from_pretrained(); \
#   k.create('warm up', voice='af_bella', speed=1.0, lang='en-us')"
```

### Port 8765 or 8766 already in use

```bash
sudo lsof -i :8765   # find and kill previous process
sudo lsof -i :8766
docker compose up -d stt-service tts-service
```

### Model re-downloads on every container restart

```bash
# Volumes must be declared — check they exist
docker volume ls | grep -E "stt|tts"
# docker_stt-model-cache
# docker_tts-model-cache

# If missing, confirm the volumes: block was added to docker-compose.yml, then:
docker compose up -d stt-service tts-service   # volumes are created on first up
```

---

## 14. Runtime Flow (Final Architecture)

```
BROWSER MIC ──(WebRTC Opus)──► LIVEKIT :7880
                                     │
                           WebRTC session (audio track)
                                     │
                                     ▼
                           ZEPHYR AGENT (Host Python)
                                     │
              ┌──────────────────────┼────────────────────┐
              │                      │                    │
              ▼                      ▼                    │
    SILERO VAD (Host GPU)   STT :8765 (Docker+CUDA)       │
              │                      │                    │
              │             "get active alarms"           │
              │                      │                    │
              └──────────────────────►                    │
                                     │                    │
                              LLM :8080 (Host GPU)        │
                                     │                    │
                          ┌──────────┴──────────┐         │
                          │                     │         │
                      Tokens               tool_call      │
                          │                     │         │
                          ▼                     ▼         │
                   TTS :8766            NODE.JS :9005     │
                 (Docker CPU)            (Host)           │
                          │                │              │
                    WAV→frames        bridge.ts           │
                          │                │              │
                          │          ThingsBoard REST     │
                          │                               │
                          └───────────────────────────────►
                                     │
                           LIVEKIT :7880 (Docker)
                                     │
                        WebRTC audio track back to browser
                                     │
                                     ▼
                             BROWSER SPEAKER
```

**End-to-end latency budget: ~1.0–1.1 seconds**
(VAD 350ms + Network <10ms + STT <200ms + LLM TTFT <150ms + TTS <100ms)