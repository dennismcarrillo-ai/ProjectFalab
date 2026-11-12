"""Cancionero: letra con los acordes colocados encima de la sílaba donde cambian (TXT y PDF)."""
from __future__ import annotations

from pathlib import Path

HUECO_INSTRUMENTAL = 4.0  # segundos sin letra a partir de los cuales se escribe una línea de acordes


TOLERANCIA = 0.15  # los límites de acordes (pulsos) y de palabras nunca coinciden al milisegundo


def _linea_instrumental(acordes: list[dict], inicio: float, fin: float, ya_escrito: str | None = None) -> dict | None:
    """Línea «| C | Am | F |» con los acordes del tramo sin letra [inicio, fin)."""
    nombres = []
    for acorde in acordes:
        if acorde["fin"] <= inicio + TOLERANCIA or acorde["inicio"] >= fin - TOLERANCIA:
            continue
        if not nombres and acorde["inicio"] < inicio - TOLERANCIA and acorde["nombre"] == ya_escrito:
            continue  # venía sonando y ya figura en la línea anterior
        if not nombres or nombres[-1] != acorde["nombre"]:
            nombres.append(acorde["nombre"])
    if not nombres:
        return None
    return {"tipo": "instrumental", "inicio": inicio, "fin": fin,
            "texto": "| " + " | ".join(nombres) + " |", "acordes": [], "ultimo": nombres[-1]}


def _columna(t: float, columnas: list[tuple[int, float, float, int]], largo: int) -> int:
    """Carácter de la línea sobre el que cae el instante `t`.

    Dentro de una palabra larga el acorde avanza en proporción al tiempo (cae sobre su sílaba);
    entre dos palabras se coloca sobre la siguiente; después de la última, tras el texto.
    """
    for i, (col, ini, fin, letras) in enumerate(columnas):
        siguiente = columnas[i + 1][1] if i + 1 < len(columnas) else None
        if t < ini + 0.08:
            return col
        if t < fin:
            return col + min(letras - 1, int(letras * (t - ini) / max(fin - ini, 1e-6)))
        if siguiente is not None and t < siguiente - 0.08:
            return columnas[i + 1][0]
    return largo + 2


def construir(letras: dict, acordes: list[dict], duracion: float) -> list[dict]:
    """Devuelve las líneas del cancionero, sin perder ningún cambio de acorde.

    Cada línea: {tipo: 'letra'|'instrumental', inicio, fin, texto, acordes:[{columna, nombre, t}]}
    donde `columna` es el índice del carácter de `texto` sobre el que se escribe el acorde.
    Los acordes que suenan en la pausa entre dos líneas se escriben al final de la primera
    (pasado el texto); si la pausa es larga, van en una línea instrumental propia.
    """
    segmentos = letras.get("segmentos", [])
    lineas: list[dict] = []
    cursor = 0.0            # hasta dónde están ya escritos los acordes
    ultimo_nombre = None
    for indice, segmento in enumerate(segmentos):
        if segmento["inicio"] - cursor >= HUECO_INSTRUMENTAL:
            instrumental = _linea_instrumental(acordes, cursor, segmento["inicio"], ultimo_nombre)
            if instrumental:
                ultimo_nombre = instrumental.pop("ultimo")
                lineas.append(instrumental)
            cursor = segmento["inicio"]
        # La línea se hace cargo de los acordes hasta que empiece la siguiente (si está cerca).
        if indice + 1 < len(segmentos):
            proximo = segmentos[indice + 1]["inicio"]
        else:
            proximo = duracion
        limite = proximo if proximo - segmento["fin"] < HUECO_INSTRUMENTAL else segmento["fin"]
        limite = max(limite, segmento["fin"])

        # Se reconstruye el texto palabra a palabra para conocer la columna de cada una.
        palabras = segmento.get("palabras") or [
            {"inicio": segmento["inicio"], "fin": segmento["fin"], "texto": segmento["texto"]}
        ]
        texto, columnas = "", []
        for palabra in palabras:
            if texto:
                texto += " "
            columnas.append((len(texto), palabra["inicio"], palabra["fin"], len(palabra["texto"])))
            texto += palabra["texto"]

        marcas: list[dict] = []
        desde = min(cursor, segmento["inicio"])
        for acorde in acordes:
            if acorde["fin"] <= desde + TOLERANCIA or acorde["inicio"] >= limite - TOLERANCIA:
                continue
            ya_sonaba = acorde["inicio"] <= segmento["inicio"] + 0.08
            if ya_sonaba and acorde["nombre"] == ultimo_nombre and acorde["inicio"] < desde + TOLERANCIA:
                continue  # sigue sonando el acorde ya escrito en la línea anterior
            columna = 0 if ya_sonaba else _columna(acorde["inicio"], columnas, len(texto))
            if marcas:
                columna = max(columna, marcas[-1]["columna"])  # nunca retroceder: se leen en orden
                if marcas[-1]["nombre"] == acorde["nombre"]:
                    continue
            marcas.append({"columna": columna, "nombre": acorde["nombre"], "t": acorde["inicio"]})
            ultimo_nombre = acorde["nombre"]
        lineas.append({"tipo": "letra", "inicio": segmento["inicio"], "fin": segmento["fin"],
                       "texto": texto, "acordes": marcas})
        cursor = limite
    if duracion - cursor >= HUECO_INSTRUMENTAL or not lineas:
        final = _linea_instrumental(acordes, cursor, duracion, ultimo_nombre)
        if final:
            final.pop("ultimo")
            lineas.append(final)
    return lineas


