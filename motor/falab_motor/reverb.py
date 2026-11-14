"""Reverb por convolución, idéntica en la app y en la exportación.

La respuesta al impulso (la «huella» de una sala) se genera aquí de forma determinista: la
interfaz la descarga y la usa en un ConvolverNode, y el render de exportación convoluciona con
esta misma señal. Así la reverb que se oye al mezclar es exactamente la que queda en el archivo.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from scipy import signal

from .config import FRECUENCIA

SEGUNDOS = 2.4
PRERRETARDO = 0.012


@lru_cache(maxsize=1)
def respuesta_al_impulso() -> np.ndarray:
    """Sala mediana: ruido con caída exponencial, más oscuro cuanto más tarde. Forma (frames, 2)."""
    fs = FRECUENCIA
    n = int(SEGUNDOS * fs)
    t = np.arange(n) / fs
    aleatorio = np.random.default_rng(20240)          # semilla fija: siempre la misma sala
    ruido = aleatorio.standard_normal((n, 2))
    # RT60 ≈ 1,6 s en graves y ≈ 0,8 s en agudos (las salas absorben antes los agudos).
    b, a = signal.butter(2, 2500 / (fs / 2), "low")
    graves = signal.lfilter(b, a, ruido, axis=0)
    agudos = ruido - graves
    cola = graves * np.exp(-6.91 * t / 1.6)[:, None] + agudos * np.exp(-6.91 * t / 0.8)[:, None]
    cola *= np.minimum(1.0, t / 0.004)[:, None]        # ataque suave, sin clic
    retardo = int(PRERRETARDO * fs)
    ir = np.vstack([np.zeros((retardo, 2)), cola])[:n]
    ir /= np.sqrt(np.sum(ir ** 2, axis=0, keepdims=True))   # energía unitaria por canal
    return (ir * 0.5).astype(np.float32)


def aplicar(envio: np.ndarray) -> np.ndarray:
    """Devuelve la señal «mojada» (solo reverb) del envío, con la misma duración que la entrada."""
    if len(envio) == 0 or not np.any(envio):
        return np.zeros_like(envio)
    ir = respuesta_al_impulso()
    mojado = np.stack([signal.fftconvolve(envio[:, c], ir[:, c])[: len(envio)] for c in range(2)], axis=1)
    return mojado.astype(np.float32)
