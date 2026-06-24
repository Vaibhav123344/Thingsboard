# Industrial AI Observer: Comprehensive System Context

This document serves as the master architectural and functional reference for the **Industrial AI Observer** platform. It details how the core ThingsBoard telemetry system interacts with the fully localized, offline Voice AI pipeline (LiveKit + STT + TTS + LLM).

## 1. High-Level Architecture
The project is a multi-tier industrial monitoring system equipped with a voice-activated AI copilot ("Zephyr"). The architecture transitioned from a cloud-dependent WebSocket implementation (Google Gemini Live) to a **100% local, privacy-first pipeline** using LiveKit, Faster-Whisper, Kokoro TTS, and Ollama.

**The Four Main Pillars:**
1. **Frontend (React/Vite)**: The user interface containing real-time telemetry dashboards and the LiveKit voice interaction module.
2. **Node.js Gateway (`src/`)**: The Express server that simulates physical IoT devices, connects to ThingsBoard via REST/MQTT, and exposes system functions as HTTP tools for the AI.
3. **Forecasting Engine (`backend/`)**: A Python/FastAPI microservice utilizing Amazon's Chronos-2 model to predict telemetry trends ("What-If" analysis).
4. **Voice Agent (`voice_agent/`)**: The local AI brain. It listens to user audio via LiveKit, converts it to text (STT), processes logic via an LLM, executes Node.js tools, and synthesizes spoken responses (TTS).

---

## 2. Directory Structure & File Knowledge

### A. `voice_agent/` (Local Voice AI Pipeline)
This directory replaced the legacy `live_agent_ws.ts` implementation. It runs the intelligent, conversational agent locally.
*   **`pyproject.toml` / `uv.lock`**: Managed by `uv`, these files define the unified Python environment required to run the agent, STT, and TTS natively on Windows with CUDA acceleration.
*   **`src/agent.py`**: The core LiveKit Voice Assistant. It orchestrates the flow: connecting to the LiveKit server, capturing audio, pushing it to STT, streaming text to the LLM (Ollama), handling tool execution logic, and piping the response to TTS.
*   **`src/tools.py`**: Maps over 35+ ThingsBoard functions (e.g., `get_current_telemetry`, `create_alarm`) natively to the LLM. When the LLM decides to trigger a tool, this script executes an HTTP POST request to the Node.js Gateway (`toolsRoutes.ts`).
*   **`prompts/system_prompt.md`**: Defines "Zephyr's" persona, operational rules, and how it should behave as an industrial supervisor.
*   **`stt/stt_service.py`**: A FastAPI microservice running **Faster-Whisper (large-v3-turbo)**. It exposes an OpenAI-compatible `/v1/audio/transcriptions` endpoint to decode streaming audio into text.
*   **`tts/tts_service.py`**: A FastAPI microservice running **Kokoro-ONNX**. It exposes `/v1/audio/speech` to synthesize extremely high-quality, low-latency audio from the LLM's text output.

### B. `src/` (Node.js REST Bridge & Simulator)
This is the middleware that securely interacts with the core ThingsBoard CE platform.
*   **`index.ts`**: The main bootstrapper that launches the Express server on port 9005.
*   **`simulator.ts`**: Simulates live factories. It auto-provisions virtual sensors (e.g., `Smart-Industrial-Sensor-01`), retrieves their MQTT tokens, and constantly pushes mock telemetry (Temperature, Humidity, Vibration) to ThingsBoard.
*   **`bridge.ts`**: The massive REST SDK. It abstracts ThingsBoard API endpoints, allowing programmatic management of devices, assets, alarms, rule chains, and customers.
*   **`toolsRoutes.ts`**: Exposes the `bridge.ts` methods as a unified `POST /api/tools/execute` endpoint. **This is the critical bridge where the Python `voice_agent` communicates with the Node.js environment.**

### C. `frontend/` (React User Interface)
The operator dashboard.
*   **`src/App.tsx`**: The main interface rendering telemetry charts, alarm explorers, and rule-node diagnostics.
*   **`src/LiveKitWrapper.tsx`**: The modern WebRTC integration. It embeds `<LiveKitRoom>` and `<VoiceAssistantControlBar>` to seamlessly stream the user's microphone audio directly to the LiveKit server, replacing the old, brittle raw PCM WebSocket logic.

### D. `backend/` (Chronos Predictive Engine)
*   **`main.py`**: A FastAPI service hosting the `amazon/chronos-2` foundation model. When the AI uses the `forecast_what_if` tool, it calculates when a metric will peak, cross critical thresholds, or dynamically scale based on simulated interventions.

### E. Root Configuration (`/`)
*   **`docker-compose.yml`**: Orchestrates the core platform (PostgreSQL, ThingsBoard CE `tb-node`, and the Node.js `iot-simulator`).
*   **`.env`**: Contains global configuration like API keys, database credentials, and port mappings.

---

## 3. The Full Interaction Flow (How It Works)

1. **User Speaks**: The operator clicks the microphone in the React Frontend (`LiveKitWrapper.tsx`). Audio is streamed securely via WebRTC to the local `livekit-server.exe`.
2. **Audio to Text (STT)**: The Python `agent.py` catches the audio frame and routes it to `stt_service.py`. Faster-Whisper transcribes "Check the vibration on Sensor 01."
3. **LLM Decision**: The text is passed to the local Ollama LLM. Given the `system_prompt.md` and available `tools.py`, the LLM decides it needs real-time data.
4. **Tool Execution**: `agent.py` fires an HTTP POST to the Express server (`toolsRoutes.ts` -> `bridge.ts`), which asks the ThingsBoard database for Sensor 01's telemetry.
5. **LLM Response Formulation**: The LLM receives the data (e.g., "Vibration is at 4.2g") and generates a natural response: "Warning, vibration is critically high at 4.2g. Should I trigger an alarm?"
6. **Text to Audio (TTS)**: The text is streamed to `tts_service.py`, where Kokoro ONNX instantly synthesizes the audio buffer.
7. **Playback**: The audio buffer is sent back through the LiveKit server to the React frontend, where the user hears Zephyr's voice.

## 4. Robustness & Scalability
By removing the legacy Google Gemini WebSocket (`live_agent_ws.ts`) and relying on LiveKit + FastAPI microservices:
* **Latency is drastically reduced** because audio frames are no longer chunked manually via JSON WebSockets.
* **Cost is eliminated** as STT (Whisper), TTS (Kokoro), and Logic (Ollama) execute locally.
* **Security is hardened** because no sensitive industrial telemetry leaves the local network.
