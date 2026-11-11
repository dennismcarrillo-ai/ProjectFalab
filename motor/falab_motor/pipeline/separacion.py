"""Etapa 1 — Separación de stems con Meta Demucs v4 (htdemucs_6s), 100 % local.

Decisiones de memoria:
* El audio se procesa en bloques de ~40 s que se escriben a disco al terminar, así el pico de
  RAM no depende de la duración de la canción (una pista de 10 min usa lo mismo que una de 1).
* Entre bloques hay un solape con fundido cruzado para que no se oigan las costuras.
* El modelo se libera explícitamente al acabar, antes de cargar el siguiente (Whisper, etc.).
"""
from __future__ import annotations

import gc
import os
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from ..config import FRECUENCIA, STEMS

MODELO_POR_DEFECTO = "htdemucs_6s"
SEGUNDOS_BLOQUE = 40
SEGUNDOS_SOLAPE = 2


def elegir_dispositivo() -> str:
    """GPU de Apple Silicon (MPS) si existe; si no, CUDA; si no, CPU."""
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def separar(
    ruta_mezcla: Path,
    dir_stems: Path,
    *,
    modelo: str = MODELO_POR_DEFECTO,
    progreso: Callable[[float], None] = lambda _: None,
) -> dict[str, Path]:
    """Separa `ruta_mezcla` y devuelve {id_stem_en_español: ruta_flac}."""
    # Algunas operaciones aún no existen en MPS: con esto caen a CPU en lugar de fallar.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    red = get_model(modelo)
    red.eval()
    if red.samplerate != FRECUENCIA:
        raise RuntimeError(f"El modelo {modelo} trabaja a {red.samplerate} Hz, no a {FRECUENCIA}.")
    dispositivo = elegir_dispositivo()

    dir_stems.mkdir(parents=True, exist_ok=True)
    rutas = {STEMS[f][0]: dir_stems / f"{STEMS[f][0]}.flac" for f in red.sources}
    bloque = SEGUNDOS_BLOQUE * FRECUENCIA
    solape = SEGUNDOS_SOLAPE * FRECUENCIA
    rampa = np.linspace(0.0, 1.0, solape, dtype=np.float32)[None, :, None]

    def inferir(tramo: np.ndarray, donde: str) -> np.ndarray:
        """tramo: (frames, 2) -> (fuentes, frames, 2)."""
        onda = torch.from_numpy(np.ascontiguousarray(tramo.T))
        # Misma normalización que usa Demucs en su propia herramienta de línea de comandos.
        referencia = onda.mean(0)
        media, desviacion = referencia.mean(), referencia.std() + 1e-8
        onda = (onda - media) / desviacion
        with torch.no_grad():
            salida = apply_model(red, onda[None], device=donde, split=True, overlap=0.25,
                                 shifts=0, progress=False)[0]
        salida = salida * desviacion + media
        return salida.cpu().numpy().transpose(0, 2, 1)

    escritores = {}
    try:
        for id_stem, ruta in rutas.items():
            escritores[id_stem] = sf.SoundFile(str(ruta), "w", FRECUENCIA, 2,
                                               format="FLAC", subtype="PCM_24")
        with sf.SoundFile(str(ruta_mezcla)) as entrada:
            total = entrada.frames
            cola: np.ndarray | None = None  # salida del solape del bloque anterior
            posicion = 0
            while posicion < total:
                entrada.seek(posicion)
                tramo = entrada.read(bloque + solape, dtype="float32", always_2d=True)
                if tramo.shape[1] == 1:
                    tramo = np.repeat(tramo, 2, axis=1)
                try:
                    estimacion = inferir(tramo, dispositivo)
                except RuntimeError:
                    if dispositivo == "cpu":
                        raise
                    dispositivo = "cpu"  # p. ej. memoria de GPU insuficiente: se reintenta en CPU
                    estimacion = inferir(tramo, dispositivo)
                if cola is not None:
                    n = min(solape, estimacion.shape[1], cola.shape[1])
                    estimacion[:, :n] = cola[:, :n] * (1 - rampa[:, :n]) + estimacion[:, :n] * rampa[:, :n]
                es_ultimo = posicion + bloque >= total
                listo = estimacion if es_ultimo else estimacion[:, :bloque]
                cola = None if es_ultimo else estimacion[:, bloque:]
                for indice, fuente in enumerate(red.sources):
                    escritores[STEMS[fuente][0]].write(np.clip(listo[indice], -1.0, 1.0))
                posicion += bloque
                progreso(min(1.0, posicion / total))
    finally:
        for escritor in escritores.values():
            escritor.close()
        del red
        gc.collect()
        if dispositivo == "mps":
            torch.mps.empty_cache()
        elif dispositivo == "cuda":
            torch.cuda.empty_cache()
    return rutas
