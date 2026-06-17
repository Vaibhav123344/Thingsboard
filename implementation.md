# Local Speech-to-Speech Voice Pipeline with LiveKit Integration

This document serves as the complete technical blueprint and implementation guide for migrating the **ThingsBoard Industrial AI Copilot (Zephyr)** from the cloud-based **Google Gemini Live API** to a fully **local, high-performance Speech-to-Speech pipeline** utilizing **LiveKit** as the real-time WebRTC media transport layer.

---

## 1. High-Level Architectural Flow

We replace the fragile raw WebSocket audio stream with **LiveKit**, an open-source, WebRTC-based media server. This solves latency, packet loss, echo cancellation, and audio-buffering issues natively at the media layer.

There are two architectural options to implement this. **Option A** is highly recommended as it uses LiveKit's official **Agents Framework**, which has built-in voice-agent orchestration, turn-taking, VAD, and interruption logic.

### Option A: Python LiveKit Agent Framework (Recommended)

In this architecture, the local LiveKit server acts as the media room. A Python-based LiveKit Agent runs as an independent worker, connects to the room, and handles the voice loop natively. The Node.js server serves as the entry-point web gateway and exposes the **37 ThingsBoard tools** from `bridge.ts` via a local REST API.

```
┌────────────────────────────────────────────────────────────────────────┐
│                              BROWSER CLIENT                            │
│                                                                        │
│  [LiveKit Client SDK] ──(WebRTC Audio Out: Mic)─────────────────────┐  │
│  [Audio Player Node] ◀──(WebRTC Audio In: Speaker)───────────────┐  │  │
└─────────────────────────────────┬────────────────────────────────│──┘
                                  │ WebRTC Connection              │
                                  ▼                                │
┌──────────────────────────────────────────────────────────────────│─────┐
│                       LOCAL LIVEKIT SERVER                       │     │
│  • Manages WebRTC Room                                           │     │
│  • Routes tracks between participants                            │     │
└─────────────────────────────────┬────────────────────────────────│─────┘
                                  │ WebRTC Session                 │
                                  ▼                                │
┌──────────────────────────────────────────────────────────────────▼─────┐
│                     PYTHON LIVEKIT AGENT WORKER                        │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                     Turn & Voice Pipeline                      │   │
│   │                                                                │   │
│   │  [VAD Engine (Silero)] ──► Trigger STT / Interrupt LLM         │   │
│   │                                                                │   │
│   │  [STT Engine (Faster-Whisper)] ──► Text Transcription          │   │
│   │                                                                │   │
│   │  [LLM Engine (llama.cpp / gpt-oss20b)] ──► Streaming Tokens    │   │
│   │       │                                                        │   │
│   │       ├─ Text Tokens ──► [TTS Engine (Kokoro ONNX)] ──► Audio ─┘   │
│   │       │                                                            │
│   │       └─ Tool Calls ──► Local HTTP API ──┐                         │
│   └──────────────────────────────────────────│─────────────────────────┘
                                               │ HTTP POST /api/tools
                                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        NODE.JS SERVER / GATEWAY                        │
│  • Generates LiveKit Join Tokens for browser & agent                   │
│  • Tool Host: Receives REST POST calls, runs `bridge.ts` functions     │
│  • MQTT simulator, Express static server, ThingsBoard client           │
└────────────────────────────────────────────────────────────────────────┘
```

### Option B: Node.js Orchestrator (Node-centric)

If you prefer to keep all orchestration logic in TypeScript, Node.js acts as the LiveKit room participant. It subscribes to the browser's audio track, processes audio frames, calls separate Python HTTP services for STT/TTS, and orchestrates the LLM.

```
Browser Client ◄──(WebRTC)──► LiveKit Server ◄──(WebRTC)──► Node.js LiveKit Participant
                                                                │
                                    ┌───────────────────────────┼──────────────────────────┐
                                    ▼                           ▼                          ▼
                          HTTP POST /stt              OpenAI API (stream)        HTTP POST /tts
                        ┌───────────────┐               ┌──────────────┐         ┌───────────────┐
                        │  Python STT   │               │ llama.cpp LLM│         │  Python TTS   │
                        │Faster-Whisper │               │ gpt-oss20b   │         │ Kokoro ONNX   │
                        │ (FastAPI)     │               │              │         │ (FastAPI)     │
                        └───────────────┘               └──────────────┘         └───────────────┘
```