def _fila_de_acordes(marcas: list[dict]) -> str:
    fila = ""
    for marca in marcas:
        columna = max(marca["columna"], len(fila) + (1 if fila else 0))
        fila = fila.ljust(columna) + marca["nombre"]
    return fila


def a_texto(titulo: str, tonalidad: str, bpm: float, lineas: list[dict]) -> str:
    partes = [titulo, f"Tonalidad: {tonalidad}   Tempo: {bpm:.0f} BPM", ""]
    for linea in lineas:
        if linea["tipo"] == "instrumental":
            partes += ["", linea["texto"], ""]
            continue
        if linea["acordes"]:
            partes.append(_fila_de_acordes(linea["acordes"]))
        partes.append(linea["texto"])
    return "\n".join(partes).rstrip() + "\n"


def a_pdf(titulo: str, tonalidad: str, bpm: float, lineas: list[dict], destino: Path) -> None:
    from fpdf import FPDF

    def latin(texto: str) -> str:
        # Las fuentes base del PDF cubren Latin-1 (suficiente para el español); los símbolos de
        # jazz se pasan a su equivalente escribible.
        texto = texto.replace("Δ", "maj").replace("ø", "m7b5 ").replace("°", "dim")
        return texto.encode("latin-1", "replace").decode("latin-1")

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 10, latin(titulo), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(90, 90, 90)
    pdf.cell(0, 6, latin(f"Tonalidad: {tonalidad}   Tempo: {bpm:.0f} BPM"), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    # Fuente monoespaciada: es lo que garantiza que el acorde quede sobre su sílaba.
    for linea in lineas:
        if pdf.get_y() > 265:
            pdf.add_page()
        if linea["tipo"] == "instrumental":
            pdf.ln(2)
            pdf.set_font("Courier", "B", 10)
            pdf.set_text_color(15, 118, 110)
            pdf.cell(0, 5, latin(linea["texto"]), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)
            continue
        if linea["acordes"]:
            pdf.set_font("Courier", "B", 10)
            pdf.set_text_color(15, 118, 110)
            pdf.cell(0, 4.5, latin(_fila_de_acordes(linea["acordes"])), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Courier", "", 10)
        pdf.set_text_color(20, 20, 20)
        pdf.cell(0, 5, latin(linea["texto"]), new_x="LMARGIN", new_y="NEXT")
    destino.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(destino))
