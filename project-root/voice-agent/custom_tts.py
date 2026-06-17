"""
custom_tts.py — Wraps the local Kokoro TTS service as a native livekit-agents TTS plugin.
Reads WAV audio, slices into 20ms PCM frames, and pushes to the LiveKit room track.
"""

import asyncio
import io
import logging
import wave

import aiohttp
import numpy as np
from livekit import rtc
from livekit.agents import tts, utils

logger = logging.getLogger("kokoro-tts-adapter")


class KokoroTTS(tts.TTS):
    """
    LiveKit TTS plugin that calls the local Kokoro ONNX FastAPI service.
    Compatible with livekit-agents >= 0.10.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8766",
        voice: str    = "af_bella",
        speed: float  = 1.1,
    ):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False)
        )
        self._base_url = base_url.rstrip("/")
        self._voice    = voice
        self._speed    = speed

    def synthesize(self, text: str) -> tts.SynthesizeStream:
        return _KokoroStream(
            tts=self,
            text=text,
            base_url=self._base_url,
            voice=self._voice,
            speed=self._speed,
        )


class _KokoroStream(tts.SynthesizeStream):

    def __init__(
        self,
        tts: KokoroTTS,
        text: str,
        base_url: str,
        voice: str,
        speed: float,
    ):
        super().__init__(tts=tts)
        self._text     = text
        self._base_url = base_url
        self._voice    = voice
        self._speed    = speed

    async def _main_task(self) -> None:
        request_id = utils.shortuuid()
        segment_id = utils.shortuuid()

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self._base_url}/tts",
                    json={
                        "text":     self._text,
                        "voice":    self._voice,
                        "speed":    self._speed,
                        "language": "en-us",
                    },
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    resp.raise_for_status()
                    wav_bytes = await resp.read()

            # ── Parse WAV header ──────────────────────────────────────────
            with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
                sample_rate = wf.getframerate()
                n_channels  = wf.getnchannels()
                n_frames    = wf.getnframes()
                raw_pcm     = wf.readframes(n_frames)

            # Convert int16 → float32
            samples = np.frombuffer(raw_pcm, dtype=np.int16).astype(np.float32) / 32767.0

            # Downmix to mono if stereo
            if n_channels == 2:
                samples = samples.reshape(-1, 2).mean(axis=1)

            # ── Slice into 20ms WebRTC frames and emit ────────────────────
            FRAME_SAMPLES = int(sample_rate * 0.02)   # 20ms

            for i in range(0, len(samples), FRAME_SAMPLES):
                chunk = samples[i : i + FRAME_SAMPLES]
                if len(chunk) < FRAME_SAMPLES:
                    chunk = np.pad(chunk, (0, FRAME_SAMPLES - len(chunk)))

                audio_frame = rtc.AudioFrame(
                    data=chunk.tobytes(),
                    sample_rate=sample_rate,
                    num_channels=1,
                    samples_per_channel=FRAME_SAMPLES,
                )

                self._event_ch.send_nowait(
                    tts.SynthesisEvent(
                        type=tts.SynthesisEventType.AUDIO,
                        audio=tts.SynthesisAudio(
                            frame=audio_frame,
                            request_id=request_id,
                            segment_id=segment_id,
                        ),
                    )
                )

        except aiohttp.ClientError as e:
            logger.error(f"Kokoro TTS HTTP error: {e}")
        except Exception as e:
            logger.error(f"Kokoro TTS unexpected error: {e}", exc_info=True)
        finally:
            # Always signal completion (even on error) to unblock the pipeline
            self._event_ch.send_nowait(
                tts.SynthesisEvent(type=tts.SynthesisEventType.FINISHED)
            )