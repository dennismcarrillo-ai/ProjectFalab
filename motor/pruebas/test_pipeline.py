import numpy as np

from falab_motor import demo
from falab_motor.config import FRECUENCIA as FS
from falab_motor.pipeline import acordes, anti_bleed, mapa_tempo


def test_anti_bleed_conserva_la_suma_y_reduce_el_sangrado():
    ondas, _ = demo.sintetizar(vueltas=2)
    bajo_real, bateria_real = ondas["bajo"], ondas["bateria"]
    bajo_sucio = bajo_real + 0.3 * bateria_real          # golpes de bombo colados en el bajo
    bateria_sucia = 0.7 * bateria_real + 0.25 * bajo_real  # notas de bajo coladas en la batería
    bateria_objetivo = bateria_real
    bajo_objetivo = 1.25 * bajo_real

    bajo, bateria, _ = anti_bleed.reducir_sangrado(bajo_sucio, bateria_sucia, FS)

    np.testing.assert_allclose(bajo + bateria, bajo_sucio + bateria_sucia, atol=1e-5)
    error_antes = np.mean((bajo_sucio - bajo_objetivo) ** 2) + np.mean((bateria_sucia - bateria_objetivo) ** 2)
    error_despues = np.mean((bajo - bajo_objetivo) ** 2) + np.mean((bateria - bateria_objetivo) ** 2)
    assert error_despues < 0.7 * error_antes


def test_anti_bleed_con_intensidad_cero_no_cambia_nada():
    ondas, _ = demo.sintetizar(vueltas=1)
    bajo, bateria, _ = anti_bleed.reducir_sangrado(ondas["bajo"], ondas["bateria"], FS, intensidad=0)
    np.testing.assert_array_equal(bajo, ondas["bajo"])
    np.testing.assert_array_equal(bateria, ondas["bateria"])


def _claqueta(instantes, fs=22050):
    onda = np.zeros(int((instantes[-1] + 1) * fs), dtype=np.float32)
    clic = np.sin(2 * np.pi * 1000 * np.arange(400) / fs) * np.exp(-np.arange(400) / 60)
    for t in instantes:
        i = int(t * fs)
        onda[i:i + 400] += clic
    return onda, fs


def test_mapa_tempo_sigue_un_tempo_que_acelera():
    # De 90 a 126 BPM de forma progresiva a lo largo de 80 pulsos.
    bpms = np.linspace(90, 126, 80)
    instantes = np.concatenate([[0.5], 0.5 + np.cumsum(60 / bpms)])
    mapa = mapa_tempo.analizar_onda(*_claqueta(instantes))

    detectados = np.array([p["t"] for p in mapa["pulsos"]])
    assert len(detectados) > 60
    # Casi todos los pulsos reales tienen uno detectado a menos de 50 ms.
    aciertos = sum(np.min(np.abs(detectados - t)) < 0.05 for t in instantes)
    assert aciertos / len(instantes) > 0.85
    tercio = len(mapa["pulsos"]) // 3
    bpm_inicio = np.median([p["bpm"] for p in mapa["pulsos"][:tercio]])
    bpm_final = np.median([p["bpm"] for p in mapa["pulsos"][-tercio:]])
    assert bpm_final - bpm_inicio > 15