> [!TIP]
> **Why Option A is recommended:** Implementing raw WebRTC audio packet grabbing, audio buffer chunking, VAD synchronization, and streaming speech publishing in Node.js requires low-level C++ bindings or complex audio frame parsing. The **Python LiveKit Agents framework** provides this natively (`livekit-agents` library), making the voice pipeline rock-solid with less code.

---

## 2. Infrastructure Setup & Docker Configuration

To run the local LiveKit server alongside our existing Postgres, ThingsBoard CE, Chronos, and IoT Simulator services, we update the `docker-compose.yml` file.

### LiveKit Server Docker Configuration

Add the `livekit-server` service to your `docker-compose.yml`:

```yaml
  livekit-server:
    image: livekit/livekit-server:latest
    restart: always
    command: --config /etc/livekit.yaml
    ports:
      - "7880:7880" # HTTP API and WS Signaling
      - "7881:7881" # WebRTC TCP fallback
      - "50000-60000:50000-60000/udp" # WebRTC UDP Media (ICE range)
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml
    networks:
      - tb-network
```

Create a `livekit.yaml` file in your root project directory:

```yaml
port: 7880
bind_addresses:
  - ""
development: true # Disables HTTPS requirement for local testing
keys:
  devkey: "secretkeydefaultvalue987654321012" # Matches credentials in Node and Python envs
logging:
  level: info
```

---

## 3. Node.js Backend Changes

The Node.js server needs to do two main tasks:
1. **Provide LiveKit Room Tokens** for both the browser client and the Python Agent.
2. **Expose `bridge.ts` Tools** via a simple REST API (for Option A) so the Python agent can call them.

### 3.1 LiveKit Token Generation

Install `livekit-server-sdk` in the root Node.js project:
```bash
npm install livekit-server-sdk express cors
```

Implement the token service inside `src/simulator.ts` or as a new route:

```typescript
import { AccessToken } from 'livekit-server-sdk';

// Endpoint to generate join token for Web client or Agent
app.get('/api/livekit/token', (req, res) => {
  const room = (req.query.room as string) || 'default-operational-room';
  const identity = (req.query.identity as string) || `operator-${Math.floor(Math.random() * 1000)}`;
  const isAgent = req.query.is_agent === 'true';

  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secretkeydefaultvalue987654321012';

  const at = new AccessToken(apiKey, apiSecret, {
    identity: identity,
    ttl: '2h',
  });

  at.addGrant({
    roomJoin: true,
    room: room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  res.json({ token: at.toJwt() });
});
```

### 3.2 Exposing Bridge Tools via REST

To allow the Python agent to execute all 37 existing functions in `bridge.ts` without rewriting them in Python, add a REST controller to your Express app:

```typescript
import { ThingsBoardRESTBridge } from './bridge';
const bridge = new ThingsBoardRESTBridge();

// Dynamic Tool Execution Gateway
app.post('/api/tools/execute', async (req, res) => {
  const { name, args } = req.body;
  
  // Create mapping of tools matching bridge.ts
  const toolMap: Record<string, Function> = {
    list_devices: () => bridge.listDevices(),
    get_current_telemetry: (a: any) => bridge.getLatestTelemetry(a.device_name),
    get_historical_summary: (a: any) => bridge.getHistoricalStats(a.device_name, a.hours),
    get_active_alarms: () => bridge.getActiveAlarms(),
    get_device_attributes: (a: any) => bridge.getAttributes(a.device_name),
    get_highest_metric: (a: any) => bridge.getHighestMetric(a.metric),
    get_metric_trend: (a: any) => bridge.getMetricTrend(a.device_name, a.metric),
    perform_deep_analysis: (a: any) => bridge.performDeepAnalysis(a.device_name, a.start_time, a.end_time, a.hours),
    create_device: (a: any) => bridge.createDevice(a.device_name, a.device_type, a.label, a.attributes, a.profile_name),
    delete_device: (a: any) => bridge.deleteDevice(a.device_name),
    get_device_credentials: (a: any) => bridge.getDeviceCredentials(a.device_name),
    acknowledge_alarm: (a: any) => bridge.acknowledgeAlarm(a.alarm_id),
    clear_alarm: (a: any) => bridge.clearAlarm(a.alarm_id),
    trigger_rule_engine: (a: any) => bridge.triggerRuleEngine(a.device_name, a.message),
    create_alarm: (a: any) => bridge.createAlarm(a.device_name, a.alarm_type, a.severity, a.details, a.metric_param, a.operator_condition, a.comparison_value),
    create_rule_chain: (a: any) => bridge.createRuleChain(a.name, a.nodes, a.connections, a.first_node_index),
    list_assets: () => bridge.listAssets(),
    get_asset_by_name: (a: any) => bridge.getAssetByName(a.asset_name),
    create_asset: (a: any) => bridge.createAsset(a.asset_name, a.asset_type, a.label),
    delete_asset: (a: any) => bridge.deleteAsset(a.asset_name),
    create_relation: (a: any) => bridge.createRelation(a.from_name, a.to_name, a.relation_type),
    delete_relation: (a: any) => bridge.deleteRelation(a.from_name, a.to_name, a.relation_type),
    list_relations: (a: any) => bridge.listRelations(a.entity_name),
    save_device_attributes: (a: any) => bridge.saveDeviceAttributes(a.device_name, a.scope, a.attributes),
    delete_device_attributes: (a: any) => bridge.deleteDeviceAttributes(a.device_name, a.scope, a.keys),
    list_dashboards: () => bridge.listDashboards(),
    get_dashboard_by_id: (a: any) => bridge.getDashboardById(a.dashboard_id),
    assign_dashboard_to_customer: (a: any) => bridge.assignDashboardToCustomer(a.customer_id, a.dashboard_id),
    list_device_profiles: () => bridge.listDeviceProfiles(),
    get_device_profile_by_id: (a: any) => bridge.getDeviceProfileById(a.profile_id),
    send_one_way_rpc: (a: any) => bridge.sendOneWayRpc(a.device_name, a.method, a.params),
    send_two_way_rpc: (a: any) => bridge.sendTwoWayRpc(a.device_name, a.method, a.params),
    list_persistent_rpcs: (a: any) => bridge.listPersistentRpcs(a.device_name),
    inject_rule_engine_queue: (a: any) => bridge.injectRuleEngineQueue(a.device_name, a.message_payload, a.queue_name),
    get_audit_logs: () => bridge.getAuditLogs(),
    create_device_dashboard: (a: any) => bridge.createDeviceDashboard(a.device_name, a.monitored_keys, a.dashboard_title, a.background_color),
    forecast_what_if: (a: any) => bridge.forecastWhatIf(a)
  };

  if (name in toolMap) {
    try {
      const result = await toolMap[name](args);
      res.json({ success: true, result });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  } else {
    res.status(404).json({ success: false, error: `Tool ${name} not found.` });
  }
});
```

---

## 4. Local Models & Python Voice Pipeline Services

### 4.1 Speech-to-Text (STT) Service: Faster-Whisper

Expose a local REST endpoint in Python for STT using the `faster-whisper` package.

**Requirements**:
- **Libraries**: `faster-whisper`, `fastapi`, `uvicorn`, `pydantic`
- **Model**: `small.en` or `medium.en` (CTranslate2 optimized weights)
- **Execution Config**: If CUDA 12.1 is present, set `device="cuda"`, `compute_type="float16"`. Fall back to `device="cpu"` and `compute_type="int8"` if no GPU is detected.

**FastAPI Implementation Snippet**:
```python
from fastapi import FastAPI, UploadFile, File
from faster_whisper import WhisperModel
import io

app = FastAPI()

# Initialize Faster-Whisper Model
# CTranslate2 utilizes cuDNN and cuBLAS for speedups
model = WhisperModel("small.en", device="cuda", compute_type="float16")

@app.post("/stt")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    audio_file = io.BytesIO(audio_bytes)
    
    segments, info = model.transcribe(audio_file, beam_size=5, language="en")
    text = " ".join([segment.text for segment in segments]).strip()
    
    return {"text": text}
```

### 4.2 Local LLM Service: llama.cpp + gpt-oss20b

Use llama.cpp (`llama-server`) to serve the thinking model `gpt-oss20b`. The llama.cpp server is started locally (e.g. on port `8080`) and exposes an OpenAI-compatible API endpoint.

- **Execution Command**: `./llama-server -m gpt-oss20b.gguf -c 8192 --port 8080 -ngl 99` (offloads layers to GPU for lowest latency).
- **Tool Calling**: `gpt-oss20b` supports tool calling formats (either natively through chat templates or formatted JSON structure via instructions in the system prompt).
- **Context Management**: Keep conversation history in a sliding window to fit within the `llama.cpp` context window configuration (e.g., 8192 tokens).

