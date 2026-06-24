"""
tts_service.py — Kokoro ONNX TTS Service (Multilingual: English + Hindi)
Exposes:
  POST /tts               → native WAV endpoint
  POST /v1/audio/speech   → OpenAI-compatible endpoint (used by livekit-plugins-openai)

Features:
  - Auto-detect Hindi/English from text using lingua-py
  - Auto-switch voice to Hindi (hf_alpha) or English (af_bella)
  - Improved Devanagari text preprocessing
  - Concurrency limiter (max 3 concurrent renders)
  - Input validation (max 5000 chars)
  - Readiness endpoint for startup gating

Run: uvicorn tts_service:app --host 0.0.0.0 --port 8766 --workers 1
"""

import asyncio
import io
import logging
import re
import struct
import time
import unicodedata

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from kokoro_onnx import Kokoro
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("tts-service")

# ── Constants ──────────────────────────────────────────────────────────────
MAX_INPUT_CHARS = 5000  # reject oversized text inputs
MAX_CONCURRENT_RENDERS = 3  # limit concurrent ONNX inference

# ── Concurrency limiter ───────────────────────────────────────────────────
_tts_semaphore = asyncio.Semaphore(MAX_CONCURRENT_RENDERS)

# ── Kokoro model init ──────────────────────────────────────────────────────
logger.info("Loading Kokoro ONNX model from local files...")
_model_ready = False
try:
    import os
    import sys
    
    # Programmatically add NVIDIA package bin folders to the DLL search path on Windows
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

    import onnxruntime as ort
    
    # Try preloading DLLs if using newer ORT versions
    if hasattr(ort, "preload_dlls"):
        try:
            ort.preload_dlls()
        except Exception:
            pass

    available = ort.get_available_providers()
    logger.info(f"ONNX Runtime available providers: {available}")
    
    # We prefer CUDAExecutionProvider for GPU acceleration
    preferred_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    providers = [p for p in preferred_providers if p in available]
    if not providers:
        providers = ["CPUExecutionProvider"]
        
    logger.info(f"Initializing ONNX session with providers: {providers}")
    
    # Create custom InferenceSession
    session = ort.InferenceSession("kokoro-v1.0.onnx", providers=providers)
    
    # Initialize Kokoro from the session
    kokoro = Kokoro.from_session(session, "voices-v1.0.bin")
    _model_ready = True
    logger.info("Kokoro TTS model ready.")
except Exception as e:
    logger.exception("Failed to load Kokoro model")
    kokoro = None

# Language detector initialized with Unicode patterns
_RE_DEVANAGARI = re.compile(r"[\u0900-\u097f]")

# ── Voice mapping (OpenAI names → Kokoro voices) ──────────────────────────
VOICE_MAP: dict[str, str] = {
    # OpenAI-compatible aliases → Kokoro English voices
    "alloy": "af_bella",
    "echo": "af_bella",
    "fable": "af_bella",
    "onyx": "am_adam",
    "nova": "af_nova",
    "shimmer": "af_bella",
    # Kokoro English voices (pass-through)
    "af_bella": "af_bella",
    "af_nova": "af_nova",
    "af_heart": "af_heart",
    "am_adam": "am_adam",
    # Kokoro Hindi voices
    "hf_alpha": "hf_alpha",
    "hm_omega": "hm_omega",
}

# Hindi voice counterparts for auto-switching
HINDI_VOICE_MAP: dict[str, str] = {
    # English female → Hindi female
    "af_bella": "hf_alpha",
    "af_nova": "hf_alpha",
    "af_heart": "hf_alpha",
    # English male → Hindi male
    "am_adam": "hm_omega",
    # OpenAI aliases
    "alloy": "hf_alpha",
    "echo": "hf_alpha",
    "fable": "hf_alpha",
    "onyx": "hm_omega",
    "nova": "hf_alpha",
    "shimmer": "hf_alpha",
}

# ── Language detection from voice prefix ──────────────────────────────────
VOICE_LANG_MAP: dict[str, str] = {
    "a": "en-us",  # American English voices start with 'a'
    "b": "en-gb",  # British English voices start with 'b'
    "h": "hi",  # Hindi voices start with 'h'
    "j": "ja",  # Japanese voices start with 'j'
    "z": "zh",  # Chinese voices start with 'z'
}


