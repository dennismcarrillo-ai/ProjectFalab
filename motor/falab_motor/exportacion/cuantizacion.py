"""Paso de tiempo real (segundos) a tiempo musical (pulsos) usando el mapa de tempo.

Como el mapa sigue las fluctuaciones del intérprete, una nota tocada «a tiempo» cae en su
pulso aunque la canción acelere o frene; por eso la partitura sale limpia sin claqueta fija.
"""
from __future__ import annotations

import numpy as np

REJILLA = 0.25  # semicorchea, medida en negras


def a_pulsos(tiempos: np.ndarray, mapa_tempo: dict) -> np.ndarray:
    """Convierte segundos en posición en negras; 0 es el primer tiempo del compás 1."""
    pulsos = mapa_tempo.get("pulsos", [])
    tiempos = np.asarray(tiempos, dtype=float)
    if len(pulsos) < 2:
        return tiempos * mapa_tempo.get("bpm", 120.0) / 60.0
    instantes = np.array([p["t"] for p in pulsos])
    indices = np.arange(len(pulsos), dtype=float)
    posicion = np.interp(tiempos, instantes, indices)
    # Fuera del tramo analizado se extrapola con el tempo del extremo más cercano.
    antes, despues = tiempos < instantes[0], tiempos > instantes[-1]
    posicion[antes] = (tiempos[antes] - instantes[0]) / (instantes[1] - instantes[0])
    posicion[despues] = indices[-1] + (tiempos[despues] - instantes[-1]) / (instantes[-1] - instantes[-2])
    primero = next((i for i, p in enumerate(pulsos) if p["compas"] == 1 and p["pulso"] == 1), 0)
    return posicion - primero


def agrupar(notas: list[dict], mapa_tempo: dict) -> list[dict]:
    """Cuantiza a semicorcheas y agrupa en una sola voz: [{posicion, duracion, tonos}] en negras.

    Las notas que empiezan juntas forman un acorde y cada grupo dura, como mucho, hasta el
    siguiente; es lo que mantiene legible la partitura y la tablatura.
    """
    if not notas:
        return []
    inicios = a_pulsos(np.array([n["inicio"] for n in notas]), mapa_tempo)
    finales = a_pulsos(np.array([n["fin"] for n in notas]), mapa_tempo)
    compas = mapa_tempo.get("compas", 4)
    desfase = 0.0
    if inicios.min() < -REJILLA / 2:  # anacrusa: se antepone un compás para no tener posiciones negativas
        desfase = float(np.ceil(-inicios.min() / compas) * compas)
    grupos: dict[float, dict] = {}
    for nota, ini, fin in zip(notas, inicios, finales):
        posicion = round((ini + desfase) / REJILLA) * REJILLA
        duracion = max(REJILLA, round((fin - ini) / REJILLA) * REJILLA)
        grupo = grupos.setdefault(posicion, {"posicion": posicion, "duracion": duracion, "tonos": set()})
        grupo["duracion"] = max(grupo["duracion"], duracion)
        grupo["tonos"].add(int(nota["tono"]))
    ordenados = [grupos[p] for p in sorted(grupos)]
    for actual, siguiente in zip(ordenados, ordenados[1:]):
        actual["duracion"] = min(actual["duracion"], siguiente["posicion"] - actual["posicion"])
    for grupo in ordenados:
        grupo["tonos"] = sorted(grupo["tonos"])
    return ordenados
