import io
import time
import zipfile

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from falab_motor import banda, demo, proyecto as modelo
from falab_motor.config import FRECUENCIA as FS
from falab_motor.trabajos import GestorTrabajos
from falab_motor.zip_virtual import Entrada, ZipVirtual, crc_de_archivo


@pytest.fixture(autouse=True)
def sin_estado_previo(monkeypatch):
    monkeypatch.setattr(banda, "_fallos", {})
    monkeypatch.setattr(banda, "_zips", {})


def test_zip_virtual_es_un_zip_real_y_sirve_cualquier_tramo(tmp_path):
    import zlib

    (tmp_path / "a").mkdir()
    grande = tmp_path / "a" / "audio.bin"
    grande.write_bytes(np.random.default_rng(0).integers(0, 255, 700_000, dtype=np.uint8).tobytes())
    vacio = tmp_path / "vacío.txt"
    vacio.write_bytes(b"")
    texto = "contenido en memoria ñ".encode()
    virtual = ZipVirtual([
        Entrada("a/audio.bin", grande.stat().st_size, crc_de_archivo(grande), ruta=grande),
        Entrada("vacío.txt", 0, 0, ruta=vacio),
        Entrada("datos.json", len(texto), zlib.crc32(texto), datos=texto),
    ])
    completo = b"".join(virtual.leer())
    assert len(completo) == virtual.tamano
    with zipfile.ZipFile(io.BytesIO(completo)) as z:
        assert z.testzip() is None                                   # los CRC son correctos
        assert z.namelist() == ["a/audio.bin", "vacío.txt", "datos.json"]
        assert z.read("a/audio.bin") == grande.read_bytes() and z.read("datos.json") == texto
        assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())
    for desde, hasta in [(0, 10), (25, 400_000), (300_000, 300_001), (699_990, virtual.tamano), (virtual.tamano - 22, virtual.tamano)]:
        assert b"".join(virtual.leer(desde, hasta)) == completo[desde:hasta]


def test_cuentas_sesiones_y_bloqueo_tras_fallos(carpeta_de_datos):
    with pytest.raises(ValueError):
        banda.crear_usuario("Ana", "corta")
    with pytest.raises(ValueError):
        banda.crear_usuario("../x", "contraseña-larga")
    ana = banda.crear_usuario("Ana", "contraseña-larga")
    with pytest.raises(ValueError):
        banda.crear_usuario("ana", "otra-contraseña")                # el nombre no distingue mayúsculas
    guardado = (carpeta_de_datos / "config" / "banda.json").read_text()
    assert "contraseña-larga" not in guardado                         # la contraseña no se guarda

    sesion = banda.iniciar_sesion("ANA", "contraseña-larga")
    assert sesion["usuario"] == ana and banda.usuario_de(sesion["testigo"]) == ana
    assert sesion["testigo"] not in (carpeta_de_datos / "config" / "banda.json").read_text()   # ni el testigo
    assert banda.usuario_de("inventado") is None and banda.usuario_de("") is None

    banda.cambiar_clave(ana["id"], "nueva-contraseña")
    assert banda.usuario_de(sesion["testigo"]) is None                # cambiar la clave cierra las sesiones
    with pytest.raises(PermissionError):
        banda.iniciar_sesion("Ana", "contraseña-larga")
    sesion = banda.iniciar_sesion("Ana", "nueva-contraseña")
    banda.cerrar_sesion(sesion["testigo"])
    assert banda.usuario_de(sesion["testigo"]) is None

    for _ in range(banda.INTENTOS_ANTES_DE_ESPERAR):
        with pytest.raises(PermissionError, match="incorrectos"):
            banda.iniciar_sesion("Ana", "mala")
    with pytest.raises(PermissionError, match="Demasiados"):
        banda.iniciar_sesion("Ana", "nueva-contraseña")               # ni siquiera con la buena, durante un minuto
    with pytest.raises(PermissionError, match="incorrectos"):
        banda.iniciar_sesion("Nadie", "lo-que-sea")                   # no revela si el usuario existe

    banda.eliminar_usuario(ana["id"])
    assert banda.estado()["usuarios"] == []


def _esperar_cola(cliente, cabecera, segundos=60):
    limite = time.time() + segundos
    while time.time() < limite:
        datos = cliente.get("/banda/canciones", headers=cabecera).json()
        if not datos["cola"] or any(c["estado"] == "error" for c in datos["cola"]):
            return datos
        time.sleep(0.1)
    raise TimeoutError


def test_api_de_banda_biblioteca_streaming_y_subida(carpeta_de_datos, tmp_path, monkeypatch):
    p = demo.crear_proyecto("Canción de la banda", vueltas=1)
    banda.crear_usuario("Beto", "contraseña-de-beto")
    cliente = TestClient(banda.crear_app(GestorTrabajos()))

    assert cliente.get("/banda/info").json()["falab"] is True
    for ruta in ("/banda/canciones", "/banda/yo", f"/banda/canciones/{p['id']}/paquete"):
        assert cliente.get(ruta).status_code == 401                   # nada sin iniciar sesión
    assert cliente.post("/banda/canciones", files={"archivo": ("x.wav", b"123")}).status_code == 401
    assert cliente.post("/banda/sesion", json={"nombre": "Beto", "clave": "mala"}).status_code == 401
    sesion = cliente.post("/banda/sesion", json={"nombre": "Beto", "clave": "contraseña-de-beto"}).json()
    cabecera = {"Authorization": f"Bearer {sesion['testigo']}"}
    assert cliente.get("/banda/yo", headers=cabecera).json()["nombre"] == "Beto"

    lista = cliente.get("/banda/canciones", headers=cabecera).json()
    assert [c["nombre"] for c in lista["canciones"]] == ["Canción de la banda"] and lista["cola"] == []
    cancion = lista["canciones"][0]

    # Descarga completa: es un .falab válido, con los datos del reproductor, y no ocupa disco extra.
    completa = cliente.get(f"/banda/canciones/{p['id']}/paquete", headers=cabecera)
    assert completa.status_code == 200 and len(completa.content) == cancion["peso"]
    assert "falab" in completa.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(completa.content)) as z:
        assert z.testzip() is None and {"proyecto.json", "reproductor.json", "stems/bajo.flac"} <= set(z.namelist())
        assert z.read("stems/bajo.flac") == (modelo.carpeta(p["id"]) / "stems" / "bajo.flac").read_bytes()
    assert not list((carpeta_de_datos / "banda").rglob("*.falab"))

    # Streaming: el reproductor pide tramos sueltos.
    tramo = cliente.get(f"/banda/canciones/{p['id']}/paquete", headers={**cabecera, "Range": "bytes=1000-5999"})
    assert tramo.status_code == 206 and tramo.content == completa.content[1000:6000]
    assert tramo.headers["content-range"] == f"bytes 1000-5999/{cancion['peso']}"
    cola = cliente.get(f"/banda/canciones/{p['id']}/paquete", headers={**cabecera, "Range": "bytes=-300"})
    assert cola.content == completa.content[-300:]
    fuera = cliente.get(f"/banda/canciones/{p['id']}/paquete", headers={**cabecera, "Range": f"bytes={cancion['peso'] + 5}-"})
    assert fuera.status_code == 416
    assert cliente.get("/banda/canciones/..%2F..%2Fetc/paquete", headers=cabecera).status_code == 404

    # Pase de descarga: enlace normal sin sesión, válido solo para esa canción.
    pase = cliente.post(f"/banda/canciones/{p['id']}/pase", headers=cabecera).json()["pase"]
    assert cliente.get(f"/banda/canciones/{p['id']}/paquete", params={"pase": pase}).status_code == 200
    assert cliente.get(f"/banda/canciones/otra/paquete", params={"pase": pase}).status_code == 401
    assert cliente.get(f"/banda/canciones/{p['id']}/paquete", params={"pase": "inventado"}).status_code == 401
    assert cliente.post(f"/banda/canciones/{p['id']}/pase").status_code == 401

    # Subir una canción: la analiza esta Mac y aparece en la biblioteca, con quién la subió.
    ondas, _ = demo.sintetizar(vueltas=1)
    entrada = tmp_path / "Tema nuevo.wav"
    sf.write(str(entrada), sum(ondas.values()), FS)
    subida = cliente.post("/banda/canciones", headers=cabecera, files={"archivo": ("Tema nuevo.wav", entrada.read_bytes())})
    assert subida.status_code == 200, subida.text
    en_cola = cliente.get("/banda/canciones", headers=cabecera).json()["cola"]
    assert en_cola == [] or (en_cola[0]["nombre"] == "Tema nuevo" and en_cola[0]["usuario"] == "Beto")
    final = _esperar_cola(cliente, cabecera)
    assert final["cola"] == [], final["cola"]
    nuevas = {c["nombre"]: c for c in final["canciones"]}
    assert nuevas["Tema nuevo"]["subidoPor"] == "Beto" and nuevas["Canción de la banda"]["subidoPor"] is None
    assert not list((carpeta_de_datos / "banda" / "subidas").iterdir())          # el archivo subido no se queda

    # Lo que no es audio o video se rechaza, y también lo que pasa del tamaño máximo.
    assert cliente.post("/banda/canciones", headers=cabecera, files={"archivo": ("virus.exe", b"MZ")}).status_code == 400
    assert cliente.post("/banda/canciones", headers=cabecera, files={"archivo": ("vacio.mp3", b"")}).status_code == 400
    monkeypatch.setattr(banda, "TAMANO_MAXIMO", 1000)
    assert cliente.post("/banda/canciones", headers=cabecera, files={"archivo": ("grande.mp3", b"x" * 5000)}).status_code == 413
    assert not list((carpeta_de_datos / "banda" / "subidas").iterdir())

    # Cerrar sesión invalida el testigo.
    assert cliente.delete("/banda/sesion", headers=cabecera).json() == {"cerrada": True}
    assert cliente.get("/banda/canciones", headers=cabecera).status_code == 401