### 4.3 Text-to-Speech (TTS) Service: Kokoro-82M ONNX

`Kokoro-82M` offers near-human, expressive synthesis with a extremely light footprints. Using the ONNX runtime ensures sub-100ms Time-to-First-Audio (TTFA).

**FastAPI Implementation Snippet**:
```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import numpy as np
import soundfile as sf
import io
# Import Kokoro specific ONNX runner
from kokoro_onnx import Kokoro

app = FastAPI()
kokoro = Kokoro("kokoro-v0_19.onnx", "voices.bin")

@app.post("/tts")
async def text_to_speech(payload: dict):
    text = payload.get("text", "")
    voice = payload.get("voice", "af_bella") # Zephyr voice style
    
    # Generate PCM 24kHz stream
    samples, sample_rate = kokoro.create(text, voice=voice, speed=1.1, lang="en-us")
    
    # Convert float32 normalized samples to int16 PCM
    int16_samples = (samples * 32767).astype(np.int16)
    
    # Stream the bytes in chunks
    def audio_stream():
        chunk_size = 1024 * 4
        for i in range(0, len(int16_samples), chunk_size):
            yield int16_samples[i:i+chunk_size].tobytes()
            
    return StreamingResponse(audio_stream(), media_type="audio/pcm")
```

---

## 5. LiveKit Voice Agent Orchestrator (Option A)

Using the **LiveKit Python Agents SDK**, we write a single agent worker (`agent.py`) that joins the room and ties VAD, STT, LLM, and TTS together.

```python
import logging
from livekit import agents, rtc
from livekit.plugins import whisper, openai, silero, opentts
import aiohttp

logging.basicConfig(level=logging.INFO)

# Define System Instruction for Qwen
SYSTEM_INSTRUCTION = """
You are Zephyr, an elite Industrial Operations Copilot. You speak with technical authority and precision.
You have access to 37 tools. Execute them when asked.
Be concise. Output only conversational text. Do not use bullet points or markdown tables.
"""

async def entrypoint(ctx: agents.JobContext):
    # Connect to room
    await ctx.connect()
    
    # Initialize llama.cpp client via LiveKit's OpenAI compatible plugin
    llm = openai.LLM(
        model="gpt-oss20b",
        base_url="http://localhost:8080/v1",
        api_key="llama-cpp-key"
    )
    
    # Define Tools dynamically mapping to Node REST endpoint
    @llm.ai_callable(description="List active industrial sensors")
    async def list_devices() -> str:
        async with aiohttp.ClientSession() as session:
            async with session.post("http://localhost:9005/api/tools/execute", json={"name": "list_devices", "args": {}}) as resp:
                data = await resp.json()
                return str(data.get("result"))

    @llm.ai_callable(description="Get latest telemetry readings")
    async def get_current_telemetry(device_name: str) -> str:
        async with aiohttp.ClientSession() as session:
            async with session.post("http://localhost:9005/api/tools/execute", json={"name": "get_current_telemetry", "args": {"device_name": device_name}}) as resp:
                data = await resp.json()
                return str(data.get("result"))

    # Map remaining 37 tools similarly...

    # Configure the Voice Pipeline Agent
    # Handles Silero VAD, Whisper STT, LLM, and TTS streaming pipeline automatically
    agent = agents.VoicePipelineAgent(
        vad=silero.VAD.load(),
        stt=whisper.STT(),
        llm=llm,
        tts=opentts.TTS(), # Configure Kokoro client here
        chat_ctx=agents.llm.ChatContext().append(role="system", text=SYSTEM_INSTRUCTION),
    )

    # Start the voice pipeline in the connected LiveKit room
    agent.start(ctx.room)
    
    # Speak initial greetings
    await agent.say("Neural link established. Industrial Copilot Zephyr is online.", allow_interruptions=True)

if __name__ == "__main__":
    agents.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
```

### 5.1 Interruption Logic & Turn-Taking

The `VoicePipelineAgent` has built-in turn-taking and interruption logic:
1. **Barge-in / Interruption**: When the client publishes microphone audio, Silero VAD triggers a `speech_start` event.
2. The agent immediately halts its active TTS streaming playback track to the room.
3. The LLM text generation is cancelled using an internal `AbortController` cancellation token.
4. The agent updates its conversation history to include only what it *actually finished speaking* (relying on LiveKit's playback timing feedback) before the interruption occurred.

---

## 6. Frontend Client Changes (React)

Modify `frontend/src/App.tsx` to replace the raw WebSocket streaming interface with the **LiveKit Client SDK**.

### 6.1 Package Additions
Install LiveKit web clients:
```bash
npm install livekit-client @livekit/components-react
```

### 6.2 App.tsx Rewrite Snippet

Replace browser Web Audio API queues and WebSocket listener blocks with `LiveKitRoom`:

```tsx
import { 
  LiveKitRoom, 
  RoomAudioRenderer, 
  useLocalParticipant,
  useTracks
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useState, useEffect } from 'react';

export default function App() {
  const [roomToken, setRoomToken] = useState<string | null>(null);
  const [livekitConnected, setLivekitConnected] = useState(false);

  // Fetch token when Live Mode is toggled
  const handleToggleLiveMode = async (active: boolean) => {
    if (active) {
      try {
        const res = await fetch('http://localhost:9005/api/livekit/token?room=operational-room');
        const data = await res.json();
        setRoomToken(data.token);
        setLivekitConnected(true);
      } catch (e) {
        console.error("Could not obtain LiveKit room token", e);
      }
    } else {
      setRoomToken(null);
      setLivekitConnected(false);
    }
  };

  return (
    <div>
      {/* Navbar with connection status indicators */}
      {renderNavbar(livekitConnected)}
      
      {livekitConnected && roomToken ? (
        <LiveKitRoom
          video={false}
          audio={true}
          token={roomToken}
          serverUrl="ws://localhost:7880"
          onConnected={() => console.log("Joined WebRTC Media Room")}
          onDisconnected={() => setLivekitConnected(false)}
        >
          {/* Main layout */}
          <div style={{ display: 'flex', flex: 1 }}>
            <Sidebar />
            <MainDashboard onToggleLive={handleToggleLiveMode} />
            <Terminal />
          </div>
          
          {/* Natively handles incoming Audio track decoding and playback */}
          <RoomAudioRenderer />
        </LiveKitRoom>
      ) : (
        <div style={{ display: 'flex', flex: 1 }}>
          <Sidebar />
          <MainDashboard onToggleLive={handleToggleLiveMode} />
          <Terminal />
        </div>
      )}
    </div>
  );
}

function MainDashboard({ onToggleLive }: { onToggleLive: (active: boolean) => void }) {
  const [isRecording, setIsRecording] = useState(false);

  // Grab local audio publish controls from context if inside Room
  const { localParticipant } = useLocalParticipant();

  const toggleMic = async () => {
    const nextState = !isRecording;
    setIsRecording(nextState);
    onToggleLive(nextState);
    
    if (localParticipant) {
      // Toggle publishing track directly via LiveKit controls
      await localParticipant.setMicrophoneEnabled(nextState);
    }
  };

  return (
    <button onClick={toggleMic} style={{ background: isRecording ? '#ef4444' : '#38bdf8' }}>
      {isRecording ? "Stop Live Mode" : "Start Live Mode"}
    </button>
  );
}
```

---

## 7. Latency Budget Analysis & Optimizations

To deliver a conversational response time under **1.2 seconds**, target the following budgets:

| Pipeline Stage | Target Latency | Optimization Strategy |
|---|---|---|
| **VAD Turn-Detection** | 300ms–400ms | Set Silero silence timeout to exactly 350ms. High values feel laggy; lower values clip natural speech pauses. |
| **Audio Transport** | < 10ms | WebRTC Opus encoding via LiveKit bypasses WebSocket queuing and packet overhead. |
| **STT Transcription** | < 200ms | Use `faster-whisper-small` with float16 CUDA acceleration. Keep language fixed to `"en"`. |
| **LLM Inference TTFT** | < 150ms | Host gpt-oss20b on local llama.cpp server, ensuring max layers offloaded to GPU (-ngl 99) and context size set to 8192. |
| **LLM Token-to-Sentence** | < 150ms | Stream tokens and accumulate into sentences. Once a sentence completes, forward it to TTS immediately. |
| **TTS Synthesis (TTFA)** | < 100ms | Run Kokoro-82M ONNX Runtime with CPU/GPU optimization. Sub-100ms start time ensures speech streams immediately. |
| **Total perceived latency** | **~1.0s - 1.1s** | Well within the comfortable human conversational boundary. |

---

## 8. Comprehensive Edge Cases & Solutions

| Category | Edge Case scenario | Technical Resolution Strategy |
|---|---|---|
| **VAD** | User coughs or sighs | VAD energy-thresholding ignores high-frequency non-speech events. Whisper transcription evaluates if transcribed text is noise and discards empty output. |
| **VAD** | User says "Yes... (400ms pause) ...that works" | Split avoidance. Set a minor delay (350ms) to ensure speech boundary isn't prematurely sliced. |
| **VAD** | Echo feedback from speakers | Browser media constraint `echoCancellation: true` combined with LiveKit's client-side echo cancellation. |
| **STT** | Background factory machinery hum | Inject bandpass filters (300Hz-3.4kHz) on input or use Silero VAD's built-in vocal frequency passband. |
| **STT** | Silence hallucinations ("Thank you for watching" etc.) | Configure `no_speech_threshold=0.6` and `log_prob_threshold=-1.0` in Faster-Whisper to skip segments with low log probability. |
| **LLM** | Malformed tool call JSON | If parser encounters invalid JSON, capture the string, ask llama.cpp/gpt-oss20b to correct it via a secondary fast prompt, or fallback to natural language recovery: *"System error during sensor query."* |
| **LLM** | Running out of context window | Implement token counting on chat context history. Apply sliding window compression: summarize earlier dialogue while retaining system prompts and recent context. |
| **TTS** | Special acronyms ("MQTT", "RPM", "RPC") | Custom dictionary pre-processor. Replace `"MQTT"` with `"M Q T T"`, `"RPM"` with `"R P M"`, and `"80.5°C"` with `"eighty point five degrees Celsius"` before sending text to the TTS engine. |
| **TTS** | Large analytical answers | Never send a giant block of text to TTS. Split the LLM output stream by punctuation markers (`.`, `?`, `!`, `\n`) and feed each sentence to TTS independently. |
| **Interruption** | Interruption during long tool execution (e.g. Chronos-2) | Python Agent receives VAD interruption signal, terminates the HTTP client connection to Node tool server (if cancellation is supported) and immediately discards the result. |
| **Interruption** | Rapid double VAD triggers | Implement locks on state transitions. Ensure previous audio track streams are fully stopped and cleanup routines finish before launching a new LLM generation loop. |

---

## 9. Pre-rendered Filler Audio Clips

To completely eliminate silence during slow operations (like the Chronos-2 what-if forecast which can take 2-4 seconds), pre-synthesize the following audio files using the TTS engine and load them to memory on startup:

| Phrase ID | Spoken Text | When to play |
|---|---|---|
| `checking` | "Checking the sensors now." | Standard telemetry queries |
| `scenarios` | "Let me run the predictive what-if scenario on that data. One moment." | `forecast_what_if` tool call |
| `audit` | "Analyzing the historical data logs." | `perform_deep_analysis` tool call |
| `alarms` | "Let me scan for active warnings." | `get_active_alarms` tool call |

When a slow tool is triggered, the Agent immediately plays the matching pre-loaded buffer to the LiveKit room, maintaining an active audio connection and preventing the user from thinking the system has hung.

---

## 10. Step-by-Step Migration Plan

1. **Docker Setup**: Add `livekit-server` service and create `livekit.yaml`. Start the server and confirm access to port `7880`.
2. **Node.js Gateway Update**:
   - Install `livekit-server-sdk`.
   - Implement the token generation route `/api/livekit/token`.
   - Expose the 37 ThingsBoard tools in a POST controller at `/api/tools/execute`.
3. **Python Voice Sidecar Implementation**:
   - Set up Python virtual environment, install `faster-whisper`, `kokoro-onnx`, `livekit-agents`, and `livekit-plugins-openai`.
   - Create the `agent.py` script. Set up tool calls to forward REST requests back to Node.js.
   - Configure local llama.cpp server and download/run the gpt-oss20b GGUF model on port 8080.
4. **Frontend Integration**:
   - Install client packages (`livekit-client`, `@livekit/components-react`).
   - Replace raw WebSocket streaming logic in `App.tsx` with LiveKit provider components.
5. **Testing**: Run all services locally, toggle Live Mode, and verify seamless speech-to-speech interaction, automatic interruption, and accurate local tool executions.
