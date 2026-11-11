"""Configuración global del motor."""
from __future__ import annotations

import os
from pathlib import Path

# Frecuencia de trabajo única: es la nativa de Demucs y evita remuestreos en la interfaz.
FRECUENCIA = 44100
CANALES = 2

# Carpeta raíz de datos del usuario (proyectos, credenciales, caché).
DIR_DATOS = Path(os.environ.get("FALAB_DIR", Path.home() / "Falab"))
DIR_PROYECTOS = DIR_DATOS / "proyectos"
DIR_CONFIG = DIR_DATOS / "config"

# Nombre de la carpeta de sincronización en Google Drive.
CARPETA_DRIVE = "falab_projects"

# Un pico (mínimo, máximo) por cada bloque de este tamaño; lo usa la interfaz para dibujar ondas
# sin tener que decodificar el audio.
FRAMES_POR_PICO = 256

# Fuentes de Demucs (htdemucs_6s) -> identificador en español, nombre visible y color de pista.
STEMS = {
    "vocals": ("voz", "Voz", "#f472b6"),
    "bass": ("bajo", "Bajo", "#a78bfa"),
    "drums": ("bateria", "Batería", "#fb923c"),
    "guitar": ("guitarra", "Guitarra", "#facc15"),
    "piano": ("piano", "Piano", "#38bdf8"),
    "other": ("otros", "Otros", "#5eead4"),
}
ORDEN_PISTAS = ["voz", "bajo", "bateria", "guitarra", "piano", "otros"]

EXTENSIONES_ADMITIDAS = {".mp3", ".wav", ".flac", ".ogg", ".aac", ".m4a", ".mp4", ".mov", ".mkv"}


def asegurar_carpetas() -> None:
    """Crea las carpetas de datos si aún no existen."""
    for carpeta in (DIR_PROYECTOS, DIR_CONFIG):
        carpeta.mkdir(parents=True, exist_ok=True)
