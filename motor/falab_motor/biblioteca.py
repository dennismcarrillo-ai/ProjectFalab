"""Biblioteca del usuario: playlists, ajustes y cola de sincronización con Drive.

Vive en un único archivo JSON pequeño (~/Falab/config/biblioteca.json). Los proyectos no se
duplican: una playlist es solo una lista ordenada de identificadores de proyecto.
"""
from __future__ import annotations

import json
import threading
import uuid

from . import config, proyecto as modelo

ORDENES = {"manual", "alfabetico", "duracion", "bpm", "tonalidad", "quintas"}
_cerrojo = threading.RLock()


def _ruta():
    return config.DIR_CONFIG / "biblioteca.json"


def _vacia() -> dict:
    return {"playlists": [], "ajustes": {"driveAutomatico": False}, "pendientesDrive": {}}


def cargar() -> dict:
    with _cerrojo:
        try:
            datos = json.loads(_ruta().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _vacia()
        base = _vacia()
        base["playlists"] = datos.get("playlists", [])
        base["ajustes"].update(datos.get("ajustes", {}))
        base["pendientesDrive"] = datos.get("pendientesDrive", {})
        return base


def guardar(datos: dict) -> None:
    with _cerrojo:
        ruta = _ruta()
        ruta.parent.mkdir(parents=True, exist_ok=True)
        temporal = ruta.with_suffix(".tmp")
        temporal.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
        temporal.replace(ruta)


def fijar_playlists(playlists: list[dict]) -> list[dict]:
    """Sustituye todas las playlists tras validarlas. Devuelve la lista ya normalizada."""
    limpias = []
    for playlist in playlists:
        nombre = str(playlist.get("nombre", "")).strip()
        if not nombre:
            raise ValueError("Cada playlist necesita un nombre.")
        orden = playlist.get("orden", "manual")
        if orden not in ORDENES:
            raise ValueError(f"Orden de playlist no válido: {orden}")
        proyectos = []
        for id_proyecto in playlist.get("proyectos", []):
            modelo.validar_id(id_proyecto)
            if id_proyecto not in proyectos:
                proyectos.append(id_proyecto)
        limpias.append({
            "id": str(playlist.get("id") or uuid.uuid4().hex[:10]),
            "nombre": nombre[:120],
            "orden": orden,
            "proyectos": proyectos,
        })
    with _cerrojo:
        datos = cargar()
        datos["playlists"] = limpias
        guardar(datos)
    return limpias


def olvidar_proyecto(id_proyecto: str) -> None:
    """Quita un proyecto eliminado de todas las playlists y de la cola de Drive."""
    with _cerrojo:
        datos = cargar()
        for playlist in datos["playlists"]:
            playlist["proyectos"] = [p for p in playlist["proyectos"] if p != id_proyecto]
        datos["pendientesDrive"].pop(id_proyecto, None)
        guardar(datos)


def fijar_ajustes(parcial: dict) -> dict:
    with _cerrojo:
        datos = cargar()
        if "driveAutomatico" in parcial:
            datos["ajustes"]["driveAutomatico"] = bool(parcial["driveAutomatico"])
        if "pedal" in parcial:
            # Asignaciones del pedal: {acción: {tipo: 'tecla'|'midi', ...}}. Las interpreta la interfaz.
            pedal = parcial["pedal"]
            if not isinstance(pedal, dict) or len(json.dumps(pedal)) > 4000:
                raise ValueError("Asignación de pedal no válida.")
            datos["ajustes"]["pedal"] = pedal
        guardar(datos)
        return datos["ajustes"]
