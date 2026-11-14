"""Partitura y tablatura para la vista sincronizada (formato alphaTex, que dibuja alphaTab).

A diferencia de la exportación a MusicXML, aquí cada compás de la partitura corresponde a un
compás REAL del mapa de pulsos (con sus cambios de compás por sección). Por eso basta devolver,
junto con la partitura, cuándo empieza cada compás: la interfaz coloca el cursor con nuestro
reloj de audio y no necesita el reproductor de alphaTab.
"""
from __future__ import annotations

import numpy as np

from .tablatura import AFINACIONES, _asignar

PASOS_POR_PULSO = 4  # semicorcheas
# duración en semicorcheas -> (figura alphaTex, con puntillo)
FIGURAS = {16: (1, False), 12: (2, True), 8: (2, False), 6: (4, True), 4: (4, False),
           3: (8, True), 2: (8, False), 1: (16, False)}
NOMBRES = {"voz": "Voz", "bajo": "Bajo", "guitarra": "Guitarra", "piano": "Piano", "otros": "Otros"}
PROGRAMAS = {"voz": 53, "bajo": 33, "guitarra": 25, "piano": 0, "otros": 48}
AFINACION_TEX = {"guitarra": "E4 B3 G3 D3 A2 E2", "bajo": "G2 D2 A1 E1"}
# Los instrumentos sin trastes se escriben sobre seis «cuerdas» ficticias afinadas en Do1:
# el traste es simplemente la nota, y solo se muestra el pentagrama.
CUERDA_FICTICIA = 24
MODOS = {"partitura": "score", "tablatura": "tabs", "ambas": "score tabs"}


def compases_de(mapa: dict, duracion: float) -> list[dict]:
    """Compases reales de la canción: [{inicio, fin, pulsos:[instantes]}] según el mapa de pulsos."""
    pulsos = mapa.get("pulsos", [])
    if len(pulsos) < 2:
        intervalo = 60.0 / (mapa.get("bpm") or 120.0)
        por_compas = int(mapa.get("compas", 4))
        pulsos = [{"t": i * intervalo, "pulso": i % por_compas + 1} for i in range(int(duracion / intervalo) + 1)]
    ultimo = pulsos[-1]["t"] - pulsos[-2]["t"] if len(pulsos) > 1 else 0.5
    compases: list[dict] = []
    for i, pulso in enumerate(pulsos):
        if not compases or pulso["pulso"] == 1:
            compases.append({"inicio": pulso["t"], "pulsos": []})
        compases[-1]["pulsos"].append(pulso["t"])
    for actual, siguiente in zip(compases, compases[1:]):
        actual["fin"] = siguiente["inicio"]
    compases[-1]["fin"] = compases[-1]["pulsos"][-1] + ultimo
    return compases


def _a_pasos(tiempos: np.ndarray, compases: list[dict]) -> np.ndarray:
    """Convierte segundos en índice global de semicorchea, interpolando entre pulsos."""
    instantes, pasos = [], []
    acumulado = 0
    for compas in compases:
        for i, t in enumerate(compas["pulsos"]):
            instantes.append(t)
            pasos.append(acumulado + i * PASOS_POR_PULSO)
        acumulado += len(compas["pulsos"]) * PASOS_POR_PULSO
    instantes.append(compases[-1]["fin"])
    pasos.append(acumulado)
    return np.interp(tiempos, instantes, pasos)


def _trocear(posicion: int, largo: int) -> list[int]:
    """Divide una duración en figuras escribibles, sin cruzar el pulso a contratiempo."""
    trozos = []
    while largo > 0:
        fuera = posicion % PASOS_POR_PULSO
        tope = min(largo, PASOS_POR_PULSO - fuera) if fuera else largo
        trozo = next(d for d in FIGURAS if d <= tope)
        trozos.append(trozo)
        posicion += trozo
        largo -= trozo
    return trozos


def _figura(pasos: int) -> str:
    valor, puntillo = FIGURAS[pasos]
    return f".{valor}" + ("{d}" if puntillo else "")


