"""Servidor de banda: la Mac comparte su biblioteca con los demás músicos y procesa lo que suban.

Es una aplicación web APARTE de la API que usa la app de escritorio. La API de escritorio lo
puede todo y solo escucha a la propia app; esta se expone a internet a través de un túnel HTTPS
(p. ej. Tailscale Funnel) y solo permite, con usuario y contraseña:

  · ver la biblioteca y descargar o reproducir en streaming cada canción (.falab);
  · subir una canción para que esta Mac la analice;
  · ver la cola de trabajos.

No hay nube ni servidores de terceros: las cuentas, las canciones y el análisis viven en esta Mac.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, paquete, proyecto as modelo
from .pipeline import orquestador
from .trabajos import GestorTrabajos
from .zip_virtual import Entrada, ZipVirtual, crc_de_archivo

PUERTO = 8787
DIAS_DE_SESION = 30
TAMANO_MAXIMO = 600 * 1024 * 1024       # por canción subida
INTENTOS_ANTES_DE_ESPERAR = 5
ESPERA_TRAS_FALLOS = 60.0               # segundos

_cerrojo = threading.RLock()
_fallos: dict[str, tuple[int, float]] = {}   # usuario -> (intentos fallidos, hasta cuándo esperar)


# ------------------------------------------------------------------ cuentas

def _ruta() -> Path:
    return config.DIR_CONFIG / "banda.json"


def _cargar() -> dict:
    try:
        datos = json.loads(_ruta().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        datos = {}
    datos.setdefault("usuarios", [])
    datos.setdefault("sesiones", {})        # huella del testigo -> {usuario, caduca}
    datos.setdefault("subidas", {})         # id de proyecto -> nombre de quien lo subió
    datos.setdefault("activo", False)
    datos.setdefault("direccion", "")
    return datos


def _guardar(datos: dict) -> None:
    ruta = _ruta()
    ruta.parent.mkdir(parents=True, exist_ok=True)
    temporal = ruta.with_suffix(".tmp")
    temporal.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    temporal.replace(ruta)
    try:
        ruta.chmod(0o600)
    except OSError:
        pass


def _huella_de_clave(clave: str, sal: bytes) -> str:
    # scrypt: lento a propósito, para que robar el archivo no permita probar claves a millones por segundo.
    return hashlib.scrypt(clave.encode("utf-8"), salt=sal, n=2 ** 14, r=8, p=1, dklen=32).hex()


def _nombre_valido(nombre: str) -> str:
    nombre = nombre.strip()
    if not re.fullmatch(r"[\w .\-]{2,30}", nombre, flags=re.UNICODE):
        raise ValueError("El nombre debe tener entre 2 y 30 letras, números o espacios.")
    return nombre


def crear_usuario(nombre: str, clave: str) -> dict:
    nombre = _nombre_valido(nombre)
    if len(clave) < 8:
        raise ValueError("La contraseña debe tener al menos 8 caracteres.")
    with _cerrojo:
        datos = _cargar()
        if any(u["nombre"].lower() == nombre.lower() for u in datos["usuarios"]):
            raise ValueError("Ya existe un músico con ese nombre.")
        sal = secrets.token_bytes(16)
        usuario = {"id": secrets.token_hex(5), "nombre": nombre, "sal": sal.hex(), "clave": _huella_de_clave(clave, sal)}
        datos["usuarios"].append(usuario)
        _guardar(datos)
    return {"id": usuario["id"], "nombre": nombre}


def cambiar_clave(id_usuario: str, clave: str) -> None:
    if len(clave) < 8:
        raise ValueError("La contraseña debe tener al menos 8 caracteres.")
    with _cerrojo:
        datos = _cargar()
        usuario = next((u for u in datos["usuarios"] if u["id"] == id_usuario), None)
        if not usuario:
            raise KeyError("Músico desconocido.")
        sal = secrets.token_bytes(16)
        usuario["sal"], usuario["clave"] = sal.hex(), _huella_de_clave(clave, sal)
        # Cambiar la contraseña cierra todas sus sesiones abiertas.
        datos["sesiones"] = {h: s for h, s in datos["sesiones"].items() if s["usuario"] != id_usuario}
        _guardar(datos)


def eliminar_usuario(id_usuario: str) -> None:
    with _cerrojo:
        datos = _cargar()
        datos["usuarios"] = [u for u in datos["usuarios"] if u["id"] != id_usuario]
        datos["sesiones"] = {h: s for h, s in datos["sesiones"].items() if s["usuario"] != id_usuario}
        _guardar(datos)


def iniciar_sesion(nombre: str, clave: str) -> dict:
    """Devuelve {testigo, usuario}. Tras varios fallos seguidos hay que esperar."""
    clave_de_fallos = nombre.strip().lower()
    with _cerrojo:
        intentos, hasta = _fallos.get(clave_de_fallos, (0, 0.0))
        if time.time() < hasta:
            raise PermissionError("Demasiados intentos. Espera un minuto y vuelve a probar.")
        datos = _cargar()
        usuario = next((u for u in datos["usuarios"] if u["nombre"].lower() == clave_de_fallos), None)
        # Se calcula la huella aunque el usuario no exista: así no se distingue por el tiempo de respuesta.
        sal = bytes.fromhex(usuario["sal"]) if usuario else b"\x00" * 16
        correcta = secrets.compare_digest(_huella_de_clave(clave, sal), usuario["clave"] if usuario else "")
        if not usuario or not correcta:
            intentos += 1
            _fallos[clave_de_fallos] = (0, time.time() + ESPERA_TRAS_FALLOS) if intentos >= INTENTOS_ANTES_DE_ESPERAR else (intentos, 0.0)
            raise PermissionError("Nombre o contraseña incorrectos.")
        _fallos.pop(clave_de_fallos, None)
        testigo = secrets.token_urlsafe(32)
        ahora = time.time()
        datos["sesiones"] = {h: s for h, s in datos["sesiones"].items() if s["caduca"] > ahora}
        # Solo se guarda la huella del testigo: quien lea el archivo no puede hacerse pasar por nadie.
        datos["sesiones"][hashlib.sha256(testigo.encode()).hexdigest()] = {
            "usuario": usuario["id"], "caduca": ahora + DIAS_DE_SESION * 86400}
        _guardar(datos)
    return {"testigo": testigo, "usuario": {"id": usuario["id"], "nombre": usuario["nombre"]}}


def usuario_de(testigo: str) -> dict | None:
    if not testigo:
        return None
    datos = _cargar()
    sesion = datos["sesiones"].get(hashlib.sha256(testigo.encode()).hexdigest())
    if not sesion or sesion["caduca"] < time.time():
        return None
    usuario = next((u for u in datos["usuarios"] if u["id"] == sesion["usuario"]), None)
    return {"id": usuario["id"], "nombre": usuario["nombre"]} if usuario else None


def cerrar_sesion(testigo: str) -> None:
    with _cerrojo:
        datos = _cargar()
        if datos["sesiones"].pop(hashlib.sha256(testigo.encode()).hexdigest(), None):
            _guardar(datos)


def estado() -> dict:
    datos = _cargar()
    return {"activo": bool(datos["activo"]), "funcionando": _servidor["hilo"] is not None, "puerto": PUERTO,
            "direccion": datos["direccion"], "usuarios": [{"id": u["id"], "nombre": u["nombre"]} for u in datos["usuarios"]],
            "interfazLista": _carpeta_web().joinpath("index.html").exists()}


def fijar(activo: bool | None = None, direccion: str | None = None) -> dict:
    with _cerrojo:
        datos = _cargar()
        if activo is not None:
            datos["activo"] = bool(activo)
        if direccion is not None:
            direccion = direccion.strip().rstrip("/")
            if direccion and not re.fullmatch(r"https://[\w.\-]+(:\d+)?", direccion):
                raise ValueError("La dirección debe ser del tipo https://nombre.ejemplo.net")
            datos["direccion"] = direccion
        _guardar(datos)
    if activo is True:
        arrancar()
    elif activo is False:
        detener()
    return estado()


# ------------------------------------------------------------------ canciones

def _zip_de(id_proyecto: str) -> ZipVirtual:
    """El proyecto como .falab virtual. Los CRC se calculan una vez y se recuerdan."""
    carpeta = modelo.carpeta(id_proyecto)
    cache_ruta = config.DIR_DATOS / "banda" / "indices" / f"{id_proyecto}.json"
    try:
        cache = json.loads(cache_ruta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = {}
    entradas = []
    nueva_cache = {}
    for ruta in sorted(carpeta.rglob("*")):
        relativo = ruta.relative_to(carpeta).as_posix()
        if not ruta.is_file() or relativo.split("/")[0] in paquete.NO_EMPAQUETAR or ruta.suffix == ".tmp":
            continue
        info = ruta.stat()
        firma = f"{info.st_size}:{info.st_mtime_ns}"
        crc = cache.get(relativo, {}).get("crc") if cache.get(relativo, {}).get("firma") == firma else None
        if crc is None:
            crc = crc_de_archivo(ruta)
        nueva_cache[relativo] = {"firma": firma, "crc": crc}
        entradas.append(Entrada(relativo, info.st_size, crc, ruta=ruta))
    if nueva_cache != cache:
        cache_ruta.parent.mkdir(parents=True, exist_ok=True)
        cache_ruta.write_text(json.dumps(nueva_cache), encoding="utf-8")
    extra = json.dumps(paquete.datos_para_reproductor(id_proyecto), ensure_ascii=False).encode("utf-8")
    import zlib

    entradas.append(Entrada("reproductor.json", len(extra), zlib.crc32(extra) & 0xFFFFFFFF, datos=extra))
    return ZipVirtual(entradas)


_zips: dict[str, tuple[str, ZipVirtual]] = {}


def paquete_virtual(id_proyecto: str) -> ZipVirtual:
    """Devuelve el .falab virtual, rehaciéndolo solo si el proyecto cambió."""
    carpeta = modelo.carpeta(id_proyecto)
    if not (carpeta / "proyecto.json").exists():
        raise FileNotFoundError("Esa canción ya no está en la biblioteca.")
    firma = str(max((r.stat().st_mtime_ns for r in carpeta.rglob("*.json")), default=0))
    with _cerrojo:
        guardado = _zips.get(id_proyecto)
        if not guardado or guardado[0] != firma:
            guardado = (firma, _zip_de(id_proyecto))
            _zips[id_proyecto] = guardado
            for sobrante in list(_zips)[:-24]:
                del _zips[sobrante]
    return guardado[1]


# ------------------------------------------------------------------ aplicación web

# ------------------------------------------------------------------ sala de sincronización
#
# Un dispositivo «dirige» (publica qué canción suena y por dónde va) y los demás «siguen». La
# posición viaja con la hora del servidor en que era cierta: cada dispositivo calcula su desfase
# con ese reloj y así todos caen en el mismo punto aunque el aviso tarde en llegarles.

SALA_CADUCA = 20.0      # segundos sin latido del director para dar la sesión por terminada
_sala: dict = {"version": 0, "estado": None, "latido": 0.0, "siguen": {}}


def _ahora_ms() -> float:
    return time.time() * 1000


def sala_actual(sigue: str | None = None) -> dict:
    """Estado de la sala. `sigue` apunta a quien pregunta como seguidor, para que el director lo vea."""
    with _cerrojo:
        ahora = time.time()
        if _sala["estado"] is not None and ahora - _sala["latido"] > SALA_CADUCA:
            _sala["estado"] = None
            _sala["version"] += 1
        if sigue:
            _sala["siguen"][sigue] = ahora
        siguen = sorted(nombre for nombre, visto in _sala["siguen"].items() if ahora - visto < 40)
        return {"version": _sala["version"], "ahora": _ahora_ms(), "sala": _sala["estado"], "siguen": siguen,
                "disponible": True}


def sala_publicar(director: str, datos: dict) -> dict:
    """El director publica el estado del transporte. Quien publica el último pasa a dirigir."""
    estado = {
        "director": director,
        "cliente": str(datos.get("cliente", ""))[:64],
        "proyecto": str(datos.get("proyecto", ""))[:64],
        "nombre": str(datos.get("nombre", ""))[:200],
        "sonando": bool(datos.get("sonando")),
        "posicion": max(0.0, float(datos.get("posicion", 0))),
        "momento": float(datos.get("momento", _ahora_ms())),
        "velocidad": min(2.0, max(0.25, float(datos.get("velocidad", 1)))),
        "tono": int(min(12, max(-12, float(datos.get("tono", 0))))),
    }
    with _cerrojo:
        anterior = _sala["estado"]
        # Otro dispositivo tomó la dirección: el latido del antiguo director ya no cuenta.
        relevado = bool(anterior and anterior["cliente"] != estado["cliente"] and datos.get("latido"))
        if not relevado:
            _sala["latido"] = time.time()
            if anterior != estado:
                _sala["estado"] = estado
                _sala["version"] += 1
    return sala_actual() | {"relevado": relevado}


def sala_cerrar(cliente: str) -> dict:
    with _cerrojo:
        if _sala["estado"] is not None and _sala["estado"]["cliente"] == cliente:
            _sala["estado"] = None
            _sala["version"] += 1
    return sala_actual()


def _carpeta_web() -> Path:
    """Interfaz web ya compilada (la genera `npm run build`, que forma parte de compilar la app)."""
    return Path(__file__).resolve().parents[2] / "app" / "dist"


def crear_app(trabajos: GestorTrabajos) -> FastAPI:
    app = FastAPI(title="falab · servidor de banda", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    # Las apps de iPad y Android llaman desde su propio origen interno.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(tauri://localhost|https?://tauri\.localhost)$",
        allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Range", "Content-Type"],
        expose_headers=["Content-Range", "Content-Length", "Accept-Ranges"],
    )
    pendientes: dict[str, dict] = {}    # id de trabajo -> {nombre, usuario}
    # Pases de descarga: permiten al navegador bajar un .falab con un enlace normal (que no puede
    # llevar la cabecera de sesión) sin poner el testigo de sesión en la dirección.
    pases: dict[str, tuple[str, float]] = {}   # pase -> (id de proyecto, caduca)

    def exigir(peticion: Request) -> dict:
        cabecera = peticion.headers.get("authorization", "")
        usuario = usuario_de(cabecera[7:] if cabecera.lower().startswith("bearer ") else "")
        if not usuario:
            raise HTTPException(401, "Inicia sesión.")
        return usuario

    @app.get("/banda/info")
    def info() -> dict:
        return {"falab": True, "version": __version__}

    @app.post("/banda/sesion")
    async def entrar(peticion: Request) -> dict:
        try:
            cuerpo = await peticion.json()
            return iniciar_sesion(str(cuerpo.get("nombre", "")), str(cuerpo.get("clave", "")))
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error
        except (ValueError, TypeError) as error:
            raise HTTPException(400, "Petición no válida.") from error

    @app.get("/banda/yo")
    def yo(peticion: Request) -> dict:
        return exigir(peticion)

    @app.delete("/banda/sesion")
    def salir(peticion: Request) -> dict:
        exigir(peticion)
        cerrar_sesion(peticion.headers.get("authorization", "")[7:])
        return {"cerrada": True}

    @app.post("/banda/clave")
    async def nueva_clave(peticion: Request) -> dict:
        usuario = exigir(peticion)
        cuerpo = await peticion.json()
        try:
            cambiar_clave(usuario["id"], str(cuerpo.get("clave", "")))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return {"cambiada": True}

    @app.get("/banda/sala")
    async def sala(peticion: Request, version: int = -1, espera: float = 0, sigue: int = 0) -> dict:
        usuario = exigir(peticion)
        # Espera larga: la respuesta se retiene hasta que la sala cambie, y así el aviso es inmediato.
        limite = time.time() + min(max(espera, 0.0), 25.0)
        while True:
            actual = sala_actual(usuario["nombre"] if sigue else None)
            if actual["version"] != version or time.time() >= limite or await peticion.is_disconnected():
                return actual
            await asyncio.sleep(0.05)

    @app.post("/banda/sala")
    async def publicar_sala(peticion: Request) -> dict:
        usuario = exigir(peticion)
        try:
            return sala_publicar(usuario["nombre"], await peticion.json())
        except (ValueError, TypeError) as error:
            raise HTTPException(400, "Petición no válida.") from error

    @app.delete("/banda/sala")
    def cerrar_sala(peticion: Request, cliente: str = "") -> dict:
        exigir(peticion)
        return sala_cerrar(cliente)

    @app.get("/banda/canciones")
    def canciones(peticion: Request) -> dict:
        exigir(peticion)
        subidas = _cargar()["subidas"]
        lista = []
        for resumen in modelo.listar():
            try:
                tamano = paquete_virtual(resumen["id"]).tamano
            except Exception:  # noqa: BLE001 - un proyecto dañado no debe ocultar los demás
                continue
            lista.append({**resumen, "peso": tamano, "tieneVideo": False, "subidoPor": subidas.get(resumen["id"])})
        cola = []
        for id_trabajo, dato in list(pendientes.items()):
            trabajo = trabajos.obtener(id_trabajo)
            if not trabajo or trabajo.estado in ("completado", "cancelado"):
                pendientes.pop(id_trabajo, None)
                continue
            cola.append({"id": id_trabajo, "nombre": dato["nombre"], "usuario": dato["usuario"], "estado": trabajo.estado,
                         "progreso": round(trabajo.progreso, 3), "etapa": trabajo.etapa, "error": trabajo.error})
            if trabajo.estado == "error" and time.time() - dato.setdefault("falloEn", time.time()) > 600:
                pendientes.pop(id_trabajo, None)   # los errores se muestran diez minutos
        return {"canciones": lista, "cola": cola}

    @app.post("/banda/canciones/{id_proyecto}/pase")
    def pedir_pase(id_proyecto: str, peticion: Request) -> dict:
        """Pase de un solo uso práctico: vale dos minutos y solo para descargar esta canción."""
        exigir(peticion)
        ahora = time.time()
        for viejo in [k for k, (_, caduca) in pases.items() if caduca < ahora]:
            del pases[viejo]
        pase = secrets.token_urlsafe(24)
        pases[pase] = (modelo.validar_id(id_proyecto), ahora + 120)
        return {"pase": pase}

    @app.get("/banda/canciones/{id_proyecto}/paquete")
    def descargar(id_proyecto: str, peticion: Request, pase: str = ""):
        """El proyecto como .falab. Admite rangos: el reproductor pide solo los trozos que necesita."""
        valido = pases.get(pase)
        if not (valido and valido[0] == id_proyecto and valido[1] > time.time()):
            exigir(peticion)
        try:
            virtual = paquete_virtual(modelo.validar_id(id_proyecto))
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(404, str(error)) from error
        nombre = re.sub(r"[^\w\- ]+", "_", modelo.cargar(id_proyecto)["nombre"], flags=re.UNICODE).strip() or "proyecto"
        cabeceras = {"Accept-Ranges": "bytes", "Content-Disposition": f"attachment; filename*=UTF-8''{__import__('urllib.parse').parse.quote(nombre)}.falab"}
        rango = re.fullmatch(r"bytes=(\d*)-(\d*)", peticion.headers.get("range", "").strip())
        if not rango or (not rango.group(1) and not rango.group(2)):
            cabeceras["Content-Length"] = str(virtual.tamano)
            return StreamingResponse(virtual.leer(), media_type="application/octet-stream", headers=cabeceras)
        if rango.group(1):
            desde = int(rango.group(1))
            hasta = min(int(rango.group(2)) + 1, virtual.tamano) if rango.group(2) else virtual.tamano
        else:                                   # «bytes=-N»: los últimos N
            desde, hasta = max(0, virtual.tamano - int(rango.group(2))), virtual.tamano
        if desde >= virtual.tamano or hasta <= desde:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{virtual.tamano}"})
        cabeceras["Content-Range"] = f"bytes {desde}-{hasta - 1}/{virtual.tamano}"
        cabeceras["Content-Length"] = str(hasta - desde)
        return StreamingResponse(virtual.leer(desde, hasta), status_code=206, media_type="application/octet-stream", headers=cabeceras)

    @app.post("/banda/canciones")
    async def subir(peticion: Request, archivo: UploadFile = File(...), separarCoros: str = Form("")) -> dict:
        """Recibe una canción y la pone en la cola de análisis de esta Mac."""
        usuario = exigir(peticion)
        nombre = re.sub(r"[^\w\-. ]+", "_", Path(archivo.filename or "cancion").name, flags=re.UNICODE)[:120]
        if Path(nombre).suffix.lower() not in config.EXTENSIONES_ADMITIDAS:
            raise HTTPException(400, "Formato no admitido. Sube audio (MP3, WAV, FLAC, OGG, AAC) o video (MP4, MOV, MKV).")
        destino = config.DIR_DATOS / "banda" / "subidas" / f"{secrets.token_hex(4)}_{nombre}"
        destino.parent.mkdir(parents=True, exist_ok=True)
        recibido = 0
        try:
            with open(destino, "wb") as salida:
                while bloque := await archivo.read(1 << 20):
                    recibido += len(bloque)
                    if recibido > TAMANO_MAXIMO:
                        raise HTTPException(413, f"El archivo supera el máximo de {TAMANO_MAXIMO // (1024 * 1024)} MB.")
                    salida.write(bloque)
        except BaseException:
            destino.unlink(missing_ok=True)
            raise
        if recibido == 0:
            destino.unlink(missing_ok=True)
            raise HTTPException(400, "El archivo está vacío.")
        opciones = {"separarCoros": separarCoros == "1"}

        def tarea(trabajo):
            try:
                resultado = orquestador.importar(destino, opciones, trabajo)
                # El proyecto toma el nombre del archivo tal como lo subió el músico.
                p = modelo.cargar(resultado["id"])
                p["nombre"] = Path(nombre).stem
                modelo.guardar(p)
                with _cerrojo:
                    datos = _cargar()
                    datos["subidas"][resultado["id"]] = usuario["nombre"]
                    _guardar(datos)
                return resultado
            finally:
                destino.unlink(missing_ok=True)   # el original ya está dentro del proyecto

        trabajo = trabajos.lanzar("importar", tarea)
        pendientes[trabajo.id] = {"nombre": Path(nombre).stem, "usuario": usuario["nombre"]}
        return {"trabajo": trabajo.id}

    @app.exception_handler(HTTPException)
    async def errores(_peticion: Request, error: HTTPException):
        return JSONResponse({"detail": error.detail}, status_code=error.status_code, headers=getattr(error, "headers", None))

    # La interfaz web del reproductor, servida por esta misma Mac. A la página se le añade una
    # marca para que arranque en modo reproductor de banda también en un ordenador de sobremesa.
    web = _carpeta_web()
    if web.joinpath("index.html").exists():
        @app.get("/")
        @app.get("/index.html")
        def portada() -> Response:
            html = web.joinpath("index.html").read_text(encoding="utf-8")
            html = html.replace("<head>", "<head><script>window.__FALAB_BANDA__=true</script>", 1)
            return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})

        app.mount("/", StaticFiles(directory=str(web), html=True), name="web")
    return app


# ------------------------------------------------------------------ arranque y parada

_servidor: dict = {"hilo": None, "uvicorn": None, "despierto": None}


def arrancar(trabajos: GestorTrabajos | None = None) -> None:
    """Pone a escuchar el servidor de banda en 127.0.0.1 (el túnel HTTPS lo saca a internet)."""
    import subprocess

    import uvicorn

    with _cerrojo:
        if _servidor["hilo"] is not None:
            return
        gestor = trabajos or _servidor.get("trabajos")
        if gestor is None:
            raise RuntimeError("Falta la cola de trabajos.")
        _servidor["trabajos"] = gestor
        configuracion = uvicorn.Config(crear_app(gestor), host="127.0.0.1", port=PUERTO, log_level="warning",
                                       proxy_headers=True, forwarded_allow_ips="127.0.0.1")
        servidor = uvicorn.Server(configuracion)
        servidor.install_signal_handlers = lambda: None   # no es el hilo principal
        hilo = threading.Thread(target=servidor.run, name="falab-banda", daemon=True)
        hilo.start()
        _servidor.update(hilo=hilo, uvicorn=servidor)
        # Mientras se comparte, la Mac no entra en reposo (con la tapa cerrada sí lo hará).
        if shutil.which("caffeinate") and _servidor["despierto"] is None:
            import os

            _servidor["despierto"] = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        _mantener_despierto_en_windows(True)


def _mantener_despierto_en_windows(activo: bool) -> None:
    """En Windows se pide al sistema que no suspenda el equipo mientras se comparte con la banda."""
    import sys

    if sys.platform != "win32":
        return
    try:
        import ctypes

        CONTINUO, SISTEMA = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(CONTINUO | (SISTEMA if activo else 0))
    except Exception:   # noqa: BLE001 — es una cortesía: si falla, se comparte igual
        pass


def detener() -> None:
    _mantener_despierto_en_windows(False)
    with _cerrojo:
        if _servidor["uvicorn"] is not None:
            _servidor["uvicorn"].should_exit = True
        if _servidor["despierto"] is not None:
            _servidor["despierto"].terminate()
        _servidor.update(hilo=None, uvicorn=None, despierto=None)


def arrancar_si_procede(trabajos: GestorTrabajos) -> None:
    _servidor["trabajos"] = trabajos
    if _cargar()["activo"]:
        arrancar(trabajos)
