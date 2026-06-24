"""
custom_tts.py — Local Kokoro ONNX TTS plugin for LiveKit agents.

Runs ONNX inference locally on the host to completely bypass the docker/HTTP
boundary, achieving extremely low latency streaming audio generation.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
import time
import unicodedata
import numpy as np

from livekit.agents import (
    APIConnectOptions,
    tts,
)
from livekit.agents.utils import shortuuid
from kokoro_onnx import Kokoro
import onnxruntime as ort

logger = logging.getLogger("custom-tts")

SAMPLE_RATE = 24000
NUM_CHANNELS = 1

# Devanagari numerals and script pattern
_RE_DEVANAGARI = re.compile(r"[\u0900-\u097f]")
DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")

# OpenAI compatible voice names mapped to Kokoro voices
VOICE_MAP: dict[str, str] = {
    "alloy": "af_bella",
    "echo": "af_bella",
    "fable": "af_bella",
    "onyx": "am_adam",
    "nova": "af_nova",
    "shimmer": "af_bella",
    "af_bella": "af_bella",
    "af_nova": "af_nova",
    "af_heart": "af_heart",
    "am_adam": "am_adam",
    "hf_alpha": "hf_alpha",
    "hm_omega": "hm_omega",
}

# Hindi counterpart voice map
HINDI_VOICE_MAP: dict[str, str] = {
    "af_bella": "hf_alpha",
    "af_nova": "hf_alpha",
    "af_heart": "hf_alpha",
    "am_adam": "hm_omega",
    "alloy": "hf_alpha",
    "echo": "hf_alpha",
    "fable": "hf_alpha",
    "onyx": "hm_omega",
    "nova": "hf_alpha",
    "shimmer": "hf_alpha",
}

VOICE_LANG_MAP: dict[str, str] = {
    "a": "en-us",
    "b": "en-gb",
    "h": "hi",
    "j": "ja",
    "z": "zh",
}

REPLACEMENTS: list[tuple[re.Pattern, str]] = [
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

_RE_ASTERISKS = re.compile(r"\*+")
_RE_HEADINGS = re.compile(r"#+\s*")
_RE_BACKTICKS = re.compile(r"`+")
_RE_LINKS = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_RE_UNDERSCORES = re.compile(r"_{2,}")
_RE_STRIKETHROUGH = re.compile(r"~{2,}")
_RE_WHITESPACE = re.compile(r"\s+")


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
    """Auto-detect language from text content and pick appropriate voice."""
    kokoro_voice = VOICE_MAP.get(requested_voice, requested_voice)
    if contains_devanagari(text):
        hindi_voice = HINDI_VOICE_MAP.get(requested_voice, "hf_alpha")
        logger.info(f"Devanagari detected → switching {requested_voice!r} → {hindi_voice!r}")
        return hindi_voice, "hi"
    return kokoro_voice, detect_lang_from_voice(kokoro_voice)


def preprocess_text(text: str) -> str:
    """Clean up text for TTS synthesis (uses pre-compiled patterns)."""
    text = text.translate(DEVANAGARI_DIGITS)
    for pattern, replacement in REPLACEMENTS:
        text = pattern.sub(replacement, text)
    text = _RE_ASTERISKS.sub("", text)
    text = _RE_HEADINGS.sub("", text)
    text = _RE_BACKTICKS.sub("", text)
    text = _RE_LINKS.sub(r"\1", text)
    text = _RE_UNDERSCORES.sub("", text)
    text = _RE_STRIKETHROUGH.sub("", text)
    text = unicodedata.normalize("NFC", text)
    text = _RE_WHITESPACE.sub(" ", text)
    return text.strip()


class LocalKokoroTTS(tts.TTS):
    def __init__(
        self,
        *,
        voice: str = "af_bella",
        speed: float = 1.15,
        model_path: str | None = None,
        voices_path: str | None = None,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
        )
        self._voice = voice
        self._speed = speed
        self._kokoro: Kokoro | None = None
        self._lock = asyncio.Lock()

        # Resolve paths dynamically relative to script directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        default_model = os.path.normpath(os.path.join(script_dir, "..", "tts", "kokoro-v1.0.onnx"))
        default_voices = os.path.normpath(os.path.join(script_dir, "..", "tts", "voices-v1.0.bin"))

        self._model_path = model_path or default_model
        self._voices_path = voices_path or default_voices

    @property
    def model(self) -> str:
        return "kokoro-v1.0-local"

    @property
    def provider(self) -> str:
        return "onnxruntime-local"

    def _ensure_model_loaded(self) -> Kokoro:
        if self._kokoro is not None:
            return self._kokoro

        t0 = time.perf_counter()
        logger.info(f"Initializing local Kokoro ONNX from {self._model_path}...")

        # Setup windows dll paths if nvidia toolkit packages exist in sys.path
        if sys.platform == "win32":
            import ctypes
            for path in sys.path:
                nvidia_dir = os.path.join(path, "nvidia")
                if os.path.exists(nvidia_dir) and os.path.isdir(nvidia_dir):
                    for folder in os.listdir(nvidia_dir):
                        pkg_bin = os.path.join(nvidia_dir, folder, "bin")
                        if os.path.exists(pkg_bin):
                            try:
                                os.add_dll_directory(pkg_bin)
                                os.environ["PATH"] = pkg_bin + os.path.pathsep + os.environ["PATH"]
                            except Exception:
                                pass

        available = ort.get_available_providers()
        preferred_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        providers = [p for p in preferred_providers if p in available]
        if not providers:
            providers = ["CPUExecutionProvider"]

        logger.info(f"ORT execution providers chosen: {providers}")
        session = ort.InferenceSession(self._model_path, providers=providers)
        self._kokoro = Kokoro.from_session(session, self._voices_path)
        logger.info(f"Local Kokoro model loaded successfully in {(time.perf_counter() - t0) * 1000:.0f}ms.")
        return self._kokoro

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = tts.DEFAULT_API_CONNECT_OPTIONS,
    ) -> tts.ChunkedStream:
        kokoro_instance = self._ensure_model_loaded()
        return LocalKokoroChunkedStream(
            tts=self,
            input_text=text,
            conn_options=conn_options,
            kokoro=kokoro_instance,
            voice=self._voice,
            speed=self._speed,
        )


class LocalKokoroChunkedStream(tts.ChunkedStream):
    def __init__(
        self,
        *,
        tts: tts.TTS,
        input_text: str,
        conn_options: APIConnectOptions,
        kokoro: Kokoro,
        voice: str,
        speed: float,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._kokoro = kokoro
        self._voice = voice
        self._speed = speed

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        clean_text = preprocess_text(self.input_text)
        if not clean_text or not any(ch.isalnum() for ch in clean_text):
            output_emitter.initialize(
                request_id=shortuuid(),
                sample_rate=SAMPLE_RATE,
                num_channels=NUM_CHANNELS,
                mime_type="audio/pcm",
            )
            # Push 0.1s silence for blank text
            output_emitter.push(bytes(4800))
            output_emitter.flush()
            return

        kokoro_voice, tts_lang = auto_select_voice_and_lang(clean_text, self._voice)
        tts_speed = self._speed
        if tts_lang == "hi":
            tts_speed = min(self._speed, 1.0)

        output_emitter.initialize(
            request_id=shortuuid(),
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            mime_type="audio/pcm",
        )

        try:
            # Stream chunk-by-chunk sentence-by-sentence
            async for samples, sr in self._kokoro.create_stream(
                clean_text, voice=kokoro_voice, speed=tts_speed, lang=tts_lang
            ):
                int16_samples = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
                output_emitter.push(int16_samples.tobytes())
        except Exception as e:
            logger.exception("In-memory Kokoro TTS synthesis failed:")
            raise e
        finally:
            output_emitter.flush()
