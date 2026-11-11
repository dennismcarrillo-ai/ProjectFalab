"""Etapa 3 — Metrónomo dinámico: «mapa de pulsos» que sigue las fluctuaciones de tempo.

Se analizan los transitorios con librosa. Si existe el stem de batería se usa ese (transitorios
mucho más limpios que en la mezcla). El resultado no es un BPM fijo sino la lista de instantes
de cada pulso, con su BPM local y su posición en el compás; el metrónomo de la interfaz hace
clic exactamente en esos instantes.
"""
from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

SALTO = 512
FS_ANALISIS = 22050  # el análisis rítmico no necesita más ancho de banda y gasta la mitad de RAM


def analizar(ruta_ritmo: Path, ruta_armonia: Path | None = None, *, pulsos_por_compas: int = 4) -> dict:
    """`ruta_ritmo` marca los pulsos; `ruta_armonia` (la mezcla) ayuda a localizar el tiempo 1."""
    onda, fs = librosa.load(str(ruta_ritmo), sr=FS_ANALISIS, mono=True)
    armonia = None
    if ruta_armonia is not None and ruta_armonia != ruta_ritmo:
        armonia, _ = librosa.load(str(ruta_armonia), sr=FS_ANALISIS, mono=True)
    return analizar_onda(onda, fs, armonia, pulsos_por_compas=pulsos_por_compas)


def analizar_onda(onda: np.ndarray, fs: int, armonia: np.ndarray | None = None, *,
                  pulsos_por_compas: int = 4) -> dict:
    duracion = len(onda) / fs
    vacio = {"bpm": 120.0, "compas": pulsos_por_compas, "pulsos": [], "duracion": duracion}
    if len(onda) < fs * 2 or float(np.max(np.abs(onda))) < 1e-4:
        return vacio

    fuerza = librosa.onset.onset_strength(y=onda, sr=fs, hop_length=SALTO, aggregate=np.median)
    tempo_global = float(np.atleast_1d(librosa.feature.tempo(onset_envelope=fuerza, sr=fs, hop_length=SALTO))[0])
    # Tempo variable en el tiempo: permite al seguidor de pulsos adaptarse a acelerandos/ritardandos.
    tempo_local = librosa.feature.tempo(onset_envelope=fuerza, sr=fs, hop_length=SALTO,
                                        aggregate=None, start_bpm=tempo_global)
    try:
        _, cuadros = librosa.beat.beat_track(onset_envelope=fuerza, sr=fs, hop_length=SALTO,
                                             bpm=tempo_local, tightness=80)
    except Exception:  # versiones antiguas de librosa no aceptan tempo variable
        _, cuadros = librosa.beat.beat_track(onset_envelope=fuerza, sr=fs, hop_length=SALTO,
                                             bpm=tempo_global, tightness=80)
    cuadros = np.asarray(cuadros, dtype=int)
    if len(cuadros) < 4:
        return vacio
    tiempos = librosa.frames_to_time(cuadros, sr=fs, hop_length=SALTO)
    # El seguidor suele saltarse los pulsos de los extremos (sobre todo el del instante 0):
    # se prolonga la rejilla con el intervalo vecino para cubrir la canción entera.
    while tiempos[0] - (tiempos[1] - tiempos[0]) >= -0.03:
        tiempos = np.insert(tiempos, 0, max(0.0, tiempos[0] - (tiempos[1] - tiempos[0])))
    while tiempos[-1] + (tiempos[-1] - tiempos[-2]) <= duracion:
        tiempos = np.append(tiempos, tiempos[-1] + (tiempos[-1] - tiempos[-2]))
    cuadros = librosa.time_to_frames(tiempos, sr=fs, hop_length=SALTO)

    # BPM local: mediana móvil de los intervalos entre pulsos (robusta a un pulso mal colocado).
    intervalos = np.diff(tiempos)
    intervalos = np.append(intervalos, intervalos[-1])
    ventana = 4
    relleno = np.pad(intervalos, ventana, mode="edge")
    suaves = np.array([np.median(relleno[i:i + 2 * ventana + 1]) for i in range(len(intervalos))])
    bpm_local = 60.0 / np.maximum(suaves, 1e-3)

    # Primer tiempo del compás. Dos pistas: (a) el «1» suele llevar más energía grave (bombo) y
    # (b) los acordes suelen cambiar en el «1». Gana la fase que mejor cumple ambas.
    def por_fase(valores: np.ndarray) -> np.ndarray:
        medias = np.array([valores[f::pulsos_por_compas].mean() for f in range(pulsos_por_compas)])
        return medias / max(float(medias.max()), 1e-9)

    espectro = np.abs(librosa.stft(onda, n_fft=1024, hop_length=SALTO))
    graves = espectro[: max(2, int(150 / (fs / 1024)))].sum(axis=0)
    puntuacion = por_fase(graves[np.clip(cuadros, 0, len(graves) - 1)])
    del espectro
    if armonia is not None and len(armonia) > fs:
        croma = librosa.feature.chroma_stft(y=armonia, sr=fs, n_fft=4096, hop_length=SALTO)
        limites = np.clip(np.append(cuadros, croma.shape[1]), 0, croma.shape[1])
        por_pulso = np.stack([croma[:, a:max(a + 1, b)].mean(axis=1) for a, b in zip(limites[:-1], limites[1:])])
        por_pulso /= np.maximum(np.linalg.norm(por_pulso, axis=1, keepdims=True), 1e-9)
        cambio = np.zeros(len(cuadros))
        cambio[1:] = 1.0 - np.sum(por_pulso[1:] * por_pulso[:-1], axis=1)
        puntuacion = puntuacion + 2.0 * por_fase(cambio)
    fase = int(np.argmax(puntuacion))

    pulsos = []
    for i, (t, bpm) in enumerate(zip(tiempos, bpm_local)):
        relativo = i - fase
        pulsos.append({
            "t": round(float(t), 4),
            "bpm": round(float(bpm), 2),
            "compas": relativo // pulsos_por_compas + 1,   # puede ser 0 en una anacrusa
            "pulso": relativo % pulsos_por_compas + 1,
        })
    return {
        "bpm": round(float(np.median(bpm_local)), 2),
        "compas": pulsos_por_compas,
        "pulsos": pulsos,
        "duracion": duracion,
    }