def detect_lang_from_voice(voice: str) -> str:
    """Detect TTS language code from voice name prefix."""
    if voice and len(voice) >= 1:
        prefix = voice[0].lower()
        return VOICE_LANG_MAP.get(prefix, "en-us")
    return "en-us"


def contains_devanagari(text: str) -> bool:
    """Quick check if text contains Devanagari script characters."""
    return bool(_RE_DEVANAGARI.search(text))


def auto_select_voice_and_lang(text: str, requested_voice: str) -> tuple[str, str]:
    """Auto-detect language from text content and pick appropriate voice.

    If the text contains Devanagari characters, switch to the Hindi counterpart
    of the requested voice. Otherwise, keep the original voice.
    """
    kokoro_voice = VOICE_MAP.get(requested_voice, requested_voice)

    # Fast path: if Devanagari characters are present, it's Hindi
    if contains_devanagari(text):
        hindi_voice = HINDI_VOICE_MAP.get(requested_voice, "hf_alpha")
        logger.info(
            f"Devanagari detected → switching {requested_voice!r} → {hindi_voice!r}"
        )
        return (hindi_voice, "hi")

    return (kokoro_voice, detect_lang_from_voice(kokoro_voice))


# ── Devanagari numeral mapping ────────────────────────────────────────────
DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


# ── TTS text preprocessor (pre-compiled for speed) ─────────────────────
REPLACEMENTS: list[tuple[re.Pattern, str]] = [
    # Acronyms → spelled out
    (re.compile(r"\bMQTT\b"), "M Q T T"),
    (re.compile(r"\bRPM\b"), "R P M"),
    (re.compile(r"\bRPC\b"), "R P C"),
    (re.compile(r"\bAPI\b"), "A P I"),
    (re.compile(r"\bHTTP\b"), "H T T P"),
    (re.compile(r"\bHTTPS\b"), "H T T P S"),
    (re.compile(r"\bJSON\b"), "J S O N"),
    (re.compile(r"\bVAD\b"), "V A D"),
    (re.compile(r"\bIoT\b"), "I O T"),
    (re.compile(r"\bUDP\b"), "U D P"),
    (re.compile(r"\bTCP\b"), "T C P"),
    (re.compile(r"\bUUID\b"), "U U I D"),
    (re.compile(r"\bCPU\b"), "C P U"),
    (re.compile(r"\bGPU\b"), "G P U"),
    (re.compile(r"\bRAM\b"), "R A M"),
    (re.compile(r"\bSSD\b"), "S S D"),
    # Units → natural spoken form
    (re.compile(r"(\d+(?:\.\d+)?)\s*°C"), r"\1 degrees Celsius"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*°F"), r"\1 degrees Fahrenheit"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*kPa"), r"\1 kilopascals"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*kW\b"), r"\1 kilowatts"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*kWh"), r"\1 kilowatt hours"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*Hz\b"), r"\1 hertz"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*%"), r"\1 percent"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*GB\b"), r"\1 gigabytes"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*MB\b"), r"\1 megabytes"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*TB\b"), r"\1 terabytes"),
]

# Pre-compiled markdown stripping patterns
_RE_ASTERISKS = re.compile(r"\*+")
_RE_HEADINGS = re.compile(r"#+\s*")
_RE_BACKTICKS = re.compile(r"`+")
_RE_LINKS = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_RE_UNDERSCORES = re.compile(r"_{2,}")
_RE_STRIKETHROUGH = re.compile(r"~{2,}")
_RE_WHITESPACE = re.compile(r"\s+")


def preprocess_text(text: str) -> str:
    """Clean up text for TTS synthesis (uses pre-compiled patterns)."""
    # Convert Devanagari numerals to ASCII
    text = text.translate(DEVANAGARI_DIGITS)

    # Apply pre-compiled regex replacements
    for pattern, replacement in REPLACEMENTS:
        text = pattern.sub(replacement, text)

    # Strip markdown that might leak in (pre-compiled patterns)
    text = _RE_ASTERISKS.sub("", text)
    text = _RE_HEADINGS.sub("", text)
    text = _RE_BACKTICKS.sub("", text)
    text = _RE_LINKS.sub(r"\1", text)  # [link](url) → link
    text = _RE_UNDERSCORES.sub("", text)  # __bold__
    text = _RE_STRIKETHROUGH.sub("", text)  # ~~strikethrough~~

    # Normalize unicode whitespace
    text = unicodedata.normalize("NFC", text)
    text = _RE_WHITESPACE.sub(" ", text)

    return text.strip()


