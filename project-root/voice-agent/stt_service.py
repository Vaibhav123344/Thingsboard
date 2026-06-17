"""
stt_service.py — Local Faster-Whisper STT
Exposes OpenAI-compatible POST /v1/audio/transcriptions
Run: uvicorn stt_service:app --host 0.0.0.0 --port 8765 --workers 1
"""

import io
import logging
import time

import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stt-service")

# ── Model init ─────────────────────────────────────────────────────────────
DEVICE       = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE_TYPE = "float16" if DEVICE == "cuda" else "int8"

logger.info(f"Loading Faster-Whisper on {DEVICE} ({COMPUTE_TYPE})...")
# Downloads automatically to ~/.cache/huggingface/hub on first run
whisper_model = WhisperModel("small.en", device=DEVICE, compute_type=COMPUTE_TYPE)
logger.info("Faster-Whisper model ready.")

# ── FastAPI app ────────────────────────────────────────────────────────────
app = FastAPI(title="Zephyr STT Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health():
    return {"status": "ok", "device": DEVICE, "model": "small.en"}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str       = Form(default="whisper-1"),       # ignored, using local
    language: str    = Form(default="en"),
    response_format: str = Form(default="json"),
):
    """
    OpenAI-compatible transcription endpoint.
    Accepts multipart audio upload, returns {"text": "..."}
    """
    t0 = time.perf_counter()
    audio_bytes = await file.read()
    audio_buf   = io.BytesIO(audio_bytes)

    segments, info = whisper_model.transcribe(
        audio_buf,
        beam_size=5,
        language="en",
        no_speech_threshold=0.6,        # discard silence / noise
        log_prob_threshold=-1.0,        # discard hallucinations
        condition_on_previous_text=False,
    )

    text = " ".join(seg.text.strip() for seg in segments if seg.text.strip())
    elapsed_ms = (time.perf_counter() - t0) * 1000

    logger.info(f"STT [{elapsed_ms:.0f}ms] detected_lang={info.language!r} → {text!r}")

    return {"text": text, "language": info.language}