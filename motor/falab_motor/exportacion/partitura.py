"""Partitura estándar (MusicXML) y archivo MIDI multipista a partir de las notas detectadas."""
from __future__ import annotations

from pathlib import Path

from .cuantizacion import agrupar

NOMBRES_PISTA = {"voz": "Voz", "bajo": "Bajo", "guitarra": "Guitarra", "piano": "Piano", "otros": "Otros"}
PROGRAMAS_MIDI = {"voz": 53, "bajo": 33, "guitarra": 25, "piano": 0, "otros": 48}


def a_musicxml(notas_por_pista: dict[str, list[dict]], mapa_tempo: dict, titulo: str,
               tonalidad: dict | None, destino: Path) -> None:
    """Escribe una partitura con un pentagrama por pista que tenga notas."""
    from music21 import chord, clef, key, metadata, meter, note, stream, tempo

    partitura = stream.Score()
    partitura.metadata = metadata.Metadata(title=titulo, composer="Transcripción automática · falab")
    pulsos_compas = mapa_tempo.get("compas", 4)
    for id_pista, notas in notas_por_pista.items():
        grupos = agrupar(notas, mapa_tempo)
        if not grupos:
            continue
        parte = stream.Part(id=id_pista)
        parte.partName = NOMBRES_PISTA.get(id_pista, id_pista)
        parte.insert(0, meter.TimeSignature(f"{pulsos_compas}/4"))
        parte.insert(0, tempo.MetronomeMark(number=round(mapa_tempo.get("bpm", 120))))
        if tonalidad:
            modo = "major" if tonalidad.get("modo") == "mayor" else "minor"
            nombres = ["C", "D-", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B"]
            parte.insert(0, key.Key(nombres[tonalidad.get("tonica", 0)], modo))
        if id_pista == "bajo":
            parte.insert(0, clef.BassClef())
        elif id_pista == "guitarra":
            parte.insert(0, clef.Treble8vbClef())
        elif id_pista == "voz":
            parte.insert(0, clef.TrebleClef())
        for grupo in grupos:
            elemento = (note.Note(grupo["tonos"][0]) if len(grupo["tonos"]) == 1
                        else chord.Chord(grupo["tonos"]))
            elemento.quarterLength = grupo["duracion"]
            parte.insert(grupo["posicion"], elemento)
        # makeNotation reparte en compases, crea silencios y liga las notas que cruzan la barra.
        partitura.insert(0, parte.makeNotation())
    if not partitura.parts:
        raise ValueError("No hay notas detectadas para generar la partitura.")
    destino.parent.mkdir(parents=True, exist_ok=True)
    partitura.write("musicxml", fp=str(destino))


def a_midi(notas_por_pista: dict[str, list[dict]], bpm: float, destino: Path) -> None:
    """MIDI multipista con los tiempos reales de la interpretación (sin cuantizar)."""
    import pretty_midi

    midi = pretty_midi.PrettyMIDI(initial_tempo=float(bpm or 120.0))
    for id_pista, notas in notas_por_pista.items():
        if not notas:
            continue
        instrumento = pretty_midi.Instrument(program=PROGRAMAS_MIDI.get(id_pista, 0),
                                             name=NOMBRES_PISTA.get(id_pista, id_pista))
        for n in notas:
            instrumento.notes.append(pretty_midi.Note(velocity=int(n.get("velocidad", 80)), pitch=int(n["tono"]),
                                                      start=float(n["inicio"]), end=float(n["fin"])))
        midi.instruments.append(instrumento)
    if not midi.instruments:
        raise ValueError("No hay notas detectadas para generar el MIDI.")
    destino.parent.mkdir(parents=True, exist_ok=True)
    midi.write(str(destino))