def _silent_wav(duration_s: float = 0.05) -> bytes:
    """Return a minimal WAV file containing silence (default 50ms)."""
    sample_rate = 24000
    int16_samples = np.zeros(int(sample_rate * duration_s), dtype=np.int16)
    buf = io.BytesIO()
    sf.write(buf, int16_samples, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


def _wav_header(sample_rate: int = 24000, num_channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """Generate a 44-byte WAV header with maximum size for streaming."""
    subchunk2_size = 0xFFFFFFFF - 36
    chunk_size = 0xFFFFFFFF
    byte_rate = sample_rate * num_channels * (bits_per_sample // 8)
    block_align = num_channels * (bits_per_sample // 8)
    
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        chunk_size,
        b"WAVE",
        b"fmt ",
        16,              # Subchunk1Size
        1,               # AudioFormat (PCM = 1)
        num_channels,    # NumChannels
        sample_rate,     # SampleRate
        byte_rate,       # ByteRate
        block_align,     # BlockAlign
        bits_per_sample, # BitsPerSample
        b"data",
        subchunk2_size
    )
    return header


async def render_wav_async(
    text: str, voice: str = "af_heart", speed: float = 1.15, lang: str | None = None
) -> bytes:
    """Synthesize text → WAV bytes using kokoro.create_stream().

    Uses create_stream() instead of create() for lower latency: Kokoro
    processes text sentence-by-sentence on the GPU, yielding audio chunks
    as each sentence finishes. We collect and concatenate all chunks, then
    encode once to WAV. This is faster than create() because the GPU can
    pipeline across sentences and the async loop remains unblocked.
    """
    clean = preprocess_text(text)

    # If text is empty or contains no alphanumeric characters, return silence
    if not clean or not any(ch.isalnum() for ch in clean):
        logger.warning(f"TTS requested with empty/non-alphanumeric text: {text!r}")
        return _silent_wav()

    # Auto-select voice and language based on text content
    kokoro_voice, tts_lang = auto_select_voice_and_lang(clean, voice)

    # Override with explicit lang if provided
    if lang and lang != "en-us":
        tts_lang = lang

    # Adjust speed for Hindi — slightly slower for clarity
    tts_speed = speed
    if tts_lang == "hi":
        tts_speed = min(speed, 1.0)  # Cap at 1.0x for Hindi

    logger.info(
        f"TTS render: voice={kokoro_voice!r} lang={tts_lang!r} speed={tts_speed}"
    )

    # Collect all streamed chunks into a list, then concatenate once.
    # create_stream() yields (samples, sample_rate) tuples per sentence.
    all_chunks: list[np.ndarray] = []
    sample_rate = 24000
    async for samples, sr in kokoro.create_stream(
        clean, voice=kokoro_voice, speed=tts_speed, lang=tts_lang
    ):
        all_chunks.append(samples)
        sample_rate = sr

    if not all_chunks:
        logger.warning(f"TTS produced no audio for: {clean!r}")
        return _silent_wav()

    combined = np.concatenate(all_chunks)
    int16_samples = (np.clip(combined, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    sf.write(buf, int16_samples, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


def wav_to_mp3(wav_bytes: bytes) -> bytes:
    """Convert WAV bytes → MP3 bytes using pydub+ffmpeg."""
    from pydub import AudioSegment

    wav_buf = io.BytesIO(wav_bytes)
    audio = AudioSegment.from_wav(wav_buf)
    mp3_buf = io.BytesIO()
    audio.export(mp3_buf, format="mp3", bitrate="128k")
    mp3_buf.seek(0)
    return mp3_buf.read()


# ── FastAPI app ────────────────────────────────────────────────────────────
app = FastAPI(title="TTS Service — Kokoro ONNX (Multilingual)", version="4.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/health")
async def health():
    """Liveness check — app is running."""
    return {
        "status": "ok",
        "engine": "kokoro-onnx",
        "version": "4.0.0",
        "languages": ["en", "hi"],
        "features": [
            "auto-language-detection",
            "dynamic-voice-switching",
            "concurrency-limiter",
        ],
    }


@app.get("/readiness")
async def readiness():
    """Readiness check — model is loaded and ready to serve."""
    if not _model_ready or kokoro is None:
        raise HTTPException(status_code=503, detail="TTS model not ready")
    return {
        "status": "ready",
        "engine": "kokoro-onnx",
        "max_concurrent": MAX_CONCURRENT_RENDERS,
        "max_input_chars": MAX_INPUT_CHARS,
    }


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.15
    language: str = "en-us"


@app.post("/tts")
async def tts_native(req: TTSRequest):
    """
    Native WAV endpoint.
    Returns: audio/wav (PCM-16, 24kHz, mono)
    """
    if not _model_ready or kokoro is None:
        raise HTTPException(status_code=503, detail="TTS model not ready")

    if len(req.text) > MAX_INPUT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"Text too long ({len(req.text)} chars). "
            f"Maximum is {MAX_INPUT_CHARS}.",
        )

    t0 = time.perf_counter()
    async with _tts_semaphore:
        wav_bytes = await render_wav_async(
            req.text, voice=req.voice, speed=req.speed, lang=req.language
        )
    logger.info(
        f"TTS [{(time.perf_counter() - t0) * 1000:.0f}ms] text={req.text[:60]!r}"
    )

    def stream():
        chunk = 16384  # Larger chunks reduce I/O overhead
        for i in range(0, len(wav_bytes), chunk):
            yield wav_bytes[i : i + chunk]

    return StreamingResponse(stream(), media_type="audio/wav")


@app.post("/v1/audio/speech")
async def tts_openai(request: Request):
    """
    OpenAI-compatible speech endpoint.
    livekit-plugins-openai TTS plugin calls this with:
      {"model":"tts-1","input":"...","voice":"af_heart","response_format":"wav"}
    """
    if not _model_ready or kokoro is None:
        raise HTTPException(status_code=503, detail="TTS model not ready")

    body = await request.json()
    text = body.get("input", "")
    voice = body.get("voice", "af_heart")
    fmt = body.get("response_format", "wav")
    speed = float(body.get("speed", 1.15))

    if len(text) > MAX_INPUT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"Text too long ({len(text)} chars). Maximum is {MAX_INPUT_CHARS}.",
        )

    t0 = time.perf_counter()

    if fmt == "wav":
        async def stream_generator():
            async with _tts_semaphore:
                clean = preprocess_text(text)
                if not clean or not any(ch.isalnum() for ch in clean):
                    logger.warning(f"TTS requested with empty/non-alphanumeric text: {text!r}")
                    yield _silent_wav()
                    return

                kokoro_voice, tts_lang = auto_select_voice_and_lang(clean, voice)
                tts_speed = speed
                if tts_lang == "hi":
                    tts_speed = min(speed, 1.0)

                logger.info(
                    f"TTS streaming: voice={kokoro_voice!r} lang={tts_lang!r} speed={tts_speed}"
                )

                # Yield WAV header
                yield _wav_header()

                # Stream sentence-by-sentence
                async for samples, sr in kokoro.create_stream(
                    clean, voice=kokoro_voice, speed=tts_speed, lang=tts_lang
                ):
                    int16_samples = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
                    yield int16_samples.tobytes()
                
                logger.info(
                    f"TTS-OAI finished streaming in [{(time.perf_counter() - t0) * 1000:.0f}ms] text={text[:60]!r}"
                )

        return StreamingResponse(stream_generator(), media_type="audio/wav")

    # Fallback to full render for MP3 / other formats
    async with _tts_semaphore:
        wav_bytes = await render_wav_async(text, voice=voice, speed=speed)

    if fmt == "mp3":
        audio_bytes = await asyncio.to_thread(wav_to_mp3, wav_bytes)
        content_type = "audio/mpeg"
    else:
        audio_bytes = wav_bytes
        content_type = "audio/wav"

    logger.info(
        f"TTS-OAI [{(time.perf_counter() - t0) * 1000:.0f}ms] fmt={fmt} text={text[:60]!r}"
    )

    def stream():
        chunk = 16384  # Larger chunks reduce I/O overhead
        for i in range(0, len(audio_bytes), chunk):
            yield audio_bytes[i : i + chunk]

    return StreamingResponse(stream(), media_type=content_type)
