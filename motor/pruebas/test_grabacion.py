import base64
import subprocess
import time

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from falab_motor import demo, proyecto as modelo, reverb, servidor
from falab_motor.config import FRECUENCIA as FS
from falab_motor.exportacion import render


def _esperar(cliente, trabajo):
    for _ in range(1200):
        estado = cliente.get(f"/trabajos/{trabajo['id']}").json()
        if estado["estado"] in ("completado", "error", "cancelado"):
            return estado
        time.sleep(0.05)
    raise TimeoutError


def test_reverb_en_la_exportacion_coincide_con_la_respuesta_al_impulso(carpeta_de_datos):
    cliente = TestClient(servidor.app)
    crudo = np.frombuffer(cliente.get("/reverb/ir").content, dtype="<f4").reshape(-1, 2)
    np.testing.assert_array_equal(crudo, reverb.respuesta_al_impulso())      # la app recibe la misma sala
    assert abs(len(crudo) / FS - reverb.SEGUNDOS) < 0.01 and np.abs(crudo[:400]).max() == 0   # prerretardo

    p = demo.crear_proyecto(vueltas=1)
    carpeta = modelo.carpeta(p["id"])
    for pista in p["pistas"]:
        pista["solo"] = pista["id"] == "bateria"
        pista["volumen"] = -12.0     # con margen: así no actúa la protección contra saturación
    seca = render.renderizar(p, carpeta)["mezcla"]
    next(x for x in p["pistas"] if x["id"] == "bateria")["reverb"] = 0.5
    mojada = render.renderizar(p, carpeta)["mezcla"]
    cola = mojada - seca
    np.testing.assert_allclose(cola, reverb.aplicar(seca) * 0.5, atol=1e-5)  # solo se suma la sala, a su nivel
    assert 0.02 < np.sqrt(np.mean(cola ** 2)) / np.sqrt(np.mean(seca ** 2)) < 1.0
    por_pistas = render.renderizar(p, carpeta, por_pistas=True)
    np.testing.assert_allclose(por_pistas["bateria"], mojada, atol=1e-4)     # la pista suelta lleva su reverb


def test_importar_audio_y_midi_como_pistas(carpeta_de_datos, tmp_path):
    import pretty_midi

    p = demo.crear_proyecto(vueltas=1)
    cliente = TestClient(servidor.app)
    t = np.arange(FS) / FS
    sf.write(str(tmp_path / "coro extra.wav"), (np.sin(2 * np.pi * 330 * t) * 0.3).astype(np.float32), 22050)
    hecho = _esperar(cliente, cliente.post(f"/proyectos/{p['id']}/pistas/importar",
                                           json={"ruta": str(tmp_path / "coro extra.wav"), "inicio": 4.0}).json())
    assert hecho["estado"] == "completado", hecho
    proyecto = cliente.get(f"/proyectos/{p['id']}").json()
    pista = proyecto["pistas"][-1]
    assert pista["nombre"] == "coro extra" and pista["instrumento"] == "extra" and pista["reverb"] == 0.0
    clip = pista["clips"][0]
    assert clip["inicio"] == 4.0 and clip["fuenteId"] == "extra_1" and abs(clip["duracion"] - 2.0) < 0.01  # 22 kHz -> 44,1
    assert len(cliente.get(f"/proyectos/{p['id']}/fuentes/extra_1/picos").content) > 100

    # Un MIDI se convierte a audio; sin FluidSynth se usa el sintetizador básico y se avisa.
    midi = pretty_midi.PrettyMIDI()
    piano = pretty_midi.Instrument(program=0)
    piano.notes.append(pretty_midi.Note(velocity=100, pitch=69, start=0.5, end=1.5))
    midi.instruments.append(piano)
    midi.write(str(tmp_path / "melodia.mid"))
    hecho = _esperar(cliente, cliente.post(f"/proyectos/{p['id']}/pistas/importar",
                                           json={"ruta": str(tmp_path / "melodia.mid"), "pista": pista["id"], "inicio": 10}).json())
    assert hecho["estado"] == "completado", hecho
    proyecto = cliente.get(f"/proyectos/{p['id']}").json()
    assert len(proyecto["pistas"]) == 7 and [c["fuenteId"] for c in proyecto["pistas"][-1]["clips"]] == ["extra_1", "extra_2"]
    onda, _ = sf.read(str(modelo.carpeta(p["id"]) / "audio" / "extra_2.flac"), dtype="float32")
    espectro = np.abs(np.fft.rfft(onda[int(0.6 * FS): int(1.4 * FS), 0]))
    assert abs(np.argmax(espectro) * FS / int(0.8 * FS) - 440) < 6                    # el La del MIDI suena a 440 Hz
    assert _esperar(cliente, cliente.post(f"/proyectos/{p['id']}/pistas/importar",
                                          json={"ruta": str(tmp_path / "no existe.wav")}).json())["estado"] == "error"


