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
