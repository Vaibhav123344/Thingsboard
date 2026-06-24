"""
stt_service.py — Local Faster-Whisper STT (large-v3-turbo)
Exposes OpenAI-compatible POST /v1/audio/transcriptions
Run: uvicorn stt_service:app --host 0.0.0.0 --port 8765 --workers 1

Features:
  - Faster-Whisper large-v3-turbo on CUDA (40% faster than large-v3)
  - Non-blocking async transcription via asyncio.to_thread
  - Input validation (min/max audio size)
  - Readiness endpoint (/readiness) separate from liveness (/health)
  - Structured JSON logging with timing
"""

import asyncio
import io
import logging
import os
import time

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("stt-service")


# Programmatically add NVIDIA package bin folders to the DLL search path on Windows
import sys
if sys.platform == "win32":
    import ctypes
    for path in sys.path:
        nvidia_dir = os.path.join(path, "nvidia")
        if os.path.exists(nvidia_dir) and os.path.isdir(nvidia_dir):
            for folder in os.listdir(nvidia_dir):
                pkg_bin = os.path.join(nvidia_dir, folder, "bin")
                if os.path.exists(pkg_bin):
                    try:
                        # 1. Add to DLL directory search path
                        os.add_dll_directory(pkg_bin)
                        
                        # 2. Prepend to PATH env variable for standard LoadLibrary resolution
                        os.environ["PATH"] = pkg_bin + os.path.pathsep + os.environ["PATH"]
                        logger.info(f"Added DLL search directory: {pkg_bin}")
                        
                        # 3. Preload key libraries
                        for file in os.listdir(pkg_bin):
                            if file.endswith(".dll") and ("cudnn" in file.lower() or "cudart" in file.lower() or "cublas" in file.lower()):
                                try:
                                    ctypes.CDLL(os.path.join(pkg_bin, file))
                                    logger.info(f"Preloaded DLL: {file}")
                                except Exception:
                                    pass
                    except Exception as e:
                        logger.warning(f"Failed to process DLL directory {pkg_bin}: {e}")

# ── Model init ─────────────────────────────────────────────────────────────
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# float16: standard FP16 execution on GPU. Falls back to int8 on CPU.
# Note: int8_float16 (8-bit quantization on GPU) is unsupported on some modern RTX architectures/cuBLAS versions.
COMPUTE_TYPE = os.environ.get(
    "WHISPER_COMPUTE_TYPE",
    "float16" if DEVICE == "cuda" else "int8"
)

# Use faster-whisper-large-v3
MODEL_NAME = os.environ.get("WHISPER_MODEL", "faster-whisper-large-v3")

# Resolve model path. Check local subdirectory relative to this script first,
# then relative to current working directory, then in /app/model-weights (Docker),
# and finally fall back to the Hugging Face model ID.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_PATH_SCRIPT = os.path.join(SCRIPT_DIR, MODEL_NAME)
LOCAL_PATH_CWD = os.path.join(os.getcwd(), MODEL_NAME)
DOCKER_PATH = f"/app/model-weights/{MODEL_NAME}"

if os.path.exists(LOCAL_PATH_SCRIPT):
    MODEL_PATH = LOCAL_PATH_SCRIPT
elif os.path.exists(LOCAL_PATH_CWD):
    MODEL_PATH = LOCAL_PATH_CWD
elif os.path.exists(DOCKER_PATH):
    MODEL_PATH = DOCKER_PATH
else:
    MODEL_PATH = MODEL_NAME


logger.info(f"Loading Faster-Whisper {MODEL_NAME} on {DEVICE} ({COMPUTE_TYPE})...")
_model_ready = False
try:
    whisper_model = WhisperModel(MODEL_PATH, device=DEVICE, compute_type=COMPUTE_TYPE)
    _model_ready = True
    logger.info(f"Faster-Whisper model ready from {MODEL_PATH}.")
except Exception as e:
    logger.error(f"Failed to load Whisper model: {e}")
    whisper_model = None

# ── Constants ──────────────────────────────────────────────────────────────
MIN_AUDIO_BYTES = 100  # reject tiny/empty files
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MB max (about 10 min of WAV)

# ── Hallucination filter ────────────────────────────────────────────────────
# Whisper reliably hallucinates these phrases when processing noise/silence
# or when it picks up the agent's own TTS audio via the microphone (echo).
HALLUCINATION_PATTERNS: frozenset[str] = frozenset({
    "thank you",
    "thanks for watching",
    "please subscribe",
    "like and subscribe",
    "see you next time",
    "thanks for listening",
    "thank you for watching",
    "thank you for listening",
    "you",
    "i don't know",
    "oh",
    "bye",
    "goodbye",
    "okay",
    "hmm",
    "um",
    "uh",
    # Common TTS echo phrases (agent's own voice re-captured by mic)
    "you're welcome",
    "how can i help you",
    "how can i assist you",
    "is there anything else",
})