def test_acordes_desde_notas_con_inversion_y_cifrados():
    pulso = 0.5
    limites = np.arange(0, 16 * pulso + 1e-9, pulso)
    progresion = [([60, 64, 67], 36), ([57, 60, 64], 33), ([53, 57, 60], 29), ([55, 59, 62, 65], 31)]
    armonia, bajo = [], []
    for i, (tonos, grave) in enumerate(progresion):
        t0 = i * 4 * pulso
        armonia += [{"inicio": t0, "fin": t0 + 4 * pulso, "tono": t, "velocidad": 80} for t in tonos]
        bajo.append({"inicio": t0, "fin": t0 + 4 * pulso, "tono": grave, "velocidad": 90})
    resultado = acordes.detectar(limites, acordes.croma_desde_notas(armonia, limites),
                                 acordes.croma_desde_notas(bajo, limites))
    nombres = [a["nombre"] for a in acordes.con_nombres(resultado)["acordes"]]
    assert nombres == ["C", "Am", "F", "G7"]
    assert resultado["tonalidad"]["tonica"] == 0 and resultado["tonalidad"]["modo"] == "mayor"
    assert [a["nombre"] for a in acordes.con_nombres(resultado, "jazz")["acordes"]] == ["C", "A-", "F", "G7"]
    assert [a["nombre"] for a in acordes.con_nombres(resultado, "latino")["acordes"]] == ["Do", "Lam", "Fa", "Sol7"]

    # Primera inversión: Do mayor con Mi en el bajo.
    bajo_mi = [{"inicio": 0, "fin": 2, "tono": 40, "velocidad": 90}]
    limites2 = np.arange(0, 2.01, 0.5)
    r2 = acordes.detectar(limites2, acordes.croma_desde_notas(armonia[:3], limites2),
                          acordes.croma_desde_notas(bajo_mi, limites2))
    assert acordes.con_nombres(r2)["acordes"][0]["nombre"] == "C/E"


def test_acordes_desde_audio_sintetico():
    ondas, _ = demo.sintetizar(vueltas=2)
    import librosa

    fs = 22050
    armonia = librosa.resample((ondas["guitarra"] + ondas["piano"]).mean(axis=1), orig_sr=FS, target_sr=fs)
    bajo = librosa.resample(ondas["bajo"].mean(axis=1), orig_sr=FS, target_sr=fs)
    pulso = 60 / demo.BPM
    limites = np.arange(0, 32 * pulso + 1e-9, pulso)
    resultado = acordes.detectar(limites, acordes.croma_desde_audio(armonia, fs, limites),
                                 acordes.croma_desde_audio(bajo, fs, limites))
    nombres = [a["nombre"] for a in acordes.con_nombres(resultado)["acordes"]]
    assert nombres[:4] == ["C", "Am", "F", "G7"]


def test_mas_detalle_recupera_los_acordes_de_paso():
    # C (3 pulsos) – G/B de paso (1 pulso) – Am (4 pulsos) – F (4 pulsos)
    pulso = 0.5
    mapa = {"pulsos": [{"t": i * pulso} for i in range(13)]}
    tramos = [(0, 3, [60, 64, 67], 36), (3, 4, [59, 62, 67], 35), (4, 8, [57, 60, 64], 33), (8, 12, [53, 57, 60], 29)]
    armonia, bajo = [], []
    for a, b, tonos, grave in tramos:
        # Como en una grabación real, el acorde de paso suena flojo y el anterior sigue resonando.
        de_paso = b - a == 1
        armonia += [{"inicio": a * pulso, "fin": (b + (0 if de_paso else 0.9)) * pulso, "tono": t,
                     "velocidad": 45 if de_paso else 100} for t in tonos]
        bajo.append({"inicio": a * pulso, "fin": b * pulso, "tono": grave, "velocidad": 50 if de_paso else 90})

    def cifrar(detalle):
        subdivisiones, coste = acordes.DETALLES[detalle]
        limites = acordes.limites_de_analisis(mapa, 12 * pulso, subdivisiones)
        return acordes.detectar(limites, acordes.croma_desde_notas(armonia, limites),
                                acordes.croma_desde_notas(bajo, limites), coste_cambio=coste)["acordes"]

    assert [a["raiz"] for a in cifrar("normal")] == [0, 9, 5]       # C, Am, F: el de paso se pierde
    for detalle in ("alto", "maximo"):
        detectados = cifrar(detalle)
        assert len(detectados) == 4, detalle
        de_paso = detectados[1]
        assert (de_paso["inicio"], de_paso["fin"]) == (1.5, 2.0)     # justo el pulso de paso…
        assert de_paso["bajo"] == 11                                   # …con el Si en el bajo
    assert len(acordes.limites_de_analisis(mapa, 6.0, 2)) == 25