def generar(notas: list[dict], mapa: dict, duracion: float, instrumento: str, titulo: str,
            modo: str = "ambas") -> dict:
    """Devuelve {tex, compases:[{inicio, fin}], modo} para un instrumento."""
    con_trastes = instrumento in AFINACIONES
    if not con_trastes:
        modo = "partitura"
    if modo not in MODOS:
        raise ValueError(f"Modo de partitura no válido: {modo}")
    if not notas:
        raise ValueError("No hay notas detectadas para este instrumento.")
    compases = compases_de(mapa, duracion)
    total_pasos = sum(len(c["pulsos"]) for c in compases) * PASOS_POR_PULSO

    # Cuantización a semicorcheas y agrupación en una sola voz (como en la exportación).
    inicios = np.round(_a_pasos(np.array([n["inicio"] for n in notas]), compases)).astype(int)
    finales = np.round(_a_pasos(np.array([n["fin"] for n in notas]), compases)).astype(int)
    grupos: dict[int, dict] = {}
    for nota, a, b in zip(notas, inicios, finales):
        a = int(np.clip(a, 0, total_pasos - 1))
        grupo = grupos.setdefault(a, {"inicio": a, "fin": a + 1, "tonos": set()})
        grupo["fin"] = max(grupo["fin"], int(b))
        grupo["tonos"].add(int(nota["tono"]))
    eventos = [grupos[k] for k in sorted(grupos)]
    for actual, siguiente in zip(eventos, eventos[1:]):
        actual["fin"] = min(actual["fin"], siguiente["inicio"])
    eventos[-1]["fin"] = min(eventos[-1]["fin"], total_pasos)

    # Digitación: cuerda y traste de cada nota.
    cuerdas = AFINACIONES[instrumento][0] if con_trastes else [CUERDA_FICTICIA] * 6
    mano = 3.0
    for evento in eventos:
        if con_trastes:
            asignacion = _asignar(sorted(evento["tonos"]), cuerdas, mano)
            pisadas = [t for t in asignacion.values() if t > 0]
            if pisadas:
                mano = 0.7 * mano + 0.3 * (sum(pisadas) / len(pisadas))
        else:
            tonos = sorted(evento["tonos"])[-len(cuerdas):]
            asignacion = {i: max(0, t - CUERDA_FICTICIA) for i, t in enumerate(tonos)}
        # alphaTex numera las cuerdas desde la más aguda (1).
        evento["digitacion"] = sorted((len(cuerdas) - c, traste) for c, traste in asignacion.items())

    lineas = []
    siguiente_evento = 0
    en_curso: dict | None = None   # evento que sigue sonando desde el compás anterior
    paso_global = 0
    tiempos_anteriores = None
    clave_fa = instrumento == "bajo" or (not con_trastes and np.median([n["tono"] for n in notas]) < 55)
    for compas in compases:
        tiempos = len(compas["pulsos"])
        pasos = tiempos * PASOS_POR_PULSO
        fin_compas = paso_global + pasos
        fichas: list[str] = []
        if tiempos != tiempos_anteriores:
            fichas.append(f"\\ts {tiempos} 4")
            tiempos_anteriores = tiempos
        if clave_fa and not lineas:
            fichas.append("\\clef F4")
        cursor = paso_global

        def escribir(desde: int, hasta: int, evento: dict | None, ligada: bool) -> None:
            primera = not ligada
            for trozo in _trocear(desde - paso_global, hasta - desde):
                if evento is None or not evento["digitacion"]:
                    fichas.append("r" + _figura(trozo))
                else:
                    notas_tex = [f"{traste if primera else '-'}.{cuerda}" for cuerda, traste in evento["digitacion"]]
                    cuerpo = notas_tex[0] if len(notas_tex) == 1 else "(" + " ".join(notas_tex) + ")"
                    fichas.append(cuerpo + _figura(trozo))
                    primera = False

        if en_curso is not None:
            hasta = min(en_curso["fin"], fin_compas)
            escribir(cursor, hasta, en_curso, ligada=True)
            cursor = hasta
            if en_curso["fin"] <= fin_compas:
                en_curso = None
        while cursor < fin_compas and en_curso is None:
            if siguiente_evento < len(eventos) and eventos[siguiente_evento]["inicio"] < fin_compas:
                evento = eventos[siguiente_evento]
                if evento["inicio"] > cursor:
                    escribir(cursor, evento["inicio"], None, ligada=False)
                hasta = min(evento["fin"], fin_compas)
                escribir(evento["inicio"], hasta, evento, ligada=False)
                cursor = hasta
                siguiente_evento += 1
                if evento["fin"] > fin_compas:
                    en_curso = evento
            else:
                escribir(cursor, fin_compas, None, ligada=False)
                cursor = fin_compas
        lineas.append(" ".join(fichas))
        paso_global = fin_compas

    titulo_tex = titulo.replace("\\", " ").replace('"', "'")
    cabecera = [f'\\title "{titulo_tex}"', f"\\tempo {max(20, round(mapa.get('bpm') or 120))}", "."]
    pista = f'\\track "{NOMBRES.get(instrumento, instrumento)}" \\staff{{{MODOS[modo]}}} '
    pista += f"\\tuning {AFINACION_TEX[instrumento] if con_trastes else ' '.join(['C1'] * 6)} "
    pista += f"\\instrument {PROGRAMAS.get(instrumento, 0)}"
    tex = "\n".join(cabecera + [pista, " |\n".join(lineas)])
    return {"tex": tex, "modo": modo, "conTrastes": con_trastes,
            "compases": [{"inicio": round(c["inicio"], 4), "fin": round(c["fin"], 4)} for c in compases]}
