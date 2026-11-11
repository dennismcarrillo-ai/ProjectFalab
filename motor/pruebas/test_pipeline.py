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
