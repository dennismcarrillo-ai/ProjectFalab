"""Corrección manual de la letra transcrita, conservando la sincronía palabra a palabra."""
from __future__ import annotations


def _tiempo_en(fraccion: float, segmento: dict) -> float:
    """Instante que corresponde a una fracción (0–1) del texto original del segmento.

    Se apoya en los tiempos por palabra de Whisper: si la línea corregida tiene más o menos
    palabras, las nuevas se reparten siguiendo el ritmo con que se cantó la original.
    """
    palabras = segmento.get("palabras") or []
    if not palabras:
        return segmento["inicio"] + fraccion * (segmento["fin"] - segmento["inicio"])
    total = sum(len(p["texto"]) for p in palabras) or 1
    puntos = [(0.0, palabras[0]["inicio"])]
    acumulado = 0
    for palabra in palabras:
        acumulado += len(palabra["texto"])
        puntos.append((acumulado / total, palabra["fin"]))
    for (f0, t0), (f1, t1) in zip(puntos, puntos[1:]):
        if fraccion <= f1:
            return t0 + (t1 - t0) * ((fraccion - f0) / max(f1 - f0, 1e-9))
    return puntos[-1][1]


def retemporizar(segmento: dict, texto: str) -> dict:
    """Devuelve el segmento con el texto nuevo y sus palabras colocadas en el tiempo."""
    nuevas = texto.split()
    antiguas = segmento.get("palabras") or []
    if len(nuevas) == len(antiguas):
        # Mismo número de palabras (el caso típico: corregir una palabra mal oída).
        palabras = [{**vieja, "texto": nueva} for vieja, nueva in zip(antiguas, nuevas)]
    else:
        total = sum(len(p) for p in nuevas) or 1
        palabras, acumulado = [], 0
        for palabra in nuevas:
            inicio = _tiempo_en(acumulado / total, segmento)
            acumulado += len(palabra)
            fin = _tiempo_en(acumulado / total, segmento)
            palabras.append({"inicio": round(inicio, 3), "fin": round(max(fin, inicio + 0.02), 3), "texto": palabra})
    return {"inicio": segmento["inicio"], "fin": segmento["fin"], "texto": " ".join(nuevas), "palabras": palabras}


def aplicar(letras: dict, lineas: list[dict]) -> dict:
    """Aplica las líneas editadas [{inicio, fin?, texto}] sobre la transcripción guardada.

    Cada línea se empareja con el segmento original que empieza en el mismo instante. Una línea
    con el texto vacío se elimina; una línea con un inicio nuevo se añade tal cual.
    """
    originales = {round(s["inicio"], 3): s for s in letras.get("segmentos", [])}
    segmentos = []
    for linea in lineas:
        texto = str(linea.get("texto", "")).strip()
        if not texto:
            continue
        inicio = round(float(linea["inicio"]), 3)
        base = originales.get(inicio)
        if base is None:
            fin = float(linea.get("fin", inicio + 3.0))
            base = {"inicio": inicio, "fin": max(fin, inicio + 0.2), "palabras": []}
        segmentos.append(retemporizar(base, texto) if texto != base.get("texto") else base)
    segmentos.sort(key=lambda s: s["inicio"])
    return {**letras, "segmentos": segmentos, "editada": True}
