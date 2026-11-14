"""Punto de entrada de todas las exportaciones de un proyecto."""
from __future__ import annotations

import re
from pathlib import Path

from .. import proyecto as modelo
from ..pipeline import acordes as modulo_acordes
from ..trabajos import Trabajo
from . import archivos, cancionero, partitura, render, tablatura

TIPOS = {"mezcla", "pistas", "video", "cancionero", "partitura", "midi", "tablatura"}


def _nombre_seguro(texto: str) -> str:
    return re.sub(r"[^\w\- ]+", "_", texto, flags=re.UNICODE).strip() or "falab"


def exportar(id_proyecto: str, peticion: dict, trabajo: Trabajo) -> dict:
    """Genera los archivos pedidos y devuelve {'archivos': [rutas]}.

    peticion: {tipo, formato?, destino? (carpeta), cifrado?, instrumento?}
    """
    tipo = peticion.get("tipo")
    if tipo not in TIPOS:
        raise ValueError(f"Tipo de exportación desconocido: {tipo}")
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    destino = Path(peticion["destino"]).expanduser() if peticion.get("destino") else carpeta / "exportaciones"
    destino.mkdir(parents=True, exist_ok=True)
    base = _nombre_seguro(p["nombre"])
    formato = (peticion.get("formato") or "").lower()
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"bpm": p["bpm"], "compas": p["compas"], "pulsos": []})
    notas = modelo.leer_analisis(id_proyecto, "notas", {})
    salidas: list[Path] = []

    if tipo == "mezcla":
        onda = render.renderizar(p, carpeta, progreso=trabajo.subetapa(0.0, 0.85, "Renderizando la mezcla"))["mezcla"]
        trabajo.informar(0.9, "Escribiendo el archivo")
        salidas.append(archivos.escribir_audio(onda, destino / f"{base} (mezcla)", formato or "wav"))

    elif tipo == "pistas":
        ondas = render.renderizar(p, carpeta, por_pistas=True,
                                  progreso=trabajo.subetapa(0.0, 0.8, "Renderizando las pistas"))
        nombres = {pista["id"]: pista["nombre"] for pista in p["pistas"]}
        for i, (id_pista, onda) in enumerate(ondas.items()):
            trabajo.informar(0.8 + 0.2 * i / len(ondas), f"Escribiendo {nombres[id_pista]}")
            salidas.append(archivos.escribir_audio(
                onda, destino / f"{base} - {_nombre_seguro(nombres[id_pista])}", formato or "wav"))

    elif tipo == "video":
        # Se puede fusionar la mezcla con el video original o con una toma grabada con la cámara.
        elegido = peticion.get("video", "original")
        if elegido == "original":
            original = p.get("medioOriginal", {})
            if not original.get("tieneVideo"):
                raise ValueError("El archivo original de este proyecto no tiene video.")
            ruta_video, inicio_video, sufijo = Path(original["ruta"]), 0.0, "nueva mezcla"
        else:
            toma = next((v for v in p.get("videos", []) if v["id"] == elegido), None)
            if toma is None:
                raise ValueError("No existe esa toma de video.")
            ruta_video, inicio_video, sufijo = carpeta / toma["archivo"], float(toma.get("inicio", 0.0)), toma["nombre"]
        onda = render.renderizar(p, carpeta, progreso=trabajo.subetapa(0.0, 0.6, "Renderizando la mezcla"))["mezcla"]
        trabajo.informar(0.65, "Montando el video")
        salidas.append(archivos.escribir_video(ruta_video, onda, destino / f"{base} ({sufijo})",
                                               float(p.get("velocidad", 1.0)), inicio_video))

    elif tipo == "cancionero":
        trabajo.informar(0.2, "Componiendo el cancionero")
        cifrado = peticion.get("cifrado", "estandar")
        # El cancionero se escribe en el tono al que el usuario tiene transpuesta la canción.
        analisis = modulo_acordes.con_nombres(modelo.leer_analisis(id_proyecto, "acordes", {}), cifrado,
                                              int(p.get("tono", 0)))
        letras = modelo.leer_analisis(id_proyecto, "letras", {"segmentos": []})
        lineas = cancionero.construir(letras, analisis["acordes"], p["duracion"])
        if not lineas:
            raise ValueError("No hay letra ni acordes detectados en este proyecto.")
        tonalidad = analisis["tonalidad"]["nombre"]
        if formato == "pdf":
            ruta = destino / f"{base} (cancionero).pdf"
            cancionero.a_pdf(p["nombre"], tonalidad, p["bpm"], lineas, ruta)
        else:
            ruta = destino / f"{base} (cancionero).txt"
            ruta.write_text(cancionero.a_texto(p["nombre"], tonalidad, p["bpm"], lineas), encoding="utf-8")
        salidas.append(ruta)

    elif tipo in ("partitura", "midi"):
        trabajo.informar(0.2, "Generando la partitura")
        instrumento = peticion.get("instrumento")
        seleccion = {k: v for k, v in notas.items() if not instrumento or k == instrumento}
        if tipo == "midi":
            ruta = destino / f"{base}.mid"
            partitura.a_midi(seleccion, p["bpm"], ruta)
        else:
            ruta = destino / f"{base} (partitura).musicxml"
            tonalidad = modelo.leer_analisis(id_proyecto, "acordes", {}).get("tonalidad")
            partitura.a_musicxml(seleccion, mapa, p["nombre"], tonalidad, ruta)
        salidas.append(ruta)

    elif tipo == "tablatura":
        instrumento = peticion.get("instrumento", "guitarra")
        if instrumento not in tablatura.AFINACIONES:
            raise ValueError("La tablatura solo está disponible para guitarra y bajo.")
        trabajo.informar(0.3, "Generando la tablatura")
        texto = tablatura.a_texto(notas.get(instrumento, []), mapa, instrumento, p["nombre"])
        ruta = destino / f"{base} (tablatura {instrumento}).txt"
        ruta.write_text(texto, encoding="utf-8")
        salidas.append(ruta)

    return {"archivos": [str(s) for s in salidas]}