def test_compas_por_seccion_y_correccion_del_mapa():
    from falab_motor.pipeline import estructura

    mapa = {"bpm": 120.0, "compas": 4, "pulsos": [
        {"t": 0.5 * i, "bpm": 120.0, "compas": i // 4 + 1, "pulso": i % 4 + 1} for i in range(24)]}
    # Sin indicaciones no cambia nada.
    assert estructura.aplicar_compases(mapa, [{"inicio": 0, "nombre": "A"}]) is mapa
    # Del segundo 4 (pulso 8) en adelante, 3/4; del segundo 8,5 (pulso 17) en adelante, 5/4.
    secciones = [{"inicio": 0.0, "nombre": "Intro"}, {"inicio": 4.0, "nombre": "Vals", "compas": 3},
                 {"inicio": 8.5, "nombre": "Raro", "compas": 5}]
    nuevos = estructura.aplicar_compases(mapa, secciones)["pulsos"]
    assert [p["pulso"] for p in nuevos[:8]] == [1, 2, 3, 4, 1, 2, 3, 4]
    assert [p["pulso"] for p in nuevos[8:17]] == [1, 2, 3, 1, 2, 3, 1, 2, 3]
    assert [p["pulso"] for p in nuevos[17:]] == [1, 2, 3, 4, 5, 1, 2]
    assert [p["compas"] for p in nuevos[6:12]] == [2, 2, 3, 3, 3, 4]      # la numeración de compases sigue
    assert nuevos[8]["tiempos"] == 3 and nuevos[17]["tiempos"] == 5

    doble = estructura.corregir_mapa(mapa, "doble")
    assert len(doble["pulsos"]) == 47 and abs(doble["bpm"] - 240) < 0.5
    assert doble["pulsos"][1]["t"] == 0.25 and doble["pulsos"][0]["pulso"] == 1
    mitad = estructura.corregir_mapa(mapa, "mitad")
    assert len(mitad["pulsos"]) == 12 and abs(mitad["bpm"] - 60) < 0.5
    movido = estructura.corregir_mapa(mapa, "desplazar")
    assert [p["pulso"] for p in movido["pulsos"][:3]] == [4, 1, 2] and movido["pulsos"][1]["compas"] == 1

    normal = estructura.normalizar([{"inicio": 20, "nombre": "Coro", "compas": 3}, {"inicio": 20.2, "nombre": "dup"},
                                    {"inicio": 5, "nombre": " "}], 60.0)
    assert [(s["inicio"], s["fin"], s["nombre"]) for s in normal] == [
        (0.0, 5.0, "Intro"), (5.0, 20.0, "Sección"), (20.0, 60.0, "Coro")]
    assert normal[2]["compas"] == 3


def test_estructura_automatica_de_la_demo():
    from falab_motor.pipeline import estructura

    ondas, _ = demo.sintetizar(vueltas=4)   # la voz entra en las vueltas 2 y 4 (cada una dura 10 s)
    import soundfile as sf, tempfile, pathlib
    with tempfile.TemporaryDirectory() as carpeta:
        mezcla, voz = pathlib.Path(carpeta) / "m.flac", pathlib.Path(carpeta) / "v.flac"
        sf.write(str(mezcla), sum(ondas.values()), FS)
        sf.write(str(voz), ondas["voz"], FS)
        pulso = 60 / demo.BPM
        mapa = {"bpm": demo.BPM, "compas": 4, "pulsos": [
            {"t": i * pulso, "bpm": demo.BPM, "compas": i // 4 + 1, "pulso": i % 4 + 1} for i in range(64)]}
        secciones = estructura.detectar(mezcla, voz, mapa, 41.0)
    assert secciones[0]["inicio"] == 0.0 and secciones[-1]["fin"] == 41.0
    assert all(a["fin"] == b["inicio"] for a, b in zip(secciones, secciones[1:]))
    assert secciones[0]["nombre"] == "Intro"
    cantadas = [s for s in secciones if s["nombre"] in ("Verso", "Coro", "Puente")]
    assert cantadas and abs(cantadas[0]["inicio"] - 10.0) < 2.6       # el canto empieza en el segundo 10
    assert all(s["nombre"] in estructura.NOMBRES for s in secciones)


def test_guias_de_voz_caen_en_los_pulsos(carpeta_de_datos, monkeypatch):
    from falab_motor import guias, proyecto as modelo
    from falab_motor.trabajos import Trabajo

    p = demo.crear_proyecto(vueltas=2)
    pulso = 0.5
    mapa = {"bpm": 120.0, "compas": 4, "pulsos": [
        {"t": pulso * i, "bpm": 120.0, "compas": i // 4 + 1, "pulso": i % 4 + 1} for i in range(40)]}
    modelo.escribir_analisis(p["id"], "mapa_tempo", mapa)
    modelo.escribir_analisis(p["id"], "estructura", {"secciones": [
        {"inicio": 0.0, "fin": 8.0, "nombre": "Intro"}, {"inicio": 8.0, "fin": 14.0, "nombre": "Coro"},
        {"inicio": 14.0, "fin": 20.0, "nombre": "Vals", "compas": 3}]})
    assert guias.planificar(modelo.leer_analisis(p["id"], "estructura")["secciones"], mapa)[:4] == [
        (6.0, "Coro"), (6.5, "dos"), (7.0, "tres"), (7.5, "cuatro")]

    dichas = []

    def voz_falsa(texto):
        dichas.append(texto)
        return (np.ones(2205, dtype=np.float32) * 0.5)        # 50 ms de «voz»

    monkeypatch.setattr(guias, "sintetizar", voz_falsa)
    guias.generar(p["id"], Trabajo(id="t", tipo="guias"))
    assert sorted(dichas) == ["Coro", "Vals", "cuatro", "dos", "tres"]   # cada palabra se sintetiza una vez

    nuevo = modelo.cargar(p["id"])
    pista = nuevo["pistas"][-1]
    assert pista["instrumento"] == "guias" and pista["clips"][0]["fuenteId"] == "guias_1"
    import soundfile as sf
    onda, _ = sf.read(str(modelo.carpeta(p["id"]) / "stems" / "guias_1.flac"), dtype="float32")
    suena = lambda t: float(np.abs(onda[int(t * FS) + 200: int(t * FS) + 2000, 0]).mean()) > 0.2
    assert all(suena(t) for t in (6.0, 6.5, 7.0, 7.5, 12.0, 13.5))        # «Coro, 2, 3, 4» y «Vals, 2, 3, 4»
    assert not any(suena(t) for t in (0.0, 5.5, 6.25, 8.0, 10.0))         # y silencio en el resto

    # Al regenerar se conserva la mezcla de la pista y no queda audio antiguo.
    pista["volumen"] = -9.0
    modelo.guardar(nuevo)
    guias.generar(p["id"], Trabajo(id="t", tipo="guias"))
    final = modelo.cargar(p["id"])
    assert [f["id"] for f in final["fuentes"] if f["id"].startswith("guias")] == ["guias_2"]
    assert final["pistas"][-1]["volumen"] == -9.0 and len([x for x in final["pistas"] if x["instrumento"] == "guias"]) == 1
    assert not (modelo.carpeta(p["id"]) / "stems" / "guias_1.flac").exists()


def test_midi_espera_y_entrega_los_mensajes():
    import threading, time
    from falab_motor import midi

    base = midi._contador
    assert midi.esperar(base, 0.05) == []
    threading.Timer(0.1, lambda: midi._recibir("Pedal", [0xB0, 64, 127])).start()
    inicio = time.time()
    eventos = midi.esperar(base, 5.0)
    assert time.time() - inicio < 2.0                                      # despierta en cuanto llega
    assert eventos == [{"n": base + 1, "puerto": "Pedal", "estado": 0xB0, "canal": 1, "dato1": 64, "dato2": 127}]
    midi._recibir("Pedal", [0xF8])                                         # el reloj MIDI se ignora
    assert midi._contador == base + 1