def test_grabacion_de_microfono_por_trozos(carpeta_de_datos):
    p = demo.crear_proyecto(vueltas=1)
    cliente = TestClient(servidor.app)
    base = f"/proyectos/{p['id']}/grabaciones"
    sesion = cliente.post(base, json={"tipo": "audio"}).json()["sesion"]
    # Micrófono mono: 1 s de tono enviado en 4 trozos de PCM de 16 bits.
    tono = (np.sin(2 * np.pi * 220 * np.arange(FS) / FS) * 12000).astype("<i2")
    for trozo in np.array_split(tono, 4):
        r = cliente.post(f"{base}/{sesion}/trozo", json={"datos": base64.b64encode(trozo.tobytes()).decode(), "canales": 1})
    assert r.json()["acumulado"] == FS
    # La compensación de latencia deja el inicio 50 ms antes de 0: se recorta el principio de la toma.
    hecho = cliente.post(f"{base}/{sesion}/terminar", json={"inicio": -0.05, "nombre": "Mi voz"}).json()
    proyecto = cliente.get(f"/proyectos/{p['id']}").json()
    pista = next(x for x in proyecto["pistas"] if x["id"] == hecho["pista"])
    assert pista["nombre"] == "Mi voz" and pista["clips"][0]["inicio"] == 0.0
    assert abs(pista["clips"][0]["duracion"] - 0.95) < 0.001
    grabado, _ = sf.read(str(modelo.carpeta(p["id"]) / "audio" / f"{hecho['fuente']}.flac"), dtype="float32")
    np.testing.assert_allclose(grabado[:, 0], tono[int(0.05 * FS):] / 32768, atol=1e-4)
    np.testing.assert_array_equal(grabado[:, 0], grabado[:, 1])
    assert not list((modelo.carpeta(p["id"]) / "audio").glob("toma_*"))                # no quedan temporales

    # Segunda toma en la misma pista; una toma descartada no deja rastro; una vacía se rechaza.
    sesion = cliente.post(base, json={"tipo": "audio"}).json()["sesion"]
    cliente.post(f"{base}/{sesion}/trozo", json={"datos": base64.b64encode(np.repeat(tono, 2).tobytes()).decode()})
    cliente.post(f"{base}/{sesion}/terminar", json={"inicio": 5.0, "pista": hecho["pista"]})
    pista = next(x for x in cliente.get(f"/proyectos/{p['id']}").json()["pistas"] if x["id"] == hecho["pista"])
    assert [c["inicio"] for c in pista["clips"]] == [0.0, 5.0]
    sesion = cliente.post(base, json={"tipo": "audio"}).json()["sesion"]
    assert cliente.post(f"{base}/{sesion}/terminar", json={"descartar": True}).json() == {"descartada": True}
    sesion = cliente.post(base, json={"tipo": "audio"}).json()["sesion"]
    assert cliente.post(f"{base}/{sesion}/terminar", json={"inicio": 0}).status_code == 400
    assert cliente.post(f"{base}/desconocida/trozo", json={"datos": ""}).status_code == 404


def _video_de_prueba(ruta, segundos=2, contenedor_args=()):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc=duration={segundos}:size=320x240:rate=15",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={segundos}", *contenedor_args, str(ruta)], check=True)


