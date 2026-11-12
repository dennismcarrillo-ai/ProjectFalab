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
                if nombre.endswith("/"):
                    continue
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
