"""Lectura y conversión de medios con FFmpeg (audio y video) y utilidades de E/S de audio."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import CANALES, FRAMES_POR_PICO, FRECUENCIA


class ErrorMedios(RuntimeError):
    """Fallo al leer o convertir un archivo de audio o video."""


def _binario(nombre: str) -> str:
    ruta = shutil.which(nombre)
    if not ruta:
        raise ErrorMedios(
            f"No se encontró «{nombre}». Instala FFmpeg (en macOS: brew install ffmpeg)."
        )
    return ruta


def ejecutar_ffmpeg(argumentos: list[str]) -> None:
    """Ejecuta ffmpeg en modo silencioso y lanza ErrorMedios con el detalle si falla."""
    orden = [_binario("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", *argumentos]
    proceso = subprocess.run(orden, capture_output=True, text=True)
    if proceso.returncode != 0:
        raise ErrorMedios(proceso.stderr.strip() or "FFmpeg terminó con error.")


def sondear(ruta: Path) -> dict:
    """Devuelve duración y si el archivo contiene pistas de audio y de video."""
    orden = [
        _binario("ffprobe"), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(ruta),
    ]
    proceso = subprocess.run(orden, capture_output=True, text=True)
    if proceso.returncode != 0:
        raise ErrorMedios(f"No se pudo leer el archivo: {proceso.stderr.strip()}")
    datos = json.loads(proceso.stdout)
    flujos = datos.get("streams", [])
    # Las carátulas incrustadas en MP3/FLAC aparecen como «video»; no cuentan como video real.
    hay_video = any(
        f.get("codec_type") == "video" and not f.get("disposition", {}).get("attached_pic")
        for f in flujos
    )
    hay_audio = any(f.get("codec_type") == "audio" for f in flujos)
    return {
        "duracion": float(datos.get("format", {}).get("duration", 0.0) or 0.0),
        "tieneVideo": hay_video,
        "tieneAudio": hay_audio,
    }


def extraer_audio(origen: Path, destino: Path) -> None:
    """Convierte cualquier formato admitido a FLAC estéreo de 44,1 kHz / 24 bits."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    ejecutar_ffmpeg([
        "-i", str(origen), "-vn", "-map", "0:a:0",
        "-ac", str(CANALES), "-ar", str(FRECUENCIA),
        "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(destino),
    ])


def leer_audio(ruta: Path) -> np.ndarray:
    """Lee un archivo completo como float32 con forma (frames, 2)."""
    datos, fs = sf.read(str(ruta), dtype="float32", always_2d=True)
    if fs != FRECUENCIA:
        raise ErrorMedios(f"{ruta.name}: se esperaban {FRECUENCIA} Hz y tiene {fs} Hz.")
    return a_estereo(datos)


def a_estereo(datos: np.ndarray) -> np.ndarray:
    if datos.shape[1] == 1:
        return np.repeat(datos, 2, axis=1)
    return datos[:, :2]


def escribir_flac(ruta: Path, datos: np.ndarray) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(ruta), np.clip(datos, -1.0, 1.0), FRECUENCIA, format="FLAC", subtype="PCM_24")


def leer_pcm16(ruta: Path, inicio: int, frames: int) -> bytes:
    """Devuelve un tramo del archivo como PCM de 16 bits entrelazado (para el reproductor).

    Solo se decodifica el tramo pedido: la interfaz nunca mantiene una pista entera en memoria.
    """
    with sf.SoundFile(str(ruta)) as archivo:
        inicio = max(0, min(inicio, archivo.frames))
        archivo.seek(inicio)
        datos = archivo.read(frames, dtype="int16", always_2d=True)
    if datos.shape[1] == 1:
        datos = np.repeat(datos, 2, axis=1)
    return np.ascontiguousarray(datos[:, :2]).tobytes()


def calcular_picos(ruta: Path, destino: Path) -> None:
    """Genera el archivo de picos (pares mín/máx en int8) leyendo el audio por bloques."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    bloque = FRAMES_POR_PICO * 4096
    with sf.SoundFile(str(ruta)) as archivo, open(destino, "wb") as salida:
        while True:
            datos = archivo.read(bloque, dtype="float32", always_2d=True)
            if len(datos) == 0:
                break
            mono = datos.mean(axis=1)
            resto = (-len(mono)) % FRAMES_POR_PICO
            if resto:
                mono = np.pad(mono, (0, resto))
            cuadros = mono.reshape(-1, FRAMES_POR_PICO)
            pares = np.stack([cuadros.min(axis=1), cuadros.max(axis=1)], axis=1)
            salida.write((np.clip(pares, -1, 1) * 127).astype(np.int8).tobytes())


def frames_de(ruta: Path) -> int:
    with sf.SoundFile(str(ruta)) as archivo:
        return archivo.frames


def nivel_rms_db(ruta: Path) -> float:
    """Nivel RMS global en dBFS, calculado por bloques (sirve para detectar stems vacíos)."""
    suma, total = 0.0, 0
    with sf.SoundFile(str(ruta)) as archivo:
        for bloque in archivo.blocks(blocksize=1 << 18, dtype="float32", always_2d=True):
            suma += float(np.sum(bloque.astype(np.float64) ** 2))
            total += bloque.size
    if total == 0 or suma == 0:
        return -120.0
    return float(10 * np.log10(suma / total))
