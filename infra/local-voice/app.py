import base64
import math
import os
import tempfile
import threading
from pathlib import Path

import av
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field


MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = float(os.getenv("VOICE_MAX_SECONDS", "300"))
MIME_SUFFIXES = {
    "audio/aac": ".aac",
    "audio/amr": ".amr",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


class TranscriptionRequest(BaseModel):
    audio_base64: str = Field(min_length=4)
    mime_type: str = Field(min_length=3, max_length=120)
    sha256: str | None = Field(default=None, max_length=200)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
model = WhisperModel(
    os.getenv("VOICE_MODEL", "base"),
    device="cpu",
    compute_type=os.getenv("VOICE_COMPUTE_TYPE", "int8"),
    cpu_threads=max(1, int(os.getenv("VOICE_CPU_THREADS", "4"))),
    download_root=os.getenv("HF_HOME", "/models"),
)
transcription_lock = threading.Lock()


def inspect_duration(path: str) -> float:
    with av.open(path) as container:
        if container.duration is not None:
            return float(container.duration / av.time_base)
        audio_streams = [stream for stream in container.streams if stream.type == "audio"]
        if not audio_streams:
            raise ValueError("audio stream missing")
        stream = audio_streams[0]
        if stream.duration is None or stream.time_base is None:
            return 0.0
        return float(stream.duration * stream.time_base)


def transcribe(path: str) -> dict:
    with transcription_lock:
        segments, info = model.transcribe(
            path,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=True,
        )
        materialized = list(segments)

    text = " ".join(segment.text.strip() for segment in materialized if segment.text.strip()).strip()
    average_log_probability = None
    if materialized:
        average_log_probability = sum(segment.avg_logprob for segment in materialized) / len(materialized)
    return {
        "ok": bool(text),
        "text": text[:4000],
        "language": info.language,
        "language_probability": round(float(info.language_probability), 6),
        "duration_seconds": round(float(info.duration), 3),
        "segment_count": len(materialized),
        "average_log_probability": (
            round(float(average_log_probability), 6)
            if average_log_probability is not None and math.isfinite(average_log_probability)
            else None
        ),
    }


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": os.getenv("VOICE_MODEL", "base")}


@app.post("/transcribe")
def transcribe_audio(payload: TranscriptionRequest) -> dict:
    mime_type = payload.mime_type.split(";", 1)[0].strip().lower()
    suffix = MIME_SUFFIXES.get(mime_type)
    if suffix is None:
        raise HTTPException(status_code=415, detail="unsupported audio type")
    try:
        audio = base64.b64decode(payload.audio_base64, validate=True)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="invalid base64 audio")
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio size rejected")

    temporary_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary.write(audio)
            temporary_path = temporary.name
        duration = inspect_duration(temporary_path)
        if duration <= 0 or duration > MAX_AUDIO_SECONDS:
            raise HTTPException(status_code=413, detail="audio duration rejected")
        return transcribe(temporary_path)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=422, detail="audio could not be transcribed")
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)
