"""Tablatura en texto para guitarra (6 cuerdas) y bajo (4 cuerdas), afinación estándar."""
from __future__ import annotations

from .cuantizacion import REJILLA, agrupar

# Cuerdas al aire en MIDI, de la más grave a la más aguda.
AFINACIONES = {
    "guitarra": ([40, 45, 50, 55, 59, 64], ["E", "A", "D", "G", "B", "e"]),
    "bajo": ([28, 33, 38, 43], ["E", "A", "D", "G"]),
}
TRASTE_MAXIMO = 17
COMPASES_POR_LINEA = 2


def _asignar(tonos: list[int], cuerdas: list[int], mano: float) -> dict[int, int]:
    """Elige {cuerda: traste} para un grupo de notas, lo más cerca posible de la mano."""
    libres = set(range(len(cuerdas)))
    asignacion: dict[int, int] = {}
    for tono in sorted(tonos):
        # Si la nota no cabe en el instrumento se lleva por octavas a su registro.
        while tono < cuerdas[0]:
            tono += 12
        while tono > cuerdas[-1] + TRASTE_MAXIMO:
            tono -= 12
        opciones = [(abs((tono - cuerdas[c]) - mano) + (0 if tono - cuerdas[c] else -0.5), c)
                    for c in libres if 0 <= tono - cuerdas[c] <= TRASTE_MAXIMO]
        if not opciones:
            continue
        _, cuerda = min(opciones)
        asignacion[cuerda] = tono - cuerdas[cuerda]
        libres.discard(cuerda)
    return asignacion


def a_texto(notas: list[dict], mapa_tempo: dict, instrumento: str, titulo: str) -> str:
    cuerdas, nombres = AFINACIONES[instrumento]
    grupos = agrupar(notas, mapa_tempo)
    if not grupos:
        raise ValueError("No hay notas detectadas para generar la tablatura.")
    compas = mapa_tempo.get("compas", 4)
    pasos_compas = int(compas / REJILLA)
    n_compases = int(max(g["posicion"] for g in grupos) // compas) + 1

    # rejilla[cuerda][paso] = traste o None
    rejilla = [[None] * (n_compases * pasos_compas) for _ in cuerdas]
    mano = 3.0
    for grupo in grupos:
        asignacion = _asignar(grupo["tonos"], cuerdas, mano)
        pisadas = [t for t in asignacion.values() if t > 0]
        if pisadas:
            mano = 0.7 * mano + 0.3 * (sum(pisadas) / len(pisadas))
        paso = int(round(grupo["posicion"] / REJILLA))
        for cuerda, traste in asignacion.items():
            rejilla[cuerda][paso] = traste

    lineas = [f"{titulo} — Tablatura de {instrumento}",
              f"Afinación estándar ({' '.join(nombres)}) · cada columna es una semicorchea", ""]
    for primero in range(0, n_compases, COMPASES_POR_LINEA):
        ultimos = range(primero, min(primero + COMPASES_POR_LINEA, n_compases))
        lineas.append("  " + "".join(f" {c + 1:<{pasos_compas * 3}}" for c in ultimos).rstrip())
        for cuerda in reversed(range(len(cuerdas))):  # la cuerda aguda va arriba
            fila = f"{nombres[cuerda]}|"
            for c in ultimos:
                for paso in range(c * pasos_compas, (c + 1) * pasos_compas):
                    traste = rejilla[cuerda][paso]
                    fila += "---" if traste is None else f"-{traste:-<2}"
                fila += "|"
            lineas.append(fila)
        lineas.append("")
    return "\n".join(lineas)