def test_administracion_desde_la_app_de_escritorio(carpeta_de_datos, monkeypatch):
    from falab_motor import servidor

    arranques = []
    monkeypatch.setattr(banda, "arrancar", lambda *a: arranques.append("arrancar"))
    monkeypatch.setattr(banda, "detener", lambda: arranques.append("detener"))
    cliente = TestClient(servidor.app)
    assert cliente.get("/banda/estado").json()["activo"] is False
    assert cliente.post("/banda/usuarios", json={"nombre": "Caro", "clave": "123"}).status_code == 400
    caro = cliente.post("/banda/usuarios", json={"nombre": "Caro", "clave": "clave-de-caro"}).json()
    assert cliente.put("/banda", json={"activo": True, "direccion": "https://mi-mac.cola.ts.net/"}).json()["direccion"] == "https://mi-mac.cola.ts.net"
    assert cliente.put("/banda", json={"direccion": "http://inseguro"}).status_code == 400
    assert arranques == ["arrancar"]
    assert cliente.put(f"/banda/usuarios/{caro['id']}", json={"clave": "otra-clave-larga"}).json() == {"cambiada": True}
    assert cliente.put("/banda/usuarios/nadie", json={"clave": "otra-clave-larga"}).status_code == 404
    assert banda.iniciar_sesion("Caro", "otra-clave-larga")["usuario"]["nombre"] == "Caro"
    cliente.delete(f"/banda/usuarios/{caro['id']}")
    estado = cliente.put("/banda", json={"activo": False}).json()
    assert estado["usuarios"] == [] and estado["activo"] is False and arranques == ["arrancar", "detener"]


def test_sala_de_sincronizacion():
    """Un dispositivo dirige, los demás ven el estado; quien publica el último toma la dirección."""
    from falab_motor import banda

    banda.sala_cerrar(banda.sala_actual()["sala"]["cliente"]) if banda.sala_actual()["sala"] else None
    inicial = banda.sala_actual()
    assert inicial["sala"] is None

    publicado = banda.sala_publicar("Ana", {"cliente": "a", "proyecto": "p1", "nombre": "Canción", "sonando": True,
                                            "posicion": 12.5, "momento": 1000.0, "velocidad": 1, "tono": 2})
    assert publicado["version"] == inicial["version"] + 1 and not publicado["relevado"]
    assert publicado["sala"]["director"] == "Ana" and publicado["sala"]["tono"] == 2

    # Un latido idéntico no cambia la versión (los seguidores no se despiertan en balde).
    datos = {"cliente": "a", "proyecto": "p1", "nombre": "Canción", "sonando": True, "posicion": 12.5,
             "momento": 1000.0, "velocidad": 1, "tono": 2, "latido": True}
    assert banda.sala_publicar("Ana", datos)["version"] == publicado["version"]
    assert banda.sala_actual("Luis")["siguen"] == ["Luis"]

    # Luis toma la dirección; el latido de Ana ya no manda y se le avisa del relevo.
    banda.sala_publicar("Luis", {"cliente": "b", "proyecto": "p2", "posicion": 0})
    relevo = banda.sala_publicar("Ana", datos)
    assert relevo["relevado"] and relevo["sala"]["director"] == "Luis"

    # Solo quien dirige puede cerrar la sala.
    assert banda.sala_cerrar("a")["sala"] is not None
    assert banda.sala_cerrar("b")["sala"] is None