def is_hallucination(text: str) -> bool:
    """Return True if text matches a known Whisper hallucination pattern.

    Whisper is prone to hallucinating common phrases from noise/silence,
    and to transcribing the agent's own TTS audio as user speech (echo).
    This filter rejects both categories.
    """
    if not text:
        return True
    # Normalise: lowercase, strip punctuation, collapse whitespace
    cleaned = text.strip().lower()
    cleaned = "".join(ch for ch in cleaned if ch.isalnum() or ch.isspace())
    cleaned = " ".join(cleaned.split())
    # Reject single-character or very short outputs (likely noise artifacts)
    if len(cleaned) < 3:
        return True
    return cleaned in HALLUCINATION_PATTERNS

# ── FastAPI app ────────────────────────────────────────────────────────────
app = FastAPI(
    title=f"STT Service — Faster-Whisper {MODEL_NAME}",
    version="2.0.0",
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/health")
async def health():
    """Liveness check — app is running."""
    return {
        "status": "ok",
        "device": DEVICE,
        "model": MODEL_NAME,
    }


@app.get("/readiness")
async def readiness():
    """Readiness check — model is loaded and ready to serve."""
    if not _model_ready or whisper_model is None:
        raise HTTPException(status_code=503, detail="Model not ready")
    return {
        "status": "ready",
        "device": DEVICE,
        "model": MODEL_NAME,
        "compute_type": COMPUTE_TYPE,
    }


def _transcribe_sync(audio_buf: io.BytesIO, language: str | None) -> tuple[str, str]:
    """Synchronous transcription — runs in thread pool.

    Optimized for low-latency voice: greedy decoding (beam_size=1) is ~3x
    faster than beam search and sufficient for short utterances.

    Hallucination suppression:
    - no_speech_threshold=0.3 : reject segments where model is unsure speech
      is present (was 0.6 — too permissive, let noise through)
    - log_prob_threshold=-0.5 : reject very low probability transcriptions
      (was -1.0 = disabled — let all garbage through)
    - compression_ratio_threshold=2.0 : reject highly repetitive segments,
      which is the characteristic signature of Whisper hallucinations
    - VAD threshold=0.4 : ignore faint noise that VAD might mis-classify
    """
    segments, info = whisper_model.transcribe(
        audio_buf,
        beam_size=1,           # Greedy decoding — 3x faster, sufficient for voice
        language=language if language else None,
        no_speech_threshold=0.3,        # Stricter: was 0.6 (too permissive)
        log_prob_threshold=-0.5,        # Reject low-prob segments: was -1.0 (disabled)
        compression_ratio_threshold=2.0,  # Reject repetitive hallucinations
        condition_on_previous_text=False,
        vad_filter=True,       # Skip silence segments for faster processing
        vad_parameters=dict(
            min_silence_duration_ms=300,  # Slightly longer than before (was 250)
            speech_pad_ms=100,
            threshold=0.4,     # Higher VAD threshold: ignore faint noise (default 0.5)
        ),
    )
    text = " ".join(seg.text.strip() for seg in segments if seg.text.strip())
    return text, info.language


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-1"),  # ignored, using local model
    language: str = Form(default=None),
    response_format: str = Form(default="json"),
):
    """
    OpenAI-compatible transcription endpoint.
    Accepts multipart audio upload, returns {"text": "..."}
    """
    if not _model_ready or whisper_model is None:
        raise HTTPException(
            status_code=503, detail="STT model not ready. Please try again."
        )

    t0 = time.perf_counter()
    audio_bytes = await file.read()

    # Input validation
    if len(audio_bytes) < MIN_AUDIO_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Audio too small ({len(audio_bytes)} bytes). "
            f"Minimum is {MIN_AUDIO_BYTES} bytes.",
        )
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio too large ({len(audio_bytes)} bytes). "
            f"Maximum is {MAX_AUDIO_BYTES // (1024 * 1024)} MB.",
        )

    audio_buf = io.BytesIO(audio_bytes)
    # Help PyAV identify the audio format by giving the buffer a virtual name
    audio_buf.name = file.filename or "audio.wav"

    # Non-blocking transcription — prevents event loop starvation
    try:
        text, detected_lang = await asyncio.to_thread(_transcribe_sync, audio_buf, language)
    except Exception as e:
        logger.exception("Error during transcription execution:")
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )

    # Post-processing: reject known Whisper hallucination patterns.
    # This catches phantom transcripts from noise, silence, or the agent's
    # own TTS audio being picked up by the microphone (echo feedback).
    if is_hallucination(text):
        logger.warning(
            f"STT hallucination suppressed: {text!r} "
            f"(size={len(audio_bytes)}B lang={detected_lang!r})"
        )
        text = ""

    elapsed_ms = (time.perf_counter() - t0) * 1000

    logger.info(
        f"STT [{elapsed_ms:.0f}ms] "
        f"size={len(audio_bytes)}B "
        f"lang={detected_lang!r} → {text!r}"
    )

    return {"text": text, "language": detected_lang}
