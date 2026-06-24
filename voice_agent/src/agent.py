"""
agent.py — Local voice AI pipeline orchestrator.

Loads the system prompt from a configurable markdown file and registers
all ThingsBoard tools that execute via HTTP to the Express REST gateway.

Pipeline:
  STT:  Faster-Whisper large-v3 (auto-detects Hindi/English)  → :8765
  LLM:  Ollama (configurable model)                           → :11434
  TTS:  Kokoro ONNX (supports Hindi + English voices)         → :8766
"""

import logging
import os

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    EndpointingOptions,
    InterruptionOptions,
    JobContext,
    JobProcess,
    RunContext,
    TurnHandlingOptions,
    cli,
    function_tool,
    room_io,
)
from livekit.plugins import openai as lk_openai
from livekit.plugins import silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from prompt_loader import load_system_prompt
from service_health import ServiceHealth
from tools import ThingsBoardTools, close_shared_session
from custom_tts import LocalKokoroTTS


# Suppress the transformers warning about PyTorch not being found
class SuppressTransformersWarning(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return "PyTorch was not found" not in msg and "None of PyTorch" not in msg


logging.getLogger("transformers").addFilter(SuppressTransformersWarning())

logger = logging.getLogger("agent")

load_dotenv(".env.local")


# -- Service URLs (configurable via environment) ----------------------------
STT_URL = os.environ.get("STT_URL", "http://localhost:8765")
OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gpt-oss:20b")


# -- Assistant Agent --------------------------------------------------------
# Uses multiple inheritance:
#   ThingsBoardTools → provides all @function_tool methods (40+ tools)
#   Agent            → LiveKit agent base class
#
# The system prompt is loaded from src/prompts/system_prompt.md (or override
# via SYSTEM_PROMPT env var). The prompt drives the agent's persona, language
# rules, and tool usage behavior.

class Assistant(ThingsBoardTools, Agent):
    def __init__(self) -> None:
        super().__init__(instructions=load_system_prompt())


# -- Server setup -----------------------------------------------------------
server = AgentServer()


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def my_agent(ctx: JobContext):
    # Logging setup
    ctx.log_context_fields = {
        "room": ctx.room.name,
    }

    # -- Service health monitor -----------------------------------------------
    # Pings STT endpoint periodically and gates startup
    health = ServiceHealth(
        services={
            "stt": STT_URL,
        },
        check_interval=30.0,  # Reduced from 10s — local services are stable
        timeout=2.0,  # Reduced from 5s — local services respond in <50ms
    )
    await health.start()

    # Wait for STT to be ready
    services_ready = await health.wait_for_services(timeout=30.0)
    if not services_ready:
        logger.warning(
            "STT service is not healthy yet — starting agent anyway."
        )

    # -- Fully local voice AI pipeline ----------------------------------------
    # STT:  Faster-Whisper large-v3 (auto-detects Hindi/English)       -> :8765
    # LLM:  Ollama gpt-oss                                             -> :11434
    # TTS:  Kokoro ONNX running in-memory (supports Hindi + English)
    session = AgentSession(
        stt=lk_openai.STT(
            model="whisper-1",
            base_url=f"{STT_URL}/v1",
            api_key="not-needed",
        ),
        llm=lk_openai.LLM.with_ollama(
            model=OLLAMA_MODEL,
            base_url=f"{OLLAMA_URL}/v1",
            temperature=0.2,  # Lower temp = faster, more deterministic
        ),
        tts=LocalKokoroTTS(
            voice="af_bella",
            speed=1.15,
        ),
        vad=ctx.proc.userdata["vad"],
        # -- Turn handling --------------------------------------------------------
        # TurnDetector: MultilingualModel plugin
        # Endpointing: 0.5–1.5s dynamic window balances speed and accuracy
        # Interruption: VAD mode (adaptive requires LiveKit Cloud aligned_transcript)
        # False interruption recovery: resumes if user just coughed/noise
        turn_handling=TurnHandlingOptions(
            # MultilingualModel EOU turn detection plugin.
            # Run once: uv run python src/agent.py download-files
            turn_detection=MultilingualModel(),
            endpointing=EndpointingOptions(
                mode="dynamic",
                min_delay=0.3,   # 0.3s of silence before turn ends (was 0.5s)
                max_delay=1.2,   # Allow up to 1.2s natural pause (was 1.5s)
            ),
            interruption=InterruptionOptions(
                enabled=True,
                # VAD mode works with self-hosted STT. Adaptive mode requires
                # LiveKit Cloud + aligned_transcript capability, which our
                # Whisper STT does not provide — causing the interruption to
                # be silently disabled. VAD mode gives us real interruption.
                mode="vad",
                min_duration=0.5,              # Require 0.5s of speech (filters noise)
                min_words=2,                   # Require 2+ words (filters echo bursts)
                resume_false_interruption=True,
                false_interruption_timeout=0.5,
            ),
        ),
        # Don't close session if user is silent -- be patient
        user_away_timeout=30.0,
    )

    # Join the room and connect to the user
    await ctx.connect()

    # Start the voice pipeline session
    await session.start(
        agent=Assistant(),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(),
            text_output=room_io.TextOutputOptions(sync_transcription=False),
        ),
    )

    # Ensure health monitor and HTTP connection pool are cleaned up when session ends
    async def on_close(reason: str = ""):
        await health.stop()
        await close_shared_session()

    ctx.add_shutdown_callback(on_close)


if __name__ == "__main__":
    cli.run_app(server)
