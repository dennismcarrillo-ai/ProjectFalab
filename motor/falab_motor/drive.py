"""Sincronización de proyectos con Google Drive (OAuth 2.0 para aplicaciones de escritorio).

* El usuario aporta su propio cliente OAuth (ver docs/GOOGLE_DRIVE.md); el archivo descargado de
  Google Cloud se guarda como ~/Falab/config/credenciales_drive.json.
* Alcance mínimo `drive.file`: falab solo ve los archivos que él mismo creó, nunca el resto del Drive.
* Los proyectos viven en la carpeta «falab_projects», una subcarpeta por proyecto.
* La sincronización es incremental: se compara el MD5 y solo viajan los archivos que cambiaron
  (al editar, normalmente solo proyecto.json, de unos pocos KB).
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path

from . import config, proyecto as modelo
from .trabajos import Trabajo

ALCANCES = ["https://www.googleapis.com/auth/drive.file"]
TIPO_CARPETA = "application/vnd.google-apps.folder"
NO_SINCRONIZAR = {"exportaciones", "picos"}  # se pueden regenerar; no merece la pena subirlos


def _ruta_cliente() -> Path:
    return config.DIR_CONFIG / "credenciales_drive.json"


def _ruta_token() -> Path:
    return config.DIR_CONFIG / "token_drive.json"


def estado() -> dict:
    from . import biblioteca

    datos = biblioteca.cargar()
    return {"configurado": _ruta_cliente().exists(), "conectado": _ruta_token().exists(),
            "rutaCredenciales": str(_ruta_cliente()),
            "automatico": bool(datos["ajustes"].get("driveAutomatico")),
            "pendientes": sorted(datos["pendientesDrive"]),
            "ultimoError": _sincronizador["error"], "ultimaSincronizacion": _sincronizador["ultima"]}


def conectar() -> dict:
    """Abre el navegador para que el usuario autorice a falab y guarda el token de refresco."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not _ruta_cliente().exists():
        raise FileNotFoundError(
            f"Falta el archivo de credenciales de Google en {_ruta_cliente()}. Consulta docs/GOOGLE_DRIVE.md.")
    flujo = InstalledAppFlow.from_client_secrets_file(str(_ruta_cliente()), ALCANCES)
    credenciales = flujo.run_local_server(
        port=0, open_browser=True, timeout_seconds=300,
        authorization_prompt_message="",
        success_message="falab ya está conectado a Google Drive. Puedes cerrar esta pestaña.")
    _guardar_token(credenciales)
    return estado()


def desconectar() -> dict:
    _ruta_token().unlink(missing_ok=True)
    return estado()


def _guardar_token(credenciales) -> None:
    ruta = _ruta_token()
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(credenciales.to_json(), encoding="utf-8")
    os.chmod(ruta, 0o600)


def _servicio():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    if not _ruta_token().exists():
        raise PermissionError("Primero conecta tu cuenta de Google Drive.")
    credenciales = Credentials.from_authorized_user_file(str(_ruta_token()), ALCANCES)
    if not credenciales.valid:
        credenciales.refresh(Request())
        _guardar_token(credenciales)
    return build("drive", "v3", credentials=credenciales, cache_discovery=False)


def _literal(texto: str) -> str:
    return texto.replace("\\", "\\\\").replace("'", "\\'")


def _listar(servicio, consulta: str, campos: str) -> list[dict]:
    elementos, pagina = [], None
    while True:
        respuesta = servicio.files().list(q=consulta, spaces="drive", pageSize=200, pageToken=pagina,
                                          fields=f"nextPageToken, files({campos})").execute()
        elementos += respuesta.get("files", [])
        pagina = respuesta.get("nextPageToken")
        if not pagina:
            return elementos


def _carpeta(servicio, nombre: str, padre: str | None = None, propiedades: dict | None = None) -> str:
    """Devuelve el id de la carpeta, creándola si no existe."""
    consulta = f"name = '{_literal(nombre)}' and mimeType = '{TIPO_CARPETA}' and trashed = false"
    consulta += f" and '{padre}' in parents" if padre else " and 'root' in parents"
    existentes = _listar(servicio, consulta, "id")
    if existentes:
        return existentes[0]["id"]
    cuerpo = {"name": nombre, "mimeType": TIPO_CARPETA}
    if padre:
        cuerpo["parents"] = [padre]
    if propiedades:
        cuerpo["appProperties"] = propiedades
    return servicio.files().create(body=cuerpo, fields="id").execute()["id"]


