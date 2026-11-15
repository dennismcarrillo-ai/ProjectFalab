"""Importar y exportar proyectos completos como un único archivo «.falab» (un ZIP)."""
from __future__ import annotations

import json
import re
import shutil
import zipfile
from pathlib import Path

from . import config, medios, proyecto as modelo
from .trabajos import Trabajo

EXTENSION = ".falab"
NO_EMPAQUETAR = {"exportaciones", "picos"}  # se regeneran al importar


def datos_para_reproductor(id_proyecto: str) -> dict:
    """Todo lo que el reproductor móvil necesita y que en el escritorio calcula el motor al vuelo.

    El iPad no tiene Python: aquí se deja ya resuelto el mapa de pulsos con sus compases, el
    cancionero (con referencias a los acordes, para poder cambiar de cifrado y transponer allí) y
    la partitura y tablatura de cada instrumento. Los nombres de los acordes NO se guardan: el
    reproductor los escribe según el cifrado y el tono que elija el usuario.
    """
    from .exportacion import alphatex, cancionero
    from .pipeline import estructura

    p = modelo.cargar(id_proyecto)
    acordes = modelo.leer_analisis(id_proyecto, "acordes", {}) or {}
    letras = modelo.leer_analisis(id_proyecto, "letras", {"idioma": None, "segmentos": []})
    notas = modelo.leer_analisis(id_proyecto, "notas", {}) or {}
    secciones = (modelo.leer_analisis(id_proyecto, "estructura", {}) or {}).get("secciones", [])
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"bpm": p["bpm"], "compas": p["compas"], "pulsos": []})
    mapa = estructura.aplicar_compases(mapa, secciones)

    # Cancionero con ÍNDICES de acorde en lugar de nombres (el índice hace de «nombre» único).
    lista = acordes.get("acordes", [])
    identidad = {}
    numerados = []
    for acorde in lista:
        clave = (acorde["raiz"], acorde["calidad"], acorde.get("bajo"))
        identidad.setdefault(clave, len(identidad))
        numerados.append({**acorde, "nombre": f"#{identidad[clave]}"})
    primero_de = {}
    for i, a in enumerate(numerados):
        primero_de.setdefault(a["nombre"], i)
    lineas = []
    for linea in cancionero.construir(letras, numerados, p["duracion"]):
        if linea["tipo"] == "instrumental":
            indices = [primero_de[n] for n in linea["texto"].strip("| ").split(" | ") if n in primero_de]
            lineas.append({"tipo": "instrumental", "inicio": linea["inicio"], "fin": linea["fin"], "acordes": indices})
        else:
            lineas.append({**linea, "acordes": [{"columna": m["columna"], "t": m["t"], "acorde": primero_de[m["nombre"]]}
                                                for m in linea["acordes"]]})

    partituras: dict[str, dict] = {}
    for instrumento, lista_notas in notas.items():
        if not lista_notas:
            continue
        modos = ("ambas", "partitura", "tablatura") if instrumento in alphatex.AFINACION_TEX else ("partitura",)
        partituras[instrumento] = {}
        for modo in modos:
            try:
                partituras[instrumento][modo] = alphatex.generar(lista_notas, mapa, p["duracion"], instrumento, p["nombre"], modo)
            except ValueError:
                pass
    return {
        "version": 1,
        "mapaTempo": mapa,
        "secciones": secciones,
        "tonalidad": acordes.get("tonalidad") or {"tonica": 0, "modo": "mayor", "bemoles": False},
        "acordes": lista,
        "lineaBajo": acordes.get("lineaBajo", []),
        "ostinatos": acordes.get("ostinatos", []),
        "detalleAcordes": acordes.get("detalle", "normal"),
        "letras": letras,
        "cancionero": lineas,
        "notasVoz": notas.get("voz", []),
        "pistasConNotas": [k for k, v in notas.items() if v],
        "partituras": partituras,
    }


def exportar(id_proyecto: str, destino: Path | None, trabajo: Trabajo) -> dict:
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    destino = Path(destino).expanduser() if destino else carpeta / "exportaciones"
    destino.mkdir(parents=True, exist_ok=True)
    nombre = re.sub(r"[^\w\- ]+", "_", p["nombre"], flags=re.UNICODE).strip() or "proyecto"
    salida = destino / f"{nombre}{EXTENSION}"
    archivos = [r for r in sorted(carpeta.rglob("*"))
                if r.is_file() and r.relative_to(carpeta).parts[0] not in NO_EMPAQUETAR and r.suffix != ".tmp"]
    # Sin compresión: el FLAC ya está comprimido y así empaquetar es casi instantáneo.
    with zipfile.ZipFile(salida, "w", zipfile.ZIP_STORED) as paquete:
        for i, ruta in enumerate(archivos):
            trabajo.informar(i / max(1, len(archivos)), f"Empaquetando {ruta.name}")
            paquete.write(ruta, ruta.relative_to(carpeta).as_posix())
        # Datos ya resueltos para el reproductor del iPad (que no tiene motor de análisis).
        paquete.writestr("reproductor.json", json.dumps(datos_para_reproductor(id_proyecto), ensure_ascii=False))
    return {"archivos": [str(salida)]}


def importar(ruta_paquete: Path, trabajo: Trabajo) -> dict:
    ruta_paquete = Path(ruta_paquete).expanduser()
    if not zipfile.is_zipfile(ruta_paquete):
        raise ValueError("El archivo no es un proyecto de falab válido.")
    with zipfile.ZipFile(ruta_paquete) as paquete:
        nombres = paquete.namelist()
        if "proyecto.json" not in nombres:
            raise ValueError("El archivo no contiene ningún proyecto de falab.")
        p = json.loads(paquete.read("proyecto.json").decode("utf-8"))
        # Si ya existe un proyecto con ese identificador se importa como copia, sin pisarlo.
        id_proyecto = p.get("id", "")
        try:
            existe = modelo.carpeta(id_proyecto).exists()
        except ValueError:
            existe = True
        if existe:
            id_proyecto = modelo.nuevo_id()
            p["nombre"] = f"{p.get('nombre', 'Proyecto')} (copia)"
        p["id"] = id_proyecto
        carpeta = modelo.carpeta(id_proyecto)
        raiz = carpeta.resolve()
        try:
            for i, nombre in enumerate(nombres):
                trabajo.informar(0.9 * i / max(1, len(nombres)), "Desempaquetando")
                destino = (carpeta / nombre).resolve()
                # Nunca escribir fuera de la carpeta del proyecto, diga lo que diga el ZIP.
                if raiz not in destino.parents and destino != raiz:
                    raise ValueError("El archivo contiene rutas no permitidas.")
                if nombre.endswith("/") or nombre == "reproductor.json":
                    continue  # reproductor.json es solo para el iPad; el escritorio lo recalcula
                destino.parent.mkdir(parents=True, exist_ok=True)
                with paquete.open(nombre) as origen, open(destino, "wb") as salida:
                    shutil.copyfileobj(origen, salida)
            modelo.guardar(p)
            trabajo.informar(0.92, "Generando las ondas")
            for fuente in p["fuentes"]:
                medios.calcular_picos(carpeta / fuente["archivo"], carpeta / "picos" / f"{fuente['id']}.bin")
        except BaseException:
            shutil.rmtree(carpeta, ignore_errors=True)
            raise
    return {"id": id_proyecto, "nombre": p["nombre"], "avisos": []}
