"""
tts_service.py — Kokoro ONNX TTS Service
Exposes:
  POST /tts               → native WAV endpoint (used by custom_tts.py)
  POST /v1/audio/speech   → OpenAI-compatible endpoint (used by livekit-plugins-openai)

Run: uvicorn tts_service:app --host 0.0.0.0 --port 8766 --workers 1
"""

import io
import logging
import re
import time

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from kokoro_onnx import Kokoro
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-service")

# ── Kokoro model init ──────────────────────────────────────────────────────
logger.info("Loading Kokoro ONNX model from local files...")
kokoro = Kokoro("kokoro-v0_19.onnx", "voices.bin")
logger.info("Kokoro TTS model ready.")

# ── Voice mapping (OpenAI names → Kokoro voices) ──────────────────────────
VOICE_MAP: dict[str, str] = {
    "alloy":   "af_bella",
    "echo":    "af_bella",
    "fable":   "af_bella",
    "onyx":    "am_adam",
    "nova":    "af_nova",
    "shimmer": "af_bella",
    # Pass Kokoro voices through directly
    "af_bella": "af_bella",
    "af_nova":  "af_nova",
    "am_adam":  "am_adam",
}

# ── TTS text preprocessor ─────────────────────────────────────────────────
REPLACEMENTS: list[tuple[str, str]] = [
    # Acronyms → spelled out
    (r'\bMQTT\b',     "M Q T T"),
    (r'\bRPM\b',      "R P M"),
    (r'\bRPC\b',      "R P C"),
    (r'\bAPI\b',      "A P I"),
    (r'\bHTTP\b',     "H T T P"),
    (r'\bHTTPS\b',    "H T T P S"),
    (r'\bJSON\b',     "J S O N"),
    (r'\bVAD\b',      "V A D"),
    (r'\bIoT\b',      "I O T"),
    (r'\bUDP\b',      "U D P"),
    (r'\bTCP\b',      "T C P"),
    (r'\bUUID\b',     "U U I D"),
    # Units → natural spoken form
    (r'(\d+(?:\.\d+)?)\s*°C', r'\1 degrees Celsius'),
    (r'(\d+(?:\.\d+)?)\s*°F', r'\1 degrees Fahrenheit'),
    (r'(\d+(?:\.\d+)?)\s*kPa', r'\1 kilopascals'),
    (r'(\d+(?:\.\d+)?)\s*kW\b', r'\1 kilowatts'),
    (r'(\d+(?:\.\d+)?)\s*kWh', r'\1 kilowatt hours'),
    (r'(\d+(?:\.\d+)?)\s*Hz\b', r'\1 hertz'),
    (r'(\d+(?:\.\d+)?)\s*%',   r'\1 percent'),
]

def preprocess_text(text: str) -> str:
    for pattern, replacement in REPLACEMENTS:
        text = re.sub(pattern, replacement, text)
    # Strip markdown that might leak in
    text = re.sub(r'\*+', '', text)
    text = re.sub(r'#+\s*', '', text)
    text = re.sub(r'`+', '', text)
    return text.strip()


def render_wav(text: str, voice: str = "af_bella", speed: float = 1.1) -> bytes:
    """Synthesize text → WAV bytes."""
    clean = preprocess_text(text)
    kokoro_voice = VOICE_MAP.get(voice, "af_bella")
    samples, sample_rate = kokoro.create(clean, voice=kokoro_voice, speed=speed, lang="en-us")

    int16_samples = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    sf.write(buf, int16_samples, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


def wav_to_mp3(wav_bytes: bytes) -> bytes:
    """Convert WAV bytes → MP3 bytes using pydub+ffmpeg."""
    from pydub import AudioSegment
    wav_buf = io.BytesIO(wav_bytes)
    audio   = AudioSegment.from_wav(wav_buf)
    mp3_buf = io.BytesIO()
    audio.export(mp3_buf, format="mp3", bitrate="128k")
    mp3_buf.seek(0)
    return mp3_buf.read()


# ── FastAPI app ────────────────────────────────────────────────────────────
app = FastAPI(title="Zephyr TTS Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "kokoro-onnx"}


class TTSRequest(BaseModel):
    text: str
    voice: str   = "af_bella"
    speed: float = 1.1
    language: str = "en-us"


@app.post("/tts")
async def tts_native(req: TTSRequest):
    """
    Native WAV endpoint — used by custom_tts.py in the agent.
    Returns: audio/wav (PCM-16, 24kHz, mono)
    """
    t0 = time.perf_counter()
    wav_bytes = render_wav(req.text, voice=req.voice, speed=req.speed)
    logger.info(f"TTS [{(time.perf_counter()-t0)*1000:.0f}ms] text={req.text[:60]!r}")

    def stream():
        chunk = 4096
        for i in range(0, len(wav_bytes), chunk):
            yield wav_bytes[i:i+chunk]

    return StreamingResponse(stream(), media_type="audio/wav")


@app.post("/v1/audio/speech")
async def tts_openai(request: Request):
    """
    OpenAI-compatible speech endpoint.
    livekit-plugins-openai TTS plugin calls this with:
      {"model":"tts-1","input":"...","voice":"alloy","response_format":"mp3"}
    """
    body   = await request.json()
    text   = body.get("input", "")
    voice  = body.get("voice", "af_bella")
    fmt    = body.get("response_format", "wav")
    speed  = float(body.get("speed", 1.1))

    t0 = time.perf_counter()
    wav_bytes = render_wav(text, voice=voice, speed=speed)

    if fmt == "mp3":
        audio_bytes  = wav_to_mp3(wav_bytes)
        content_type = "audio/mpeg"
    else:
        audio_bytes  = wav_bytes
        content_type = "audio/wav"

    logger.info(f"TTS-OAI [{(time.perf_counter()-t0)*1000:.0f}ms] fmt={fmt} text={text[:60]!r}")

    def stream():
        chunk = 4096
        for i in range(0, len(audio_bytes), chunk):
            yield audio_bytes[i:i+chunk]

    return StreamingResponse(stream(), media_type=content_type)