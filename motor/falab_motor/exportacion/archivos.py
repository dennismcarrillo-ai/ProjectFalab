"""Escritura de las exportaciones de audio (WAV, FLAC, MP3) y de video con la nueva mezcla."""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from ..config import FRECUENCIA
from ..medios import ejecutar_ffmpeg

FORMATOS_AUDIO = {"wav", "flac", "mp3"}


def escribir_audio(onda: np.ndarray, destino: Path, formato: str) -> Path:
    """WAV y FLAC a 24 bits (Hi-Fi); MP3 a 320 kbps mediante FFmpeg."""
    formato = formato.lower()
    if formato not in FORMATOS_AUDIO:
        raise ValueError(f"Formato de audio no admitido: {formato}")
    destino = destino.with_suffix(f".{formato}")
    destino.parent.mkdir(parents=True, exist_ok=True)
    onda = np.clip(onda, -1.0, 1.0)
    if formato == "mp3":
        with tempfile.TemporaryDirectory() as carpeta:
            temporal = Path(carpeta) / "mezcla.wav"
            sf.write(str(temporal), onda, FRECUENCIA, subtype="PCM_24")
            ejecutar_ffmpeg(["-i", str(temporal), "-codec:a", "libmp3lame", "-b:a", "320k", str(destino)])
    else:
        sf.write(str(destino), onda, FRECUENCIA, format=formato.upper(), subtype="PCM_24")
    return destino


def escribir_video(video_original: Path, onda: np.ndarray, destino: Path, velocidad: float = 1.0) -> Path:
    """Sustituye el audio del video original por la mezcla.

    A velocidad normal la imagen se copia sin recomprimir (rápido y sin pérdida). Si la mezcla
    se exporta a otra velocidad, la imagen se reajusta para seguir sincronizada.
    """
    if not video_original.exists():
        raise FileNotFoundError(f"No se encuentra el video original: {video_original}")
    destino = destino.with_suffix(".mp4")
    destino.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as carpeta:
        temporal = Path(carpeta) / "mezcla.wav"
        sf.write(str(temporal), np.clip(onda, -1.0, 1.0), FRECUENCIA, subtype="PCM_24")
        argumentos = ["-i", str(video_original), "-i", str(temporal), "-map", "0:v:0", "-map", "1:a:0"]
        if abs(velocidad - 1.0) < 1e-4:
            argumentos += ["-c:v", "copy"]
        else:
            argumentos += ["-filter:v", f"setpts=PTS/{velocidad:.6f}", "-c:v", "libx264", "-crf", "18",
                           "-preset", "medium", "-pix_fmt", "yuv420p"]
        argumentos += ["-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(destino)]
        ejecutar_ffmpeg(argumentos)
    return destino
