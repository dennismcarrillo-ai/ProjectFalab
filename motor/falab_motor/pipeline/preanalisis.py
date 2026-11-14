"""Pre-análisis rápido antes de procesar una canción.

Separa con Demucs tres extractos cortos (en un equipo actual, unos segundos) y mide sobre esos
stems qué hay realmente en la canción. Con eso, la interfaz propone qué pistas crear: no tiene
sentido una pista de piano si no hay piano, ni separar coros si la voz es una sola.

Se mide sobre extractos ya separados porque, desde la mezcla completa, no se puede saber con
fiabilidad si hay coros o si hay una guitarra solista además de la rítmica.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from .. import config, medios
from ..trabajos import Trabajo
from . import division

SEGUNDOS_POR_EXTRACTO = 15
POSICIONES = (0.25, 0.5, 0.75)        # fracciones de la canción donde se toman los extractos
UMBRAL_PRESENCIA_DB = -42.0           # por debajo, el instrumento prácticamente no suena
UMBRAL_COROS_DB = -14.0               # lados/centro de la voz a partir del cual hay coros separables
RANGO_GUITARRAS_DB = (-12.0, 10.0)    # lados/centro de la guitarra: hay material en el centro Y a los lados


def _nivel_db(onda: np.ndarray) -> float:
    energia = float(np.mean(onda.astype(np.float64) ** 2)) if len(onda) else 0.0
    return float(10 * np.log10(energia)) if energia > 0 else -120.0


def medir(stems: dict[str, np.ndarray]) -> dict:
    """Decide qué proponer a partir de los stems de los extractos."""
    mezcla = sum(stems.values())
    nivel_mezcla = _nivel_db(mezcla)
    instrumentos = {}
    for id_stem in config.STEMS_DEMUCS:
        nivel = _nivel_db(stems[id_stem]) if id_stem in stems else -120.0
        instrumentos[id_stem] = {
            "nivelDb": round(nivel, 1),
            # Presente si suena con cuerpo propio y no es un residuo respecto a la mezcla.
            "presente": bool(nivel > UMBRAL_PRESENCIA_DB and nivel > nivel_mezcla - 30.0),
        }

    def anchura(id_stem: str) -> float | None:
        if not instrumentos.get(id_stem, {}).get("presente"):
            return None
        centro, lados = division.separar_centro_lados(stems[id_stem])
        return round(division.relacion_lados_centro_db(centro, lados), 1)

    anchura_voz, anchura_guitarra = anchura("voz"), anchura("guitarra")
    return {
        "instrumentos": instrumentos,
        "coros": {"anchuraDb": anchura_voz, "sugerido": anchura_voz is not None and anchura_voz > UMBRAL_COROS_DB},
        "guitarras": {"anchuraDb": anchura_guitarra,
                      "sugerido": anchura_guitarra is not None
                      and RANGO_GUITARRAS_DB[0] < anchura_guitarra < RANGO_GUITARRAS_DB[1]},
    }


def preanalizar(ruta_medio: Path, trabajo: Trabajo) -> dict:
    """Devuelve {disponible, duracion, tieneVideo, instrumentos, coros, guitarras, corosNeuronal}."""
    from importlib.util import find_spec

    ruta_medio = Path(ruta_medio).expanduser()
    if not ruta_medio.exists():
        raise FileNotFoundError(f"No se encuentra el archivo: {ruta_medio}")
    trabajo.informar(0.02, "Leyendo el archivo")
    info = medios.sondear(ruta_medio)
    if not info["tieneAudio"]:
        raise ValueError("El archivo no contiene ninguna pista de audio.")
    base = {"duracion": info["duracion"], "tieneVideo": info["tieneVideo"],
            "corosNeuronal": division.ejecutable_neuronal() is not None}
    if find_spec("demucs") is None:
        return {**base, "disponible": False}

    from . import separacion

    with tempfile.TemporaryDirectory() as carpeta_temporal:
        carpeta = Path(carpeta_temporal)
        # Un único archivo con los tres extractos seguidos: una sola pasada de Demucs.
        duracion = max(info["duracion"], 1.0)
        tramo = min(SEGUNDOS_POR_EXTRACTO, duracion / 3)
        partes = []
        for i, fraccion in enumerate(POSICIONES):
            trabajo.informar(0.05 + 0.1 * i, "Tomando extractos de la canción")
            parte = carpeta / f"extracto_{i}.flac"
            inicio = max(0.0, fraccion * duracion - tramo / 2)
            medios.ejecutar_ffmpeg(["-ss", f"{inicio:.2f}", "-t", f"{tramo:.2f}", "-i", str(ruta_medio), "-vn",
                                    "-map", "0:a:0", "-ac", "2", "-ar", str(config.FRECUENCIA), str(parte)])
            partes.append(sf.read(str(parte), dtype="float32", always_2d=True)[0])
        extractos = carpeta / "extractos.flac"
        medios.escribir_flac(extractos, np.concatenate(partes))
        rutas = separacion.separar(extractos, carpeta / "stems",
                                   progreso=trabajo.subetapa(0.35, 0.9, "Escuchando qué instrumentos hay"))
        stems = {id_stem: sf.read(str(ruta), dtype="float32", always_2d=True)[0] for id_stem, ruta in rutas.items()}
    trabajo.informar(0.95, "Preparando las sugerencias")
    return {**base, "disponible": True, **medir(stems)}
