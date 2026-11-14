"""Render fuera de línea de la mezcla editada (clips, EQ, volumen, paneo, velocidad y tono).

Reproduce en NumPy exactamente la cadena del reproductor de la interfaz: los filtros son los
mismos bicuadráticos de la Web Audio API y el paneo es la misma ley de potencia constante, de
modo que lo exportado suena igual que lo escuchado.

Decisión de memoria: se renderiza pista a pista (nunca todas a la vez) y la exportación se hace
en este proceso y no en el navegador, que tendría que decodificar todos los stems en float32.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf
from scipy import signal

from .. import reverb
from ..config import FRECUENCIA

FUNDIDO_MINIMO = 0.003  # 3 ms en cada borde de clip para que los cortes no hagan «clic»


def db_a_lineal(db: float) -> float:
    return float(10 ** (db / 20))


# --- Ecualizador paramétrico de 3 bandas (coeficientes de la especificación Web Audio) ---

def _estante(frecuencia: float, ganancia_db: float, fs: int, agudo: bool) -> tuple[np.ndarray, np.ndarray]:
    A = 10 ** (ganancia_db / 40)
    w0 = 2 * np.pi * frecuencia / fs
    cos, alfa = np.cos(w0), np.sin(w0) / 2 * np.sqrt(2)
    raiz = 2 * alfa * np.sqrt(A)
    s = -1 if agudo else 1
    b = A * np.array([(A + 1) - s * (A - 1) * cos + raiz,
                      s * 2 * ((A - 1) - s * (A + 1) * cos),
                      (A + 1) - s * (A - 1) * cos - raiz])
    a = np.array([(A + 1) + s * (A - 1) * cos + raiz,
                  -s * 2 * ((A - 1) + s * (A + 1) * cos),
                  (A + 1) + s * (A - 1) * cos - raiz])
    return b / a[0], a / a[0]


def _campana(frecuencia: float, ganancia_db: float, q: float, fs: int) -> tuple[np.ndarray, np.ndarray]:
    A = 10 ** (ganancia_db / 40)
    w0 = 2 * np.pi * frecuencia / fs
    alfa = np.sin(w0) / (2 * max(q, 1e-3))
    b = np.array([1 + alfa * A, -2 * np.cos(w0), 1 - alfa * A])
    a = np.array([1 + alfa / A, -2 * np.cos(w0), 1 - alfa / A])
    return b / a[0], a / a[0]


def ecualizar(onda: np.ndarray, eq: dict, fs: int = FRECUENCIA) -> np.ndarray:
    bandas = []
    if abs(eq["bajos"]["ganancia"]) > 0.01:
        bandas.append(_estante(eq["bajos"]["frecuencia"], eq["bajos"]["ganancia"], fs, agudo=False))
    if abs(eq["medios"]["ganancia"]) > 0.01:
        bandas.append(_campana(eq["medios"]["frecuencia"], eq["medios"]["ganancia"], eq["medios"].get("q", 1.0), fs))
    if abs(eq["agudos"]["ganancia"]) > 0.01:
        bandas.append(_estante(eq["agudos"]["frecuencia"], eq["agudos"]["ganancia"], fs, agudo=True))
    for b, a in bandas:
        onda = signal.lfilter(b, a, onda, axis=0)
    return onda.astype(np.float32, copy=False)


def panear(onda: np.ndarray, paneo: float) -> np.ndarray:
    """Paneo estéreo de potencia constante, idéntico al StereoPannerNode con entrada estéreo."""
    if abs(paneo) < 1e-4:
        return onda
    izq, der = onda[:, 0], onda[:, 1]
    x = (paneo + 1 if paneo <= 0 else paneo) * np.pi / 2
    g_izq, g_der = np.cos(x), np.sin(x)
    if paneo <= 0:
        return np.stack([izq + der * g_izq, der * g_der], axis=1).astype(np.float32)
    return np.stack([izq * g_izq, der + izq * g_der], axis=1).astype(np.float32)


# --- Velocidad y tono independientes ---

def estirar_y_transponer(onda: np.ndarray, velocidad: float, semitonos: float, fs: int = FRECUENCIA) -> np.ndarray:
    """Cambia la velocidad sin alterar el tono y/o el tono sin alterar la velocidad.

    Usa Rubber Band (calidad de estudio) si está instalado; si no, el vocoder de fase de librosa.
    """
    cambia_velocidad = abs(velocidad - 1.0) > 1e-4
    cambia_tono = abs(semitonos) > 1e-4
    if not (cambia_velocidad or cambia_tono) or len(onda) == 0:
        return onda
    if shutil.which("rubberband"):
        import pyrubberband

        if cambia_velocidad:
            onda = pyrubberband.time_stretch(onda, fs, velocidad)
        if cambia_tono:
            onda = pyrubberband.pitch_shift(onda, fs, semitonos)
        return np.asarray(onda, dtype=np.float32)
    import librosa

    canales = onda.T
    if cambia_velocidad:
        canales = librosa.effects.time_stretch(canales, rate=velocidad)
    if cambia_tono:
        canales = librosa.effects.pitch_shift(canales, sr=fs, n_steps=semitonos)
    return np.ascontiguousarray(canales.T, dtype=np.float32)


# --- Montaje de clips ---

def duracion_total(proyecto: dict) -> float:
    finales = [c["inicio"] + c["duracion"] for p in proyecto["pistas"] for c in p["clips"]]
    return max(finales, default=0.0)


def montar_pista(pista: dict, proyecto: dict, dir_proyecto: Path, frames_totales: int) -> np.ndarray:
    """Coloca los clips de la pista en la línea de tiempo leyendo del disco solo cada tramo usado."""
    fs = FRECUENCIA
    salida = np.zeros((frames_totales, 2), dtype=np.float32)
    archivos = {f["id"]: dir_proyecto / f["archivo"] for f in proyecto["fuentes"]}
    for clip in pista["clips"]:
        inicio = int(round(clip["inicio"] * fs))
        frames = min(int(round(clip["duracion"] * fs)), frames_totales - inicio)
        if frames <= 0:
            continue
        with sf.SoundFile(str(archivos[clip["fuenteId"]])) as archivo:
            archivo.seek(min(int(round(clip["desplazamiento"] * fs)), archivo.frames))
            tramo = archivo.read(frames, dtype="float32", always_2d=True)
        if tramo.shape[1] == 1:
            tramo = np.repeat(tramo, 2, axis=1)
        tramo = tramo[:, :2] * db_a_lineal(clip.get("ganancia", 0.0))
        n = len(tramo)
        entrada = min(n, int(max(clip.get("fundidoEntrada", 0.0), FUNDIDO_MINIMO) * fs))
        salida_f = min(n, int(max(clip.get("fundidoSalida", 0.0), FUNDIDO_MINIMO) * fs))
        if entrada > 0:
            tramo[:entrada] *= np.linspace(0, 1, entrada, dtype=np.float32)[:, None]
        if salida_f > 0:
            tramo[n - salida_f:] *= np.linspace(1, 0, salida_f, dtype=np.float32)[:, None]
        salida[inicio:inicio + n] += tramo
    return salida


def pistas_audibles(proyecto: dict) -> list[dict]:
    hay_solo = any(p["solo"] for p in proyecto["pistas"])
    return [p for p in proyecto["pistas"] if (p["solo"] if hay_solo else not p["silencio"])]


def renderizar(proyecto: dict, dir_proyecto: Path, *, por_pistas: bool = False,
               progreso: Callable[[float], None] = lambda _: None) -> dict[str, np.ndarray]:
    """Devuelve {'mezcla': onda} o, con `por_pistas`, {id_pista: onda} (todas las pistas).

    Las ondas tienen forma (frames, 2) e incluyen edición, EQ, volumen, paneo, tono y velocidad.
    """
    frames = int(round(duracion_total(proyecto) * FRECUENCIA))
    if frames <= 0:
        raise ValueError("El proyecto no contiene audio que exportar.")
    velocidad = float(proyecto.get("velocidad", 1.0))
    tono_global = float(proyecto.get("tono", 0))
    maestro = db_a_lineal(proyecto.get("volumenMaestro", 0.0))
    pistas = proyecto["pistas"] if por_pistas else pistas_audibles(proyecto)

    resultado: dict[str, np.ndarray] = {}
    mezcla = None if por_pistas else np.zeros((frames, 2), dtype=np.float32)
    envio = None  # suma de lo que cada pista manda a la reverb (se crea solo si alguna la usa)
    for indice, pista in enumerate(pistas):
        onda = montar_pista(pista, proyecto, dir_proyecto, frames)
        onda = ecualizar(onda, pista["eq"])
        onda = panear(onda * db_a_lineal(pista["volumen"]), pista["paneo"])
        cantidad = float(pista.get("reverb", 0.0))
        if por_pistas:
            seca = estirar_y_transponer(onda, velocidad, tono_global + pista.get("tono", 0))
            if cantidad > 0:   # cada pista exportada lleva su propia reverb
                seca = seca + reverb.aplicar(seca) * cantidad
            resultado[pista["id"]] = seca * maestro
        else:
            # El tono propio de la pista se aplica antes de sumar; el global, una sola vez al final.
            transpuesta = estirar_y_transponer(onda, 1.0, pista.get("tono", 0))[:frames]
            mezcla += transpuesta
            if cantidad > 0:
                if envio is None:
                    envio = np.zeros((frames, 2), dtype=np.float32)
                envio += transpuesta * cantidad
        progreso((indice + 1) / (len(pistas) + 1))
    if not por_pistas:
        final = estirar_y_transponer(mezcla, velocidad, tono_global)
        if envio is not None:
            # Como en la app, la reverb actúa sobre el audio ya estirado (la sala no se estira).
            final = final + reverb.aplicar(estirar_y_transponer(envio, velocidad, tono_global))[: len(final)]
        resultado["mezcla"] = final * maestro
    # Protección contra saturación digital: si la suma supera 0 dBFS se baja todo por igual.
    pico = max((float(np.max(np.abs(o))) for o in resultado.values() if len(o)), default=0.0)
    if pico > 1.0:
        for clave in resultado:
            resultado[clave] = resultado[clave] / pico
    progreso(1.0)
    return resultado
