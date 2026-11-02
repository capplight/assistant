"""Audio + key frames from videos the user sent us (never from Instagram/TikTok URLs).

Needs ffmpeg/ffprobe on PATH; without them the item is processed from its caption only.
"""

import asyncio
import logging
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

FRAMES = 4
STEP_TIMEOUT = 90.0


@dataclass
class MediaParts:
    audio: bytes | None = None  # mono 16 kHz WAV
    frames: list[bytes] = field(default_factory=list)  # JPEG


def frame_times(duration: float, n: int = FRAMES) -> list[float]:
    """Evenly spaced timestamps, avoiding the very first/last frame (often black)."""
    if duration <= 0:
        return [0.0]
    return [round(duration * (i + 0.5) / n, 3) for i in range(n)]


async def _run(*args: str) -> tuple[int, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), STEP_TIMEOUT)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, b""
    return proc.returncode or 0, out


class MediaExtractor:
    def __init__(self, ffmpeg: str | None = None, ffprobe: str | None = None) -> None:
        self._ffmpeg = ffmpeg or shutil.which("ffmpeg")
        self._ffprobe = ffprobe or shutil.which("ffprobe")

    @property
    def available(self) -> bool:
        return bool(self._ffmpeg)

    async def extract(self, video: bytes, suffix: str = ".mp4") -> MediaParts:
        if not self._ffmpeg:
            log.warning("ffmpeg not found; processing video from caption only")
            return MediaParts()
        with tempfile.TemporaryDirectory(prefix="item-") as tmp:
            src = Path(tmp) / f"in{suffix or '.mp4'}"
            src.write_bytes(video)
            duration = await self._duration(src)

            audio_path = Path(tmp) / "audio.wav"
            code, _ = await _run(
                self._ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-i", str(src),
                "-vn", "-ac", "1", "-ar", "16000", str(audio_path),
            )  # fmt: skip
            audio = audio_path.read_bytes() if code == 0 and audio_path.exists() else None

            frames: list[bytes] = []
            for i, t in enumerate(frame_times(duration)):
                out = Path(tmp) / f"f{i}.jpg"
                code, _ = await _run(
                    self._ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-ss", str(t),
                    "-i", str(src), "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2",
                    "-q:v", "4", str(out),
                )  # fmt: skip
                if code == 0 and out.exists():
                    frames.append(out.read_bytes())
            return MediaParts(audio=audio, frames=frames)

    async def _duration(self, src: Path) -> float:
        if not self._ffprobe:
            return 0.0
        code, out = await _run(
            self._ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(src),
        )  # fmt: skip
        try:
            return float(out.decode().strip()) if code == 0 else 0.0
        except ValueError:
            return 0.0
