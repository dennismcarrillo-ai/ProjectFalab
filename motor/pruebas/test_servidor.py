import time

import numpy as np
from fastapi.testclient import TestClient

from falab_motor import demo, servidor
from falab_motor.config import FRAMES_POR_PICO, FRECUENCIA as FS


def _esperar(cliente, trabajo):
    for _ in range(600):
        estado = cliente.get(f"/trabajos/{trabajo['id']}").json()
        if estado["estado"] in ("completado", "error", "cancelado"):
            return estado
        time.sleep(0.05)
    raise TimeoutError


def test_flujo_completo_por_la_api(carpeta_de_datos):
    p = demo.crear_proyecto(vueltas=1)
    cliente = TestClient(servidor.app)
    assert cliente.get("/salud").json()["estado"] == "ok"
    assert [x["id"] for x in cliente.get("/proyectos").json()] == [p["id"]]

    proyecto = cliente.get(f"/proyectos/{p['id']}").json()
    assert [x["id"] for x in proyecto["pistas"]] == ["voz", "bajo", "bateria", "guitarra", "piano", "otros"]

    # PCM por fragmentos: 16 bits estéreo, exactamente los frames pedidos.
    crudo = cliente.get(f"/proyectos/{p['id']}/fuentes/bajo/pcm", params={"inicio": FS, "frames": 4096}).content
    muestras = np.frombuffer(crudo, dtype="<i2").reshape(-1, 2)
    assert muestras.shape == (4096, 2) and np.abs(muestras).max() > 500
    picos = cliente.get(f"/proyectos/{p['id']}/fuentes/bajo/picos")
    assert len(picos.content) == 2 * -(-proyecto["fuentes"][0]["frames"] // FRAMES_POR_PICO)

    analisis = cliente.get(f"/proyectos/{p['id']}/analisis", params={"cifrado": "latino"}).json()
    assert [a["nombre"] for a in analisis["acordes"]][:3] == ["Do", "Lam", "Fa"]
    assert analisis["acordes"][3]["nombre"].startswith("Sol")
    assert abs(analisis["mapaTempo"]["bpm"] - demo.BPM) < 2
    assert analisis["tonalidad"]["nombre"] == "Do mayor"
    assert cliente.get(f"/proyectos/{p['id']}/partitura", params={"instrumento": "bajo"}).text.startswith("<?xml")

    # Guardar una edición y rechazar una inválida.
    proyecto["velocidad"] = 0.8
    proyecto["pistas"][0]["clips"][0]["duracion"] = 1.5
    assert cliente.put(f"/proyectos/{p['id']}", json=proyecto).status_code == 200
    assert cliente.get(f"/proyectos/{p['id']}").json()["pistas"][0]["clips"][0]["duracion"] == 1.5
    proyecto["pistas"][0]["clips"][0]["fuenteId"] = "../../etc"
    assert cliente.put(f"/proyectos/{p['id']}", json=proyecto).status_code == 400

    trabajo = _esperar(cliente, cliente.post(f"/proyectos/{p['id']}/exportar",
                                             json={"tipo": "mezcla", "formato": "wav"}).json())
    assert trabajo["estado"] == "completado", trabajo
    nombre = trabajo["resultado"]["archivos"][0].rsplit("/", 1)[-1]
    assert cliente.get(f"/proyectos/{p['id']}/exportaciones/{nombre}").content[:4] == b"RIFF"

    assert cliente.get("/proyectos/..%2F..%2Fetc").status_code == 404
    assert cliente.delete(f"/proyectos/{p['id']}").json() == {"eliminado": True}
    assert cliente.get("/proyectos").json() == []


def test_importar_sin_etapas_de_ia_crea_un_proyecto_utilizable(carpeta_de_datos, tmp_path):
    """Con las etapas de IA desactivadas se obtiene un proyecto de una pista con tempo y acordes.

    Las etapas se desactivan explícitamente para que la prueba no dependa de si los modelos
    están instalados (con ellos instalados ejecutaría Demucs y descargaría Whisper).
    """
    import soundfile as sf

    ondas, _ = demo.sintetizar(vueltas=1)
    entrada = tmp_path / "canción de prueba.wav"
    sf.write(str(entrada), sum(ondas.values()), FS)
    cliente = TestClient(servidor.app)
    trabajo = _esperar(cliente, cliente.post("/proyectos/importar", json={
        "ruta": str(entrada),
        "opciones": {"separar": False, "extraerNotas": False, "transcribirLetras": False},
    }).json())
    assert trabajo["estado"] == "completado", trabajo
    proyecto = cliente.get(f"/proyectos/{trabajo['resultado']['id']}").json()
    assert [x["id"] for x in proyecto["pistas"]] == ["mezcla"]
    assert abs(proyecto["bpm"] - demo.BPM) < 2
    analisis = cliente.get(f"/proyectos/{proyecto['id']}/analisis").json()
    assert [a["nombre"] for a in analisis["acordes"]][:3] == ["C", "Am", "F"]
    assert analisis["acordes"][3]["raiz"] == 7


def test_testigo_de_sesion(monkeypatch, carpeta_de_datos):
    monkeypatch.setattr(servidor, "TESTIGO", "secreto")
    cliente = TestClient(servidor.app)
    assert cliente.get("/salud").status_code == 401
    assert cliente.get("/salud", headers={"X-Falab-Token": "secreto"}).status_code == 200
    assert cliente.get("/salud", params={"token": "secreto"}).status_code == 200


def test_biblioteca_paquetes_letras_y_detalle_de_acordes(carpeta_de_datos, tmp_path):
    p = demo.crear_proyecto(vueltas=1)
    cliente = TestClient(servidor.app)

    # Ficha del proyecto: peso en disco, número de archivos y tonalidad.
    ficha = cliente.get("/proyectos").json()[0]
    assert ficha["peso"] > 100_000 and ficha["archivos"] >= 12
    assert ficha["tonalidad"]["nombre"] == "C mayor" and ficha["tonalidadInicial"]["tonica"] == 0

    # Playlists: crear, renombrar, validar y limpiar al eliminar un proyecto.
    creadas = cliente.put("/biblioteca/playlists", json={"playlists": [
        {"nombre": "Ensayo", "orden": "bpm", "proyectos": [p["id"], p["id"]]}]}).json()["playlists"]
    assert creadas[0]["proyectos"] == [p["id"]] and creadas[0]["id"]
    creadas[0]["nombre"] = "Concierto"
    cliente.put("/biblioteca/playlists", json={"playlists": creadas})
    assert cliente.get("/biblioteca").json()["playlists"][0]["nombre"] == "Concierto"
    assert cliente.put("/biblioteca/playlists", json={"playlists": [{"nombre": " "}]}).status_code == 400
    assert cliente.put("/biblioteca/playlists", json={"playlists": [{"nombre": "x", "orden": "raro"}]}).status_code == 400

    # Exportar el proyecto completo e importarlo: como el original existe, entra como copia.
    exportado = _esperar(cliente, cliente.post(f"/proyectos/{p['id']}/empaquetar", json={"destino": str(tmp_path)}).json())
    ruta = exportado["resultado"]["archivos"][0]
    assert ruta.endswith(".falab")
    importado = _esperar(cliente, cliente.post("/proyectos/importar-paquete", json={"ruta": ruta}).json())
    assert importado["estado"] == "completado", importado
    copia = importado["resultado"]["id"]
    assert copia != p["id"] and importado["resultado"]["nombre"].endswith("(copia)")
    assert len(cliente.get(f"/proyectos/{copia}/fuentes/bajo/pcm", params={"frames": 100}).content) == 400
    assert cliente.get(f"/proyectos/{copia}/analisis").json()["acordes"]

    # Un paquete malicioso no puede escribir fuera de la carpeta del proyecto.
    import zipfile
    trampa = tmp_path / "trampa.falab"
    with zipfile.ZipFile(trampa, "w") as z:
        z.writestr("proyecto.json", '{"id": "nuevo123", "nombre": "x", "fuentes": []}')
        z.writestr("../../fuera.txt", "x")
    assert _esperar(cliente, cliente.post("/proyectos/importar-paquete", json={"ruta": str(trampa)}).json())["estado"] == "error"
    assert not (carpeta_de_datos / "fuera.txt").exists()

    # Letra: corregir una palabra conserva los tiempos; cambiar el número de palabras los reparte.
    from falab_motor import proyecto as modelo
    modelo.escribir_analisis(p["id"], "letras", {"idioma": "es", "segmentos": [
        {"inicio": 1.0, "fin": 3.0, "texto": "ola mundo", "palabras": [
            {"inicio": 1.0, "fin": 1.8, "texto": "ola"}, {"inicio": 2.0, "fin": 3.0, "texto": "mundo"}]},
        {"inicio": 5.0, "fin": 7.0, "texto": "sobra", "palabras": [{"inicio": 5.0, "fin": 7.0, "texto": "sobra"}]}]})
    cliente.put(f"/proyectos/{p['id']}/letras", json={"lineas": [
        {"inicio": 1.0, "texto": "hola mundo"}, {"inicio": 5.0, "texto": ""}]})
    letras = cliente.get(f"/proyectos/{p['id']}/analisis").json()
    assert letras["letraEditada"] and len(letras["letras"]["segmentos"]) == 1
    assert letras["letras"]["segmentos"][0]["palabras"] == [
        {"inicio": 1.0, "fin": 1.8, "texto": "hola"}, {"inicio": 2.0, "fin": 3.0, "texto": "mundo"}]
    cliente.put(f"/proyectos/{p['id']}/letras", json={"lineas": [{"inicio": 1.0, "texto": "hola a todo el mundo"}]})
    palabras = cliente.get(f"/proyectos/{p['id']}/analisis").json()["letras"]["segmentos"][0]["palabras"]
    assert [x["texto"] for x in palabras] == ["hola", "a", "todo", "el", "mundo"]
    assert palabras[0]["inicio"] == 1.0 and palabras[-1]["fin"] == 3.0
    assert all(a["fin"] <= b["inicio"] + 1e-6 for a, b in zip(palabras, palabras[1:]))

    # Detalle de acordes: se puede recalcular sin repetir el análisis.
    trabajo = _esperar(cliente, cliente.post(f"/proyectos/{p['id']}/acordes", json={"detalle": "maximo"}).json())
    assert trabajo["estado"] == "completado", trabajo
    assert cliente.get(f"/proyectos/{p['id']}/analisis").json()["detalleAcordes"] == "maximo"
    assert cliente.post(f"/proyectos/{p['id']}/acordes", json={"detalle": "x"}).status_code == 400

    cliente.delete(f"/proyectos/{p['id']}")
    assert cliente.get("/biblioteca").json()["playlists"][0]["proyectos"] == []


def test_guardado_automatico_en_drive_con_cola_y_reintentos(carpeta_de_datos, monkeypatch):
    from falab_motor import biblioteca, drive

    p = demo.crear_proyecto(vueltas=1)
    subidas = []
    hay_red = {"valor": False}

    def subir_falso(id_proyecto, trabajo):
        if not hay_red["valor"]:
            raise ConnectionError("sin conexión")
        subidas.append(id_proyecto)

    monkeypatch.setattr(drive, "subir_proyecto", subir_falso)
    (carpeta_de_datos / "config" / "token_drive.json").write_text("{}")

    drive.anotar_cambio(p["id"])                      # automático desactivado: no se anota nada
    assert drive.estado()["pendientes"] == []
    biblioteca.fijar_ajustes({"driveAutomatico": True})
    drive.anotar_cambio(p["id"])
    assert drive.estado()["pendientes"] == [p["id"]] and drive.estado()["automatico"]

    import time
    assert drive.sincronizar_pendientes(time.time()) == 0             # aún está «a media edición»
    despues = time.time() + drive.ESPERA_TRAS_EDITAR + 1
    assert drive.sincronizar_pendientes(despues) == 0                 # sin red: sigue en la cola
    assert drive.estado()["pendientes"] == [p["id"]] and "sin conexión" in drive.estado()["ultimoError"]
    hay_red["valor"] = True
    assert drive.sincronizar_pendientes(despues) == 1                 # vuelve la red: se sube
    assert subidas == [p["id"]] and drive.estado()["pendientes"] == [] and drive.estado()["ultimoError"] is None
