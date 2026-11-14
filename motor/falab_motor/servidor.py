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

from . import (__version__, biblioteca, config, drive, edicion_letras, guias, medios, midi, paquete,
               proyecto as modelo)
from .exportacion import cancionero
from .exportacion.exportar import exportar
from .pipeline import acordes as modulo_acordes
from .pipeline import estructura as modulo_estructura
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
    if destino.suffix.lower() == paquete.EXTENSION:
        return trabajos.lanzar("importar", lambda t: paquete.importar(destino, t)).a_dict()
    opciones_dict = json.loads(opciones or "{}")
    return trabajos.lanzar("importar", lambda t: orquestador.importar(destino, opciones_dict, t)).a_dict()


@app.post("/proyectos/importar-paquete")
def importar_paquete(cuerpo: dict = Body(...)) -> dict:
    """Importa un proyecto completo desde un archivo .falab del disco."""
    ruta = cuerpo.get("ruta")
    if not ruta:
        raise HTTPException(400, "Falta la ruta del archivo.")
    return trabajos.lanzar("importar", lambda t: paquete.importar(Path(ruta), t)).a_dict()


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
    drive.anotar_cambio(id_proyecto)
    return {"modificado": p["modificado"]}


@app.delete("/proyectos/{id_proyecto}")
def eliminar_proyecto(id_proyecto: str) -> dict:
    _proyecto(id_proyecto)
    modelo.eliminar(id_proyecto)
    biblioteca.olvidar_proyecto(id_proyecto)
    return {"eliminado": True}


@app.post("/proyectos/{id_proyecto}/empaquetar")
def empaquetar(id_proyecto: str, cuerpo: dict = Body(default={})) -> dict:
    """Exporta el proyecto completo a un archivo .falab."""
    _proyecto(id_proyecto)
    destino = cuerpo.get("destino")
    return trabajos.lanzar("exportar", lambda t: paquete.exportar(id_proyecto, destino, t)).a_dict()


@app.put("/proyectos/{id_proyecto}/letras")
def editar_letras(id_proyecto: str, cuerpo: dict = Body(...)) -> dict:
    """Guarda la letra corregida a mano. La transcripción original se conserva aparte."""
    _proyecto(id_proyecto)
    actuales = modelo.leer_analisis(id_proyecto, "letras", {"idioma": None, "segmentos": []})
    if modelo.leer_analisis(id_proyecto, "letras_original") is None:
        modelo.escribir_analisis(id_proyecto, "letras_original", actuales)
    try:
        nuevas = edicion_letras.aplicar(actuales, cuerpo.get("lineas", []))
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(400, "Líneas de letra no válidas.") from error
    modelo.escribir_analisis(id_proyecto, "letras", nuevas)
    drive.anotar_cambio(id_proyecto)
    return {"segmentos": len(nuevas["segmentos"])}


@app.post("/proyectos/{id_proyecto}/acordes")
def recalcular_acordes(id_proyecto: str, cuerpo: dict = Body(...)) -> dict:
    """Vuelve a cifrar los acordes con otro nivel de detalle (normal, alto o maximo)."""
    _proyecto(id_proyecto)
    detalle = cuerpo.get("detalle", "normal")
    if detalle not in modulo_acordes.DETALLES:
        raise HTTPException(400, "Nivel de detalle no válido.")
    return trabajos.lanzar("acordes", lambda t: orquestador.recalcular_acordes(id_proyecto, detalle, t)).a_dict()


@app.put("/proyectos/{id_proyecto}/estructura")
def guardar_estructura(id_proyecto: str, cuerpo: dict = Body(...)) -> dict:
    """Guarda los marcadores de ensayo editados a mano (nombre, inicio y compás de cada sección)."""
    p = _proyecto(id_proyecto)
    try:
        secciones = modulo_estructura.normalizar(cuerpo.get("secciones", []), p["duracion"])
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(400, "Secciones no válidas.") from error
    modelo.escribir_analisis(id_proyecto, "estructura", {"secciones": secciones, "automatica": False})
    drive.anotar_cambio(id_proyecto)
    return {"secciones": secciones}


@app.post("/proyectos/{id_proyecto}/estructura/detectar")
def detectar_estructura(id_proyecto: str) -> dict:
    _proyecto(id_proyecto)
    return trabajos.lanzar("estructura", lambda t: orquestador.detectar_estructura(id_proyecto, t)).a_dict()


@app.post("/proyectos/{id_proyecto}/mapa-tempo")
def corregir_mapa(id_proyecto: str, cuerpo: dict = Body(...)) -> dict:
    """Corrige el mapa de pulsos: «doble», «mitad» o «desplazar» el primer tiempo."""
    p = _proyecto(id_proyecto)
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"pulsos": []})
    try:
        nuevo = modulo_estructura.corregir_mapa(mapa, cuerpo.get("operacion", ""))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    modelo.escribir_analisis(id_proyecto, "mapa_tempo", nuevo)
    p["bpm"] = nuevo["bpm"]
    modelo.guardar(p)
    drive.anotar_cambio(id_proyecto)
    return {"bpm": nuevo["bpm"], "pulsos": len(nuevo["pulsos"])}


