"""API HTTP local del motor. Solo escucha en 127.0.0.1 y la consume la interfaz de falab."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from . import __version__, config, drive, medios, proyecto as modelo
from .exportacion import cancionero
from .exportacion.exportar import exportar
from .pipeline import acordes as modulo_acordes
from .pipeline import orquestador
from .trabajos import GestorTrabajos

app = FastAPI(title="Motor de falab", version=__version__, docs_url=None, redoc_url=None)
trabajos = GestorTrabajos()

# Testigo de sesión: lo genera la aplicación de escritorio al lanzar el motor, de modo que
# ninguna página web abierta en el navegador pueda dar órdenes al motor local.
TESTIGO = os.environ.get("FALAB_TOKEN", "")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(tauri://localhost|https?://tauri\.localhost|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def exigir_testigo(peticion: Request, continuar):
    if TESTIGO and peticion.method != "OPTIONS":
        recibido = peticion.headers.get("x-falab-token") or peticion.query_params.get("token") or ""
        if not secrets.compare_digest(recibido, TESTIGO):
            return JSONResponse({"detail": "No autorizado."}, status_code=401)
    return await continuar(peticion)


def _proyecto(id_proyecto: str) -> dict:
    try:
        return modelo.cargar(id_proyecto)
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(404, str(error)) from error


def _componentes() -> dict:
    """Qué piezas opcionales hay instaladas; la interfaz lo muestra en el diálogo de importación."""
    from importlib.util import find_spec

    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "rubberband": shutil.which("rubberband") is not None,
        "demucs": find_spec("demucs") is not None,
        "basicPitch": find_spec("basic_pitch") is not None,
        "whisper": find_spec("mlx_whisper") is not None or find_spec("faster_whisper") is not None,
    }


@app.get("/salud")
def salud() -> dict:
    return {"estado": "ok", "version": __version__, "componentes": _componentes(),
            "carpetaDatos": str(config.DIR_DATOS)}


# ---------------------------------------------------------------- proyectos

@app.get("/proyectos")
def listar_proyectos() -> list[dict]:
    return modelo.listar()


@app.post("/proyectos/importar")
def importar(cuerpo: dict = Body(...)) -> dict:
    """Lanza el pipeline de IA sobre un archivo del disco. Devuelve el trabajo para seguir su avance."""
    ruta = cuerpo.get("ruta")
    if not ruta:
        raise HTTPException(400, "Falta la ruta del archivo.")
    opciones = cuerpo.get("opciones") or {}
    return trabajos.lanzar("importar", lambda t: orquestador.importar(Path(ruta), opciones, t)).a_dict()


@app.post("/proyectos/subir")
async def subir(archivo: UploadFile = File(...), opciones: str = Form("{}")) -> dict:
    """Variante para cuando la interfaz corre en un navegador y no conoce rutas del disco."""
    nombre = re.sub(r"[^\w\-. ]+", "_", Path(archivo.filename or "audio").name)
    destino = config.DIR_DATOS / "importados" / nombre
    destino.parent.mkdir(parents=True, exist_ok=True)
    with open(destino, "wb") as salida:
        shutil.copyfileobj(archivo.file, salida)
    opciones_dict = json.loads(opciones or "{}")
    return trabajos.lanzar("importar", lambda t: orquestador.importar(destino, opciones_dict, t)).a_dict()


@app.post("/proyectos/demo")
def crear_demo() -> dict:
    """Proyecto sintético para probar la interfaz sin tener instalados los modelos de IA."""
    from . import demo

    def tarea(trabajo):
        trabajo.informar(0.1, "Sintetizando la demostración")
        p = demo.crear_proyecto()
        return {"id": p["id"], "nombre": p["nombre"], "avisos": p["avisos"]}

    return trabajos.lanzar("importar", tarea).a_dict()


@app.get("/proyectos/{id_proyecto}")
def obtener_proyecto(id_proyecto: str) -> dict:
    return _proyecto(id_proyecto)


CAMPOS_EDITABLES = ("nombre", "velocidad", "tono", "volumenMaestro", "metronomo", "pistas", "compas")


@app.put("/proyectos/{id_proyecto}")
def guardar_proyecto(id_proyecto: str, cuerpo: dict = Body(...)) -> dict:
    """Guarda la mezcla y la edición. Las fuentes de audio no se pueden alterar desde la interfaz."""
    p = _proyecto(id_proyecto)
    fuentes = {f["id"] for f in p["fuentes"]}
    for pista in cuerpo.get("pistas", p["pistas"]):
        for clip in pista.get("clips", []):
            if clip.get("fuenteId") not in fuentes:
                raise HTTPException(400, f"El clip {clip.get('id')} referencia una fuente inexistente.")
            if clip.get("duracion", 0) <= 0 or clip.get("inicio", 0) < 0 or clip.get("desplazamiento", 0) < 0:
                raise HTTPException(400, f"El clip {clip.get('id')} tiene tiempos no válidos.")
    for campo in CAMPOS_EDITABLES:
        if campo in cuerpo:
            p[campo] = cuerpo[campo]
    modelo.guardar(p)
    return {"modificado": p["modificado"]}


@app.delete("/proyectos/{id_proyecto}")
def eliminar_proyecto(id_proyecto: str) -> dict:
    _proyecto(id_proyecto)
    modelo.eliminar(id_proyecto)
    return {"eliminado": True}


# ------------------------------------------------------------- audio y ondas

@app.get("/proyectos/{id_proyecto}/fuentes/{id_fuente}/pcm")
def pcm(id_proyecto: str, id_fuente: str, inicio: int = 0, frames: int = 262144) -> Response:
    """Tramo de audio en PCM de 16 bits estéreo entrelazado. El reproductor lo pide por fragmentos."""
    p = _proyecto(id_proyecto)
    try:
        ruta = modelo.ruta_fuente(p, id_fuente)
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    frames = max(0, min(frames, 1 << 20))
    return Response(medios.leer_pcm16(ruta, inicio, frames), media_type="application/octet-stream")


@app.get("/proyectos/{id_proyecto}/fuentes/{id_fuente}/picos")
def picos(id_proyecto: str, id_fuente: str) -> Response:
    p = _proyecto(id_proyecto)
    if id_fuente not in {f["id"] for f in p["fuentes"]}:
        raise HTTPException(404, "Fuente desconocida.")
    ruta = modelo.carpeta(id_proyecto) / "picos" / f"{id_fuente}.bin"
    if not ruta.exists():
        medios.calcular_picos(modelo.ruta_fuente(p, id_fuente), ruta)
    return Response(ruta.read_bytes(), media_type="application/octet-stream",
                    headers={"X-Falab-Frames-Por-Pico": str(config.FRAMES_POR_PICO)})


# ------------------------------------------------------------------ análisis

@app.get("/proyectos/{id_proyecto}/analisis")
def analisis(id_proyecto: str, cifrado: str = "estandar", transponer: int = 0) -> dict:
    """Mapa de pulsos, acordes (ya escritos en el cifrado pedido), letras y cancionero."""
    p = _proyecto(id_proyecto)
    if cifrado not in ("estandar", "jazz", "latino"):
        raise HTTPException(400, "Cifrado no válido.")
    con_nombres = modulo_acordes.con_nombres(
        modelo.leer_analisis(id_proyecto, "acordes", {}), cifrado, max(-12, min(12, transponer)))
    letras = modelo.leer_analisis(id_proyecto, "letras", {"idioma": None, "segmentos": []})
    notas = modelo.leer_analisis(id_proyecto, "notas", {})
    return {
        "mapaTempo": modelo.leer_analisis(id_proyecto, "mapa_tempo",
                                          {"bpm": p["bpm"], "compas": p["compas"], "pulsos": []}),
        "tonalidad": con_nombres["tonalidad"],
        "acordes": con_nombres["acordes"],
        "letras": letras,
        "cancionero": cancionero.construir(letras, con_nombres["acordes"], p["duracion"]),
        "pistasConNotas": [k for k, v in notas.items() if v],
    }


@app.get("/proyectos/{id_proyecto}/partitura")
def partitura_musicxml(id_proyecto: str, instrumento: str | None = None) -> Response:
    """MusicXML para la vista Partitura."""
    from .exportacion import partitura

    p = _proyecto(id_proyecto)
    notas = modelo.leer_analisis(id_proyecto, "notas", {})
    seleccion = {k: v for k, v in notas.items() if not instrumento or k == instrumento}
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"bpm": p["bpm"], "compas": p["compas"], "pulsos": []})
    tonalidad = modelo.leer_analisis(id_proyecto, "acordes", {}).get("tonalidad")
    destino = modelo.carpeta(id_proyecto) / "analisis" / f"partitura_{instrumento or 'todo'}.musicxml"
    try:
        partitura.a_musicxml(seleccion, mapa, p["nombre"], tonalidad, destino)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error
    return Response(destino.read_bytes(), media_type="application/vnd.recordare.musicxml+xml")


# -------------------------------------------------------------- exportación

@app.post("/proyectos/{id_proyecto}/exportar")
def lanzar_exportacion(id_proyecto: str, cuerpo: dict = Body(...)) -> dict:
    _proyecto(id_proyecto)
    return trabajos.lanzar("exportar", lambda t: exportar(id_proyecto, cuerpo, t)).a_dict()


@app.get("/proyectos/{id_proyecto}/exportaciones/{nombre}")
def descargar_exportacion(id_proyecto: str, nombre: str) -> FileResponse:
    _proyecto(id_proyecto)
    ruta = modelo.carpeta(id_proyecto) / "exportaciones" / Path(nombre).name
    if not ruta.is_file():
        raise HTTPException(404, "No existe esa exportación.")
    return FileResponse(ruta, filename=ruta.name)


# ------------------------------------------------------------------ trabajos

@app.get("/trabajos/{id_trabajo}")
def estado_trabajo(id_trabajo: str) -> dict:
    trabajo = trabajos.obtener(id_trabajo)
    if not trabajo:
        raise HTTPException(404, "Trabajo desconocido.")
    return trabajo.a_dict()


@app.post("/trabajos/{id_trabajo}/cancelar")
def cancelar_trabajo(id_trabajo: str) -> dict:
    if not trabajos.cancelar(id_trabajo):
        raise HTTPException(404, "Trabajo desconocido.")
    return {"cancelando": True}


# -------------------------------------------------------------- Google Drive

@app.get("/drive/estado")
def drive_estado() -> dict:
    return drive.estado()


@app.post("/drive/conectar")
def drive_conectar() -> dict:
    try:
        return drive.conectar()
    except FileNotFoundError as error:
        raise HTTPException(400, str(error)) from error


@app.post("/drive/desconectar")
def drive_desconectar() -> dict:
    return drive.desconectar()


@app.get("/drive/proyectos")
def drive_proyectos() -> list[dict]:
    try:
        return drive.listar_remotos()
    except PermissionError as error:
        raise HTTPException(401, str(error)) from error


@app.post("/drive/subir/{id_proyecto}")
def drive_subir(id_proyecto: str) -> dict:
    _proyecto(id_proyecto)
    return trabajos.lanzar("drive-subir", lambda t: drive.subir_proyecto(id_proyecto, t)).a_dict()


@app.post("/drive/descargar/{id_proyecto}")
def drive_descargar(id_proyecto: str) -> dict:
    return trabajos.lanzar("drive-descargar", lambda t: drive.descargar_proyecto(id_proyecto, t)).a_dict()
