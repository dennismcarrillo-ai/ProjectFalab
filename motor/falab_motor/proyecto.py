"""Modelo de proyecto de falab.

Un proyecto es una carpeta con `proyecto.json` (mezcla y edición, no destructivas), los stems
en FLAC, los resultados de análisis y los picos de onda. La edición solo guarda *referencias*
a tramos de audio (clips), así que copiar, pegar o recortar no duplica muestras.
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import config

VERSION_FORMATO = 1


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def nuevo_id() -> str:
    return uuid.uuid4().hex[:12]


def validar_id(id_proyecto: str) -> str:
    """Impide que un identificador manipulado salga de la carpeta de proyectos."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", id_proyecto):
        raise ValueError("Identificador de proyecto no válido.")
    return id_proyecto


def carpeta(id_proyecto: str) -> Path:
    return config.DIR_PROYECTOS / validar_id(id_proyecto)


def eq_por_defecto() -> dict:
    return {
        "bajos": {"frecuencia": 120.0, "ganancia": 0.0},
        "medios": {"frecuencia": 1000.0, "ganancia": 0.0, "q": 1.0},
        "agudos": {"frecuencia": 8000.0, "ganancia": 0.0},
    }


def nueva_pista(id_pista: str, nombre: str, color: str, frames: int) -> dict:
    """Pista con un único clip que cubre toda su fuente."""
    return {
        "id": id_pista,
        "nombre": nombre,
        "instrumento": id_pista,
        "color": color,
        "volumen": 0.0,
        "paneo": 0.0,
        "silencio": False,
        "solo": False,
        "tono": 0,
        "reverb": 0.0,
        "eq": eq_por_defecto(),
        "clips": [{
            "id": nuevo_id(),
            "fuenteId": id_pista,
            "inicio": 0.0,
            "desplazamiento": 0.0,
            "duracion": frames / config.FRECUENCIA,
            "ganancia": 0.0,
            "fundidoEntrada": 0.0,
            "fundidoSalida": 0.0,
        }],
    }


def crear(nombre: str, medio_original: dict) -> dict:
    id_proyecto = nuevo_id()
    carpeta(id_proyecto).mkdir(parents=True, exist_ok=True)
    return {
        "version": VERSION_FORMATO,
        "id": id_proyecto,
        "nombre": nombre,
        "creado": _ahora(),
        "modificado": _ahora(),
        "frecuenciaMuestreo": config.FRECUENCIA,
        "duracion": 0.0,
        "medioOriginal": medio_original,
        "bpm": 120.0,
        "compas": 4,
        "velocidad": 1.0,
        "tono": 0,
        "volumenMaestro": 0.0,
        "metronomo": {"activo": False, "volumen": -6.0, "cuentaRegresiva": 0,
                      "cuentaTiempos": 4, "cuentaFigura": "negra"},
        "fuentes": [],
        "pistas": [],
        "avisos": [],
    }


def guardar(proyecto: dict) -> None:
    proyecto["modificado"] = _ahora()
    destino = carpeta(proyecto["id"]) / "proyecto.json"
    temporal = destino.with_suffix(".tmp")
    temporal.write_text(json.dumps(proyecto, ensure_ascii=False, indent=1), encoding="utf-8")
    temporal.replace(destino)  # Escritura atómica: nunca queda un JSON a medias.


def cargar(id_proyecto: str) -> dict:
    ruta = carpeta(id_proyecto) / "proyecto.json"
    if not ruta.exists():
        raise FileNotFoundError(f"No existe el proyecto {id_proyecto}.")
    return json.loads(ruta.read_text(encoding="utf-8"))


def _peso(ruta_carpeta: Path) -> tuple[int, int]:
    """(bytes totales, número de archivos) de la carpeta de un proyecto."""
    total, cuenta = 0, 0
    for ruta in ruta_carpeta.rglob("*"):
        if ruta.is_file():
            total += ruta.stat().st_size
            cuenta += 1
    return total, cuenta


def resumen(p: dict) -> dict:
    """Ficha del proyecto para la biblioteca: tamaño en disco, tempo y tonalidad."""
    from .pipeline import acordes

    peso, archivos = _peso(carpeta(p["id"]))
    analisis = leer_analisis(p["id"], "acordes", {}) or {}
    tonalidad = acordes.con_nombres(analisis)["tonalidad"] if analisis.get("acordes") else None
    # En un popurrí la tonalidad global no significa nada: para ordenar se usa la del arranque.
    inicial = acordes.tonalidad_inicial(analisis) if analisis.get("acordes") else None
    return {
        "id": p["id"], "nombre": p["nombre"], "modificado": p["modificado"],
        "duracion": p.get("duracion", 0.0), "bpm": p.get("bpm"),
        "pistas": len(p.get("pistas", [])), "peso": peso, "archivos": archivos,
        "tieneVideo": bool(p.get("medioOriginal", {}).get("tieneVideo")),
        "tonalidad": tonalidad, "tonalidadInicial": inicial,
    }


def listar() -> list[dict]:
    """Resumen de todos los proyectos locales, del más reciente al más antiguo."""
    resumenes = []
    if not config.DIR_PROYECTOS.exists():
        return resumenes
    for ruta in config.DIR_PROYECTOS.glob("*/proyecto.json"):
        try:
            resumenes.append(resumen(json.loads(ruta.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError, KeyError):
            continue
    return sorted(resumenes, key=lambda r: r["modificado"], reverse=True)


def eliminar(id_proyecto: str) -> None:
    shutil.rmtree(carpeta(id_proyecto), ignore_errors=True)


def ruta_fuente(proyecto: dict, id_fuente: str) -> Path:
    for fuente in proyecto["fuentes"]:
        if fuente["id"] == id_fuente:
            return carpeta(proyecto["id"]) / fuente["archivo"]
    raise KeyError(f"Fuente desconocida: {id_fuente}")


def leer_analisis(id_proyecto: str, nombre: str, por_defecto=None):
    ruta = carpeta(id_proyecto) / "analisis" / f"{nombre}.json"
    if not ruta.exists():
        return por_defecto
    return json.loads(ruta.read_text(encoding="utf-8"))


def escribir_analisis(id_proyecto: str, nombre: str, datos) -> None:
    ruta = carpeta(id_proyecto) / "analisis" / f"{nombre}.json"
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