@app.post("/proyectos/{id_proyecto}/guias")
def generar_guias(id_proyecto: str) -> dict:
    """Genera la pista de guías de voz («Coro, dos, tres, cuatro») a partir de la estructura."""
    _proyecto(id_proyecto)
    return trabajos.lanzar("guias", lambda t: guias.generar(id_proyecto, t)).a_dict()


# ---------------------------------------------------------------- pedal MIDI

@app.get("/midi/estado")
def midi_estado() -> dict:
    return midi.explorar()


@app.get("/midi/eventos")
def midi_eventos(desde: int = 0, espera: float = 20.0) -> dict:
    """Espera (hasta `espera` segundos) a que llegue un mensaje MIDI posterior al número `desde`."""
    return {"eventos": midi.esperar(desde, espera)}


# ---------------------------------------------------------------- biblioteca

@app.get("/biblioteca")
def obtener_biblioteca() -> dict:
    datos = biblioteca.cargar()
    return {"playlists": datos["playlists"], "ajustes": datos["ajustes"]}


@app.put("/biblioteca/playlists")
def guardar_playlists(cuerpo: dict = Body(...)) -> dict:
    try:
        return {"playlists": biblioteca.fijar_playlists(cuerpo.get("playlists", []))}
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.put("/biblioteca/ajustes")
def guardar_ajustes(cuerpo: dict = Body(...)) -> dict:
    try:
        return {"ajustes": biblioteca.fijar_ajustes(cuerpo)}
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


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
    guardado = modelo.leer_analisis(id_proyecto, "acordes", {}) or {}
    if guardado.get("acordes") and guardado.get("version", 1) < 2:
        # Proyecto analizado antes de existir la línea de bajo: se completa ahora, una sola vez.
        try:
            from .trabajos import Trabajo
            orquestador.recalcular_acordes(id_proyecto, guardado.get("detalle", "normal"), Trabajo(id="auto", tipo="acordes"))
            guardado = modelo.leer_analisis(id_proyecto, "acordes", {}) or {}
        except Exception:  # noqa: BLE001 - si falla se sirve lo que había
            pass
    con_nombres = modulo_acordes.con_nombres(guardado, cifrado, max(-12, min(12, transponer)))
    letras = modelo.leer_analisis(id_proyecto, "letras", {"idioma": None, "segmentos": []})
    notas = modelo.leer_analisis(id_proyecto, "notas", {})
    secciones = (modelo.leer_analisis(id_proyecto, "estructura", {}) or {}).get("secciones", [])
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"bpm": p["bpm"], "compas": p["compas"], "pulsos": []})
    return {
        # El mapa se entrega ya renumerado con el compás de cada sección.
        "mapaTempo": modulo_estructura.aplicar_compases(mapa, secciones),
        "secciones": secciones,
        "tonalidad": con_nombres["tonalidad"],
        "acordes": con_nombres["acordes"],
        "lineaBajo": con_nombres["lineaBajo"],
        "ostinatos": con_nombres["ostinatos"],
        "letras": letras,
        "cancionero": cancionero.construir(letras, con_nombres["acordes"], p["duracion"]),
        "pistasConNotas": [k for k, v in notas.items() if v],
        "detalleAcordes": (modelo.leer_analisis(id_proyecto, "acordes", {}) or {}).get("detalle", "normal"),
        "letraEditada": bool(letras.get("editada")),
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


@app.get("/proyectos/{id_proyecto}/notas")
def notas_de_pista(id_proyecto: str, instrumento: str = "voz") -> dict:
    """Notas detectadas de un instrumento (para el carril de afinación del karaoke)."""
    _proyecto(id_proyecto)
    todas = modelo.leer_analisis(id_proyecto, "notas", {})
    return {"notas": todas.get(instrumento, [])}


@app.get("/proyectos/{id_proyecto}/alphatex")
def partitura_sincronizada(id_proyecto: str, instrumento: str, modo: str = "ambas") -> dict:
    """Partitura y/o tablatura de un instrumento, con el instante en que empieza cada compás."""
    from .exportacion import alphatex

    p = _proyecto(id_proyecto)
    todas = modelo.leer_analisis(id_proyecto, "notas", {})
    secciones = (modelo.leer_analisis(id_proyecto, "estructura", {}) or {}).get("secciones", [])
    mapa = modelo.leer_analisis(id_proyecto, "mapa_tempo", {"bpm": p["bpm"], "compas": p["compas"], "pulsos": []})
    mapa = modulo_estructura.aplicar_compases(mapa, secciones)
    try:
        return alphatex.generar(todas.get(instrumento, []), mapa, p["duracion"], instrumento, p["nombre"], modo)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


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
