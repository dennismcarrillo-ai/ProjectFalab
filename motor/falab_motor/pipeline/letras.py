"""Etapa 5 — Transcripción de letras con Whisper en local, con marcas de tiempo por palabra.

Se transcribe el stem de VOZ (no la mezcla): sin instrumentos encima Whisper acierta mucho más
y alucina menos. En Apple Silicon se usa MLX (GPU/Neural Engine); en el resto, faster-whisper.
"""
from __future__ import annotations

import gc
import platform
import sys
from pathlib import Path

MODELOS_MLX = {
    "rapido": "mlx-community/whisper-small-mlx",
    "equilibrado": "mlx-community/whisper-large-v3-turbo",
    "preciso": "mlx-community/whisper-large-v3-mlx",
}
MODELOS_FASTER = {"rapido": "small", "equilibrado": "large-v3-turbo", "preciso": "large-v3"}


def _es_apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def _normalizar(segmentos: list[dict]) -> list[dict]:
    limpios = []
    for segmento in segmentos:
        texto = segmento["texto"].strip()
        if not texto:
            continue
        palabras = [
            {"inicio": round(p["inicio"], 3), "fin": round(p["fin"], 3), "texto": p["texto"].strip()}
            for p in segmento.get("palabras", []) if p["texto"].strip()
        ]
        limpios.append({
            "inicio": round(segmento["inicio"], 3), "fin": round(segmento["fin"], 3),
            "texto": texto, "palabras": palabras,
        })
    return limpios


def transcribir(ruta_voz: Path, *, calidad: str = "equilibrado", idioma: str | None = None) -> dict:
    """Devuelve {idioma, segmentos:[{inicio, fin, texto, palabras:[{inicio, fin, texto}]}]}."""
    if _es_apple_silicon():
        try:
            return _con_mlx(ruta_voz, calidad, idioma)
        except ImportError:
            pass
    return _con_faster_whisper(ruta_voz, calidad, idioma)


def _con_mlx(ruta_voz: Path, calidad: str, idioma: str | None) -> dict:
    import mlx.core as mx
    import mlx_whisper

    resultado = mlx_whisper.transcribe(
        str(ruta_voz),
        path_or_hf_repo=MODELOS_MLX.get(calidad, MODELOS_MLX["equilibrado"]),
        word_timestamps=True,
        language=idioma,
        # En canciones los silencios largos provocan repeticiones si se arrastra el contexto.
        condition_on_previous_text=False,
        verbose=None,
    )
    segmentos = [
        {
            "inicio": float(s["start"]), "fin": float(s["end"]), "texto": s["text"],
            "palabras": [
                {"inicio": float(p["start"]), "fin": float(p["end"]), "texto": p["word"]}
                for p in s.get("words", [])
            ],
        }
        for s in resultado.get("segments", [])
    ]
    gc.collect()
    if hasattr(mx, "clear_cache"):
        mx.clear_cache()
    return {"idioma": resultado.get("language"), "segmentos": _normalizar(segmentos)}


def _con_faster_whisper(ruta_voz: Path, calidad: str, idioma: str | None) -> dict:
    from faster_whisper import WhisperModel

    modelo = WhisperModel(MODELOS_FASTER.get(calidad, "large-v3-turbo"), device="auto", compute_type="int8")
    iterador, info = modelo.transcribe(
        str(ruta_voz), language=idioma, word_timestamps=True,
        condition_on_previous_text=False, vad_filter=True,
    )
    segmentos = [
        {
            "inicio": s.start, "fin": s.end, "texto": s.text,
            "palabras": [{"inicio": p.start, "fin": p.end, "texto": p.word} for p in (s.words or [])],
        }
        for s in iterador
    ]
    del modelo
    gc.collect()
    return {"idioma": info.language, "segmentos": _normalizar(segmentos)}
