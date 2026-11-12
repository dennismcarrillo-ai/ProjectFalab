"""Guías de voz para el directo: una pista que anuncia cada sección y cuenta el compás de entrada.

Ejemplo, un compás antes del estribillo y a tempo:  «Coro, dos, tres, cuatro».

La voz se sintetiza en local (sin red): en macOS con el sintetizador del sistema (`say`) y, en
otros equipos, con espeak-ng si está instalado. Cada palabra se genera una vez, se le recorta el
silencio inicial (para que caiga justo en el pulso) y se coloca sobre el mapa de pulsos, de modo
que las guías siguen las fluctuaciones de tempo igual que el metrónomo.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from . import config, medios, proyecto as modelo
from .pipeline import estructura
from .trabajos import Trabajo

NUMEROS = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce"]
VOCES_PREFERIDAS = ["Mónica", "Monica", "Paulina", "Jorge", "Marisol", "Diego", "Juan"]
COLOR = "#94a3b8"


def _voz_en_espanol() -> str | None:
    """Nombre de una voz en español instalada en macOS, o None para usar la predeterminada."""
    try:
        listado = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    disponibles = [linea.split("  ")[0].strip() for linea in listado.splitlines() if " es_" in linea or " es-" in linea]
    for preferida in VOCES_PREFERIDAS:
        for voz in disponibles:
            if voz.startswith(preferida):
                return voz
    return disponibles[0] if disponibles else None


def sintetizar(texto: str) -> np.ndarray:
    """Devuelve la palabra hablada como onda mono a 44,1 kHz, sin silencio inicial."""
    with tempfile.TemporaryDirectory() as carpeta:
        salida = Path(carpeta) / "voz.wav"
        if shutil.which("say"):
            orden = ["say", "-o", str(salida), "--data-format=LEI16@44100"]
            voz = _voz_en_espanol()
            if voz:
                orden += ["-v", voz]
            orden.append(texto)
        elif shutil.which("espeak-ng"):
            orden = ["espeak-ng", "-v", "es", "-s", "165", "-w", str(salida), texto]
        else:
            raise RuntimeError("No hay ningún sintetizador de voz disponible en este equipo.")
        proceso = subprocess.run(orden, capture_output=True, text=True, timeout=60)
        if proceso.returncode != 0 or not salida.exists():
            raise RuntimeError(f"No se pudo sintetizar «{texto}»: {proceso.stderr.strip()}")
        onda, fs = sf.read(str(salida), dtype="float32", always_2d=True)
    onda = onda.mean(axis=1)
    if fs != config.FRECUENCIA:
        import librosa

        onda = librosa.resample(onda, orig_sr=fs, target_sr=config.FRECUENCIA)
    return recortar(onda)


def recortar(onda: np.ndarray) -> np.ndarray:
    """Quita el silencio de los extremos y normaliza el volumen."""
    pico = float(np.max(np.abs(onda))) if len(onda) else 0.0
    if pico < 1e-4:
        return np.zeros(0, dtype=np.float32)
    sonoro = np.flatnonzero(np.abs(onda) > 0.02 * pico)
    onda = onda[max(0, sonoro[0] - 64): sonoro[-1] + 2205]
    return (onda / pico * 0.8).astype(np.float32)


def planificar(secciones: list[dict], mapa: dict) -> list[tuple[float, str]]:
    """Devuelve [(instante, palabra)]: el nombre de cada sección y la cuenta del compás previo."""
    pulsos = mapa.get("pulsos", [])
    if len(pulsos) < 4:
        return []
    tiempos = np.array([p["t"] for p in pulsos])
    avisos: list[tuple[float, str]] = []
    for seccion in secciones:
        llegada = int(np.searchsorted(tiempos, seccion["inicio"] - 0.06))
        if llegada >= len(pulsos):
            continue
        # Tiempos del compás que precede a la sección (puede ser distinto del de la sección).
        previo = pulsos[llegada - 1] if llegada > 0 else None
        cuantos = int(previo.get("tiempos", mapa.get("compas", 4))) if previo else 0
        salida = llegada - cuantos
        if previo is None or salida < 0:
            continue  # la primera sección no tiene compás previo: la cubre la cuenta regresiva
        avisos.append((float(tiempos[salida]), seccion["nombre"]))
        for n in range(1, cuantos):
            avisos.append((float(tiempos[salida + n]), NUMEROS[n] if n < len(NUMEROS) else str(n + 1)))
    return avisos


def generar(id_proyecto: str, trabajo: Trabajo) -> dict:
    """Crea (o regenera) la pista «Guías» del proyecto a partir de su estructura."""
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    secciones = modelo.leer_analisis(id_proyecto, "estructura", {}).get("secciones", [])
    if not secciones:
        raise ValueError("Primero hay que detectar o marcar la estructura de la canción.")
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"pulsos": []})
    mapa = estructura.aplicar_compases(mapa, secciones)
    avisos = planificar(secciones, mapa)
    if not avisos:
        raise ValueError("No hay mapa de pulsos sobre el que colocar las guías.")

    trabajo.informar(0.05, "Sintetizando la voz")
    palabras: dict[str, np.ndarray] = {}
    unicas = sorted({texto for _, texto in avisos})
    for i, texto in enumerate(unicas):
        trabajo.informar(0.05 + 0.6 * i / len(unicas), f"Sintetizando «{texto}»")
        palabras[texto] = sintetizar(texto)

    trabajo.informar(0.7, "Montando la pista de guías")
    fs = config.FRECUENCIA
    frames = int(round(p["duracion"] * fs))
    pista_mono = np.zeros(frames, dtype=np.float32)
    ocupado_hasta = -1.0
    for instante, texto in avisos:
        onda = palabras[texto]
        # Si el nombre de la sección es largo y aún se está diciendo, se omite ese número.
        if instante < ocupado_hasta - 0.05:
            continue
        inicio = int(round(instante * fs))
        n = min(len(onda), frames - inicio)
        if n <= 0:
            continue
        pista_mono[inicio:inicio + n] += onda[:n]
        ocupado_hasta = instante + len(onda) / fs if texto not in NUMEROS else -1.0

    # Cada generación usa un identificador nuevo: así ningún reproductor reutiliza audio antiguo.
    anteriores = [f for f in p["fuentes"] if f["id"].startswith("guias")]
    version = 1 + max([int(f["id"].split("_")[1]) for f in anteriores if "_" in f["id"]], default=0)
    id_fuente = f"guias_{version}"
    ruta = carpeta / "stems" / f"{id_fuente}.flac"
    medios.escribir_flac(ruta, np.stack([pista_mono, pista_mono], axis=1))
    medios.calcular_picos(ruta, carpeta / "picos" / f"{id_fuente}.bin")
    for fuente in anteriores:
        (carpeta / fuente["archivo"]).unlink(missing_ok=True)
        (carpeta / "picos" / f"{fuente['id']}.bin").unlink(missing_ok=True)

    antigua = next((x for x in p["pistas"] if x.get("instrumento") == "guias"), None)
    nueva = modelo.nueva_pista("guias", "Guías", COLOR, frames)
    nueva["clips"][0]["fuenteId"] = id_fuente
    if antigua:  # se conserva la mezcla que el usuario ya le había dado
        for campo in ("volumen", "paneo", "silencio", "solo", "eq"):
            nueva[campo] = antigua[campo]
    p["fuentes"] = [f for f in p["fuentes"] if not f["id"].startswith("guias")]
    p["fuentes"].append({"id": id_fuente, "archivo": ruta.relative_to(carpeta).as_posix(), "frames": frames, "canales": 2})
    p["pistas"] = [x for x in p["pistas"] if x.get("instrumento") != "guias"] + [nueva]
    modelo.guardar(p)
    return {"avisos": len(avisos), "pista": "guias"}
