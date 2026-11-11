"""Cancionero: letra con los acordes colocados encima de la sílaba donde cambian (TXT y PDF)."""
from __future__ import annotations

from pathlib import Path

HUECO_INSTRUMENTAL = 4.0  # segundos sin letra a partir de los cuales se escribe una línea de acordes


def _linea_instrumental(acordes: list[dict], inicio: float, fin: float) -> dict | None:
    dentro = [a for a in acordes if a["inicio"] < fin and a["fin"] > inicio + 0.05]
    if not dentro:
        return None
    nombres = []
    for acorde in dentro:
        if not nombres or nombres[-1] != acorde["nombre"]:
            nombres.append(acorde["nombre"])
    return {"tipo": "instrumental", "inicio": inicio, "fin": fin,
            "texto": "| " + " | ".join(nombres) + " |", "acordes": []}


def construir(letras: dict, acordes: list[dict], duracion: float) -> list[dict]:
    """Devuelve las líneas del cancionero.

    Cada línea: {tipo: 'letra'|'instrumental', inicio, fin, texto, acordes:[{columna, nombre, t}]}
    donde `columna` es el índice del carácter de `texto` sobre el que se escribe el acorde.
    """
    lineas: list[dict] = []
    cursor = 0.0
    ultimo_nombre = None
    for segmento in letras.get("segmentos", []):
        if segmento["inicio"] - cursor >= HUECO_INSTRUMENTAL:
            instrumental = _linea_instrumental(acordes, cursor, segmento["inicio"])
            if instrumental:
                lineas.append(instrumental)
                ultimo_nombre = None
        # Se reconstruye el texto palabra a palabra para conocer la columna de cada una.
        palabras = segmento.get("palabras") or [
            {"inicio": segmento["inicio"], "fin": segmento["fin"], "texto": segmento["texto"]}
        ]
        texto, columnas = "", []
        for palabra in palabras:
            if texto:
                texto += " "
            columnas.append((len(texto), palabra["inicio"], palabra["fin"]))
            texto += palabra["texto"]

        marcas = []
        for acorde in acordes:
            if acorde["fin"] <= segmento["inicio"] or acorde["inicio"] >= segmento["fin"]:
                continue
            if acorde["nombre"] == ultimo_nombre and acorde["inicio"] < segmento["inicio"]:
                continue  # el acorde ya venía sonando y ya está escrito en la línea anterior
            columna = 0
            for col, ini, fin in columnas:
                if ini <= acorde["inicio"] + 0.08:
                    columna = col
                else:
                    break
            if acorde["inicio"] <= segmento["inicio"]:
                columna = 0
            if marcas and marcas[-1]["columna"] == columna:
                marcas[-1] = {"columna": columna, "nombre": acorde["nombre"], "t": acorde["inicio"]}
            else:
                marcas.append({"columna": columna, "nombre": acorde["nombre"], "t": acorde["inicio"]})
            ultimo_nombre = acorde["nombre"]
        lineas.append({"tipo": "letra", "inicio": segmento["inicio"], "fin": segmento["fin"],
                       "texto": texto, "acordes": marcas})
        cursor = segmento["fin"]
    if duracion - cursor >= HUECO_INSTRUMENTAL or not lineas:
        final = _linea_instrumental(acordes, cursor, duracion)
        if final:
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