def test_video_original_toma_de_camara_y_exportacion(carpeta_de_datos, tmp_path):
    original = tmp_path / "concierto.mkv"
    _video_de_prueba(original, 3)
    cliente = TestClient(servidor.app)
    trabajo = _esperar(cliente, cliente.post("/proyectos/importar", json={
        "ruta": str(original), "opciones": {"separar": False, "extraerNotas": False, "transcribirLetras": False}}).json())
    assert trabajo["estado"] == "completado", trabajo
    id_proyecto = trabajo["resultado"]["id"]
    assert cliente.get(f"/proyectos/{id_proyecto}").json()["medioOriginal"]["tieneVideo"]

    # Copia ligera en MP4 para la ventana flotante (el MKV original no lo reproduce el WebView).
    info = cliente.get(f"/proyectos/{id_proyecto}/videos/original", params={"solo_ruta": True}).json()
    assert info["ruta"].endswith("video/original.mp4") and info["inicio"] == 0.0
    parcial = cliente.get(f"/proyectos/{id_proyecto}/videos/original", headers={"Range": "bytes=0-99"})
    assert parcial.status_code == 206 and len(parcial.content) == 100                  # admite saltos (Range)

    # Toma de cámara: llega por trozos en el contenedor del navegador y se convierte a MP4.
    toma = tmp_path / "camara.webm"
    _video_de_prueba(toma, 2, ("-c:v", "libvpx", "-b:v", "200k", "-an"))
    crudo = toma.read_bytes()
    base = f"/proyectos/{id_proyecto}/grabaciones"
    sesion = cliente.post(base, json={"tipo": "video", "extension": "webm"}).json()["sesion"]
    for i in range(0, len(crudo), 20000):
        cliente.post(f"{base}/{sesion}/trozo", json={"datos": base64.b64encode(crudo[i:i + 20000]).decode()})
    hecho = cliente.post(f"{base}/{sesion}/terminar", json={"tipo": "video", "inicio": 1.0}).json()
    assert hecho == {"video": "camara_1"}
    proyecto = cliente.get(f"/proyectos/{id_proyecto}").json()
    assert proyecto["videos"] == [{"id": "camara_1", "nombre": "Cámara 1", "archivo": "video/camara_1.mp4", "inicio": 1.0}]
    assert cliente.get(f"/proyectos/{id_proyecto}/videos/camara_1").content[4:8] == b"ftyp"
    assert cliente.get(f"/proyectos/{id_proyecto}/videos/otro").status_code == 404
    assert cliente.post(base, json={"tipo": "video", "extension": "exe"}).status_code == 400

    # Exportar la mezcla con el video original o con la toma de cámara.
    def duraciones(ruta):
        salida = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration,start_time",
                                 "-of", "csv=p=0", ruta], capture_output=True, text=True).stdout
        return {linea.split(",")[0]: (float(linea.split(",")[1]), float(linea.split(",")[2])) for linea in salida.split()}

    con_original = _esperar(cliente, cliente.post(f"/proyectos/{id_proyecto}/exportar", json={"tipo": "video"}).json())
    assert con_original["estado"] == "completado", con_original
    d = duraciones(con_original["resultado"]["archivos"][0])
    assert abs(d["video"][1] - 3.0) < 0.2 and abs(d["audio"][1] - 3.0) < 0.2
    con_camara = _esperar(cliente, cliente.post(f"/proyectos/{id_proyecto}/exportar",
                                                json={"tipo": "video", "video": "camara_1"}).json())
    assert con_camara["estado"] == "completado", con_camara
    assert "Cámara 1" in con_camara["resultado"]["archivos"][0]
    d = duraciones(con_camara["resultado"]["archivos"][0])
    assert abs(d["video"][0] - 1.0) < 0.15          # la imagen empieza en el segundo 1 de la canción…
    assert abs(d["audio"][1] - 3.0) < 0.2           # …y el audio es la mezcla completa
    assert _esperar(cliente, cliente.post(f"/proyectos/{id_proyecto}/exportar",
                                          json={"tipo": "video", "video": "camara_9"}).json())["estado"] == "error"
