"""Etapa 4a — Audio a MIDI con BasicPitch (Spotify, código abierto), en local.

Se ejecuta sobre cada stem por separado: el modelo rinde mucho mejor con un solo instrumento
que con la mezcla. En macOS usa el modelo Core ML incluido en el paquete (sin TensorFlow).
"""
from __future__ import annotations

from pathlib import Path

# Tesitura aproximada de cada stem: descarta notas fantasma fuera del rango del instrumento.
RANGOS_HZ = {
    "voz": (80.0, 1100.0),
    "bajo": (30.0, 400.0),
    "guitarra": (75.0, 1400.0),
    "piano": (27.5, 4200.0),
    "otros": (27.5, 4200.0),
}


def transcribir(ruta_stem: Path, id_stem: str, ruta_midi: Path | None = None) -> list[dict]:
    """Devuelve las notas [{inicio, fin, tono (MIDI), velocidad (0–127)}] ordenadas por inicio."""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    minimo, maximo = RANGOS_HZ.get(id_stem, (27.5, 4200.0))
    _, midi, eventos = predict(
        str(ruta_stem),
        ICASSP_2022_MODEL_PATH,
        onset_threshold=0.5,
        frame_threshold=0.3,
        minimum_note_length=90.0,
        minimum_frequency=minimo,
        maximum_frequency=maximo,
        melodia_trick=True,
    )
    if ruta_midi is not None:
        ruta_midi.parent.mkdir(parents=True, exist_ok=True)
        midi.write(str(ruta_midi))
    notas = [
        {
            "inicio": round(float(inicio), 4),
            "fin": round(float(fin), 4),
            "tono": int(tono),
            "velocidad": int(max(1, min(127, round(float(amplitud) * 127)))),
        }
        for inicio, fin, tono, amplitud, _ in eventos
    ]
    notas.sort(key=lambda n: (n["inicio"], n["tono"]))
    return notas