def _md5(ruta: Path) -> str:
    resumen = hashlib.md5()  # noqa: S324 - es el hash que publica Drive, no se usa para seguridad
    with open(ruta, "rb") as archivo:
        for bloque in iter(lambda: archivo.read(1 << 20), b""):
            resumen.update(bloque)
    return resumen.hexdigest()


def _carpeta_de_proyecto(servicio, id_proyecto: str, nombre: str | None = None) -> str | None:
    raiz = _carpeta(servicio, config.CARPETA_DRIVE)
    consulta = (f"'{raiz}' in parents and mimeType = '{TIPO_CARPETA}' and trashed = false and "
                f"appProperties has {{ key='falabId' and value='{_literal(id_proyecto)}' }}")
    existentes = _listar(servicio, consulta, "id")
    if existentes:
        return existentes[0]["id"]
    if nombre is None:
        return None
    return _carpeta(servicio, f"{nombre} [{id_proyecto}]", raiz, {"falabId": id_proyecto})


def subir_proyecto(id_proyecto: str, trabajo: Trabajo) -> dict:
    """Sube a Drive los archivos nuevos o modificados del proyecto."""
    from googleapiclient.http import MediaFileUpload

    p = modelo.cargar(id_proyecto)
    local = modelo.carpeta(id_proyecto)
    trabajo.informar(0.02, "Conectando con Google Drive")
    servicio = _servicio()
    remota = _carpeta_de_proyecto(servicio, id_proyecto, p["nombre"])

    archivos = [r for r in sorted(local.rglob("*"))
                if r.is_file() and r.relative_to(local).parts[0] not in NO_SINCRONIZAR and r.suffix != ".tmp"]
    carpetas = {(): remota}
    subidos = 0
    for i, ruta in enumerate(archivos):
        relativo = ruta.relative_to(local)
        trabajo.informar(0.05 + 0.95 * i / max(1, len(archivos)), f"Sincronizando {relativo.as_posix()}")
        partes = relativo.parts[:-1]
        for n in range(1, len(partes) + 1):
            if partes[:n] not in carpetas:
                carpetas[partes[:n]] = _carpeta(servicio, partes[n - 1], carpetas[partes[:n - 1]])
        padre = carpetas[partes]
        existentes = _listar(
            servicio, f"name = '{_literal(ruta.name)}' and '{padre}' in parents and trashed = false", "id, md5Checksum")
        if existentes and existentes[0].get("md5Checksum") == _md5(ruta):
            continue
        medio = MediaFileUpload(str(ruta), resumable=ruta.stat().st_size > 5 * 1024 * 1024)
        if existentes:
            servicio.files().update(fileId=existentes[0]["id"], media_body=medio).execute()
        else:
            servicio.files().create(body={"name": ruta.name, "parents": [padre]}, media_body=medio,
                                    fields="id").execute()
        subidos += 1
    return {"archivosSubidos": subidos, "archivosTotales": len(archivos)}


def listar_remotos() -> list[dict]:
    """Proyectos disponibles en la carpeta falab_projects de Drive."""
    servicio = _servicio()
    raiz = _carpeta(servicio, config.CARPETA_DRIVE)
    carpetas = _listar(servicio, f"'{raiz}' in parents and mimeType = '{TIPO_CARPETA}' and trashed = false",
                       "id, name, modifiedTime, appProperties")
    locales = {r["id"] for r in modelo.listar()}
    return [
        {"id": c["appProperties"]["falabId"], "nombre": c["name"].rsplit(" [", 1)[0],
         "modificado": c.get("modifiedTime"), "enLocal": c["appProperties"]["falabId"] in locales}
        for c in carpetas if c.get("appProperties", {}).get("falabId")
    ]


