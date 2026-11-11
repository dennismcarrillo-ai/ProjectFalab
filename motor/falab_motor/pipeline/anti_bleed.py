"""Etapa 2 — Mitigación de sangrado («anti-bleed») entre bajo y bombo.

Demucs suele dejar parte del golpe del bombo en el stem de bajo y parte de la nota del bajo en
el de batería. Aquí se intercambia esa energía con máscaras espectrales suaves (tipo Wiener):

* Lo PERCUSIVO del stem de bajo que coincide con un golpe de batería -> vuelve a la batería.
* Lo ARMÓNICO sostenido del stem de batería donde el bajo está sonando -> vuelve al bajo.

Propiedad clave: lo que se quita de un stem se suma al otro, así que bajo + batería queda
idéntico al original y la mezcla completa no se altera.

Decisión de memoria: solo interesan los graves (< ~375 Hz), así que se trabaja sobre una copia
diezmada 16× (2,7 kHz). La STFT ocupa unos pocos MB en vez de cientos, y solo la *diferencia*
se devuelve a 44,1 kHz.
"""
from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
from scipy import signal

from ..config import FRECUENCIA
from ..medios import escribir_flac, leer_audio

DIEZMADO = 16
N_FFT = 256      # a 2756 Hz -> 10,8 Hz por banda
SALTO = 64       # 23 ms por cuadro


def _puerta_de_golpes(bateria: np.ndarray, fs: int, cuadros: int, fs_baja: float) -> np.ndarray:
    """Curva 0–1 que vale ~1 durante cada golpe de batería y cae con ~120 ms de relajación."""
    salto = 512
    fuerza = librosa.onset.onset_strength(y=bateria.mean(axis=1), sr=fs, hop_length=salto)
    techo = np.percentile(fuerza, 98) if fuerza.size else 0.0
    if techo <= 1e-9:
        return np.zeros(cuadros, dtype=np.float32)
    fuerza = np.clip(fuerza / techo, 0.0, 1.0)
    caida = np.exp(-(salto / fs) / 0.12)
    puerta = np.empty_like(fuerza)
    nivel = 0.0
    for i, valor in enumerate(fuerza):
        nivel = max(valor, nivel * caida)
        puerta[i] = nivel
    tiempos_origen = np.arange(len(puerta)) * salto / fs
    tiempos_destino = np.arange(cuadros) * SALTO / fs_baja
    return np.interp(tiempos_destino, tiempos_origen, puerta).astype(np.float32)


def reducir_sangrado(
    bajo: np.ndarray,
    bateria: np.ndarray,
    fs: int = FRECUENCIA,
    *,
    intensidad: float = 1.0,
    corte_hz: float = 250.0,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Devuelve (bajo_limpio, bateria_limpia, energía_trasladada_en_dB).

    `bajo` y `bateria` tienen forma (frames, canales). `intensidad` va de 0 (sin efecto) a 1.
    """
    frames = min(len(bajo), len(bateria))
    bajo, bateria = bajo[:frames], bateria[:frames]
    if frames < DIEZMADO * N_FFT * 2 or intensidad <= 0:
        return bajo, bateria, -120.0

    fs_baja = fs / DIEZMADO
    bajo_b = signal.resample_poly(bajo, 1, DIEZMADO, axis=0)
    bateria_b = signal.resample_poly(bateria, 1, DIEZMADO, axis=0)

    frecuencias = np.fft.rfftfreq(N_FFT, 1 / fs_baja)
    # Ventana en frecuencia: 1 por debajo del corte, transición en coseno hasta 1,5× el corte.
    transicion = np.clip((frecuencias - corte_hz) / (0.5 * corte_hz), 0.0, 1.0)
    peso = (0.5 * (1 + np.cos(np.pi * transicion))).astype(np.float32)[:, None]

    diferencia_b = np.zeros_like(bajo_b)
    puerta = None
    for canal in range(bajo.shape[1]):
        _, _, B = signal.stft(bajo_b[:, canal], fs_baja, nperseg=N_FFT, noverlap=N_FFT - SALTO)
        _, _, D = signal.stft(bateria_b[:, canal], fs_baja, nperseg=N_FFT, noverlap=N_FFT - SALTO)
        if puerta is None:
            puerta = _puerta_de_golpes(bateria, fs, B.shape[1], fs_baja)[None, :]
        # Separación armónico/percusiva por filtros de mediana (máscaras suaves que suman 1).
        nucleo = (31, 9)  # ~0,7 s en tiempo, ~100 Hz en frecuencia
        arm_b, per_b = librosa.decompose.hpss(np.abs(B), kernel_size=nucleo, mask=True, power=2.0)
        arm_d, per_d = librosa.decompose.hpss(np.abs(D), kernel_size=nucleo, mask=True, power=2.0)

        bajo_a_bateria = B * per_b * puerta
        potencia_bajo = np.abs(B * arm_b) ** 2
        potencia_golpe = np.abs(D * per_d) ** 2
        presencia_bajo = potencia_bajo / (potencia_bajo + potencia_golpe + 1e-12)
        bateria_a_bajo = D * arm_d * presencia_bajo

        neto = (bateria_a_bajo - bajo_a_bateria) * peso
        _, onda = signal.istft(neto, fs_baja, nperseg=N_FFT, noverlap=N_FFT - SALTO)
        n = min(len(onda), len(diferencia_b))
        diferencia_b[:n, canal] = onda[:n]

    diferencia = signal.resample_poly(diferencia_b, DIEZMADO, 1, axis=0)[:frames]
    if len(diferencia) < frames:
        diferencia = np.pad(diferencia, ((0, frames - len(diferencia)), (0, 0)))
    diferencia = (diferencia * float(np.clip(intensidad, 0.0, 1.0))).astype(np.float32)

    energia = float(np.mean(diferencia.astype(np.float64) ** 2))
    trasladada_db = 10 * np.log10(energia) if energia > 0 else -120.0
    return bajo + diferencia, bateria - diferencia, trasladada_db


def aplicar_a_archivos(ruta_bajo: Path, ruta_bateria: Path, *, intensidad: float = 1.0) -> float:
    """Aplica el filtro sobre los stems en disco (los sobrescribe) y devuelve los dB trasladados."""
    bajo = leer_audio(ruta_bajo)
    bateria = leer_audio(ruta_bateria)
    bajo_limpio, bateria_limpia, trasladada_db = reducir_sangrado(bajo, bateria, intensidad=intensidad)
    escribir_flac(ruta_bajo, bajo_limpio)
    escribir_flac(ruta_bateria, bateria_limpia)
    return trasladada_db