def descargar_proyecto(id_proyecto: str, trabajo: Trabajo) -> dict:
    """Descarga de Drive los archivos que falten o difieran en la copia local."""
    from googleapiclient.http import MediaIoBaseDownload

    from . import medios

    trabajo.informar(0.02, "Conectando con Google Drive")
    servicio = _servicio()
    remota = _carpeta_de_proyecto(servicio, modelo.validar_id(id_proyecto))
    if remota is None:
        raise FileNotFoundError("Ese proyecto no está en Google Drive.")
    local = modelo.carpeta(id_proyecto)

    pendientes: list[tuple[dict, Path]] = []

    def recorrer(id_carpeta: str, destino: Path) -> None:
        for elemento in _listar(servicio, f"'{id_carpeta}' in parents and trashed = false",
                                "id, name, mimeType, md5Checksum"):
            nombre = Path(elemento["name"]).name  # nunca fiarse de un nombre remoto con rutas
            if elemento["mimeType"] == TIPO_CARPETA:
                recorrer(elemento["id"], destino / nombre)
            else:
                pendientes.append((elemento, destino / nombre))

    recorrer(remota, local)
    descargados = 0
    for i, (elemento, ruta) in enumerate(pendientes):
        trabajo.informar(0.05 + 0.9 * i / max(1, len(pendientes)), f"Descargando {ruta.name}")
        if ruta.exists() and _md5(ruta) == elemento.get("md5Checksum"):
            continue
        ruta.parent.mkdir(parents=True, exist_ok=True)
        temporal = ruta.with_name(ruta.name + ".descarga")
        with io.FileIO(str(temporal), "wb") as salida:
            descarga = MediaIoBaseDownload(salida, servicio.files().get_media(fileId=elemento["id"]),
                                           chunksize=8 * 1024 * 1024)
            terminado = False
            while not terminado:
                _, terminado = descarga.next_chunk()
        temporal.replace(ruta)
        descargados += 1

    # Los picos de onda no se suben: se regeneran aquí a partir de los stems.
    p = modelo.cargar(id_proyecto)
    for fuente in p["fuentes"]:
        picos = local / "picos" / f"{fuente['id']}.bin"
        if not picos.exists():
            medios.calcular_picos(local / fuente["archivo"], picos)
    return {"archivosDescargados": descargados, "id": id_proyecto}


# ---------------------------------------------------------- guardado automático en Drive
#
# Los proyectos SIEMPRE viven en el disco local y se reproducen desde ahí: Drive es una copia.
# Con el guardado automático activo, cada cambio se anota en una cola persistente y un hilo en
# segundo plano lo sube cuando hay conexión. Si internet falla, la cola espera y reintenta; la
# reproducción y la edición nunca dependen de la red.

ESPERA_TRAS_EDITAR = 20.0   # segundos sin cambios antes de subir (no subir a media edición)
PAUSA_DEL_HILO = 10.0
_sincronizador: dict = {"error": None, "ultima": None, "hilo": None}


def anotar_cambio(id_proyecto: str) -> None:
    """Marca un proyecto como pendiente de subir (solo si el guardado automático está activo)."""
    import time

    from . import biblioteca

    datos = biblioteca.cargar()
    if not datos["ajustes"].get("driveAutomatico") or not _ruta_token().exists():
        return
    datos["pendientesDrive"][id_proyecto] = time.time()
    biblioteca.guardar(datos)


def sincronizar_pendientes(ahora: float | None = None) -> int:
    """Sube los proyectos pendientes que llevan un rato sin cambios. Devuelve cuántos subió."""
    import time
    from datetime import datetime, timezone

    from . import biblioteca

    ahora = time.time() if ahora is None else ahora
    datos = biblioteca.cargar()
    if not datos["ajustes"].get("driveAutomatico") or not _ruta_token().exists():
        return 0
    subidos = 0
    for id_proyecto, marca in list(datos["pendientesDrive"].items()):
        if ahora - marca < ESPERA_TRAS_EDITAR:
            continue
        try:
            if modelo.carpeta(id_proyecto).exists():
                subir_proyecto(id_proyecto, Trabajo(id="auto", tipo="drive-subir"))
            subidos += 1
        except Exception as error:  # noqa: BLE001 - sin red, token caducado…: se reintenta luego
            _sincronizador["error"] = str(error) or error.__class__.__name__
            return subidos
        # Solo se quita de la cola si no volvió a cambiar mientras se subía.
        actual = biblioteca.cargar()
        if actual["pendientesDrive"].get(id_proyecto) == marca:
            actual["pendientesDrive"].pop(id_proyecto, None)
            biblioteca.guardar(actual)
        _sincronizador["error"] = None
        _sincronizador["ultima"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return subidos


def arrancar_sincronizador() -> None:
    """Lanza (una sola vez) el hilo que vacía la cola de subidas en segundo plano."""
    import threading
    import time

    if _sincronizador["hilo"] is not None:
        return

    def bucle() -> None:
        while True:
            time.sleep(PAUSA_DEL_HILO)
            try:
                sincronizar_pendientes()
            except Exception as error:  # noqa: BLE001 - el hilo no debe morir nunca
                _sincronizador["error"] = str(error)

    _sincronizador["hilo"] = threading.Thread(target=bucle, name="falab-drive", daemon=True)
    _sincronizador["hilo"].start()
