import time

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from falab_motor import demo, proyecto as modelo, servidor
from falab_motor.config import FRECUENCIA as FS
from falab_motor.pipeline import division, orquestador, preanalisis, separacion


def _tono(hz, segundos, amplitud=0.3, vibrato=0.0):
    t = np.arange(int(segundos * FS)) / FS
    return (amplitud * np.sin(2 * np.pi * hz * t + vibrato * np.sin(2 * np.pi * 5 * t))).astype(np.float32)


def _voz_con_coros(segundos=6.0):
    """Voz principal al centro y dos coros abiertos a izquierda y derecha."""
    principal = _tono(440, segundos, 0.3, 2.0)
    coro_izq, coro_der = _tono(554, segundos, 0.15), _tono(659, segundos, 0.15)
    return np.stack([principal + coro_izq, principal + coro_der], axis=1), principal, coro_izq, coro_der


def _esperar(cliente, trabajo):
    for _ in range(1200):
        estado = cliente.get(f"/trabajos/{trabajo['id']}").json()
        if estado["estado"] in ("completado", "error", "cancelado"):
            return estado
        time.sleep(0.05)
    raise TimeoutError


def test_centro_y_lados_separan_voz_principal_de_coros():
    mezcla, principal, coro_izq, coro_der = _voz_con_coros()
    centro, lados = division.separar_centro_lados(mezcla)
    np.testing.assert_allclose(centro + lados, mezcla, atol=1e-6)            # no se pierde ni se inventa audio
    margen = slice(FS // 2, -FS // 2)

    def parecido(a, b):
        return float(np.dot(a[margen], b[margen]) / (np.linalg.norm(a[margen]) * np.linalg.norm(b[margen]) + 1e-12))

    assert parecido(centro[:, 0], principal) > 0.97                           # el centro es la voz principal
    assert parecido(lados[:, 0], coro_izq) > 0.9 and parecido(lados[:, 1], coro_der) > 0.9
    assert abs(parecido(lados[:, 0], principal)) < 0.2                        # y casi no queda en los lados
    assert -12 < division.relacion_lados_centro_db(centro, lados) < 0

    # Una señal idéntica en ambos canales es todo centro; una solo a la izquierda, todo lados.
    mono = np.stack([principal, principal], axis=1)
    c, l = division.separar_centro_lados(mono)
    assert division.relacion_lados_centro_db(c, l) < -40
    c, l = division.separar_centro_lados(np.stack([principal, np.zeros_like(principal)], axis=1))
    assert division.relacion_lados_centro_db(c, l) > 20


def test_la_division_por_bloques_no_deja_costuras():
    largo = np.concatenate([_voz_con_coros(25.0)[0], _voz_con_coros(25.0)[0]])   # 50 s: tres bloques
    centro, _ = division.separar_centro_lados(largo)
    salto = np.abs(np.diff(centro[:, 0]))
    # En las costuras (20 s y 40 s) la señal no salta más que en cualquier otro punto.
    for costura in (19, 20, 21, 39, 40, 41):
        zona = salto[costura * FS - 2000: costura * FS + 2000]
        assert zona.max() <= salto[5 * FS: 15 * FS].max() * 1.05


def test_preanalisis_propone_segun_lo_que_hay():
    segundos = 6.0
    voz, *_ = _voz_con_coros(segundos)
    guitarra_ritmica = np.stack([_tono(196, segundos, 0.2), _tono(247, segundos, 0.2)], axis=1)
    solo = _tono(784, segundos, 0.2, 3.0)
    stems = {
        "voz": voz,
        "guitarra": guitarra_ritmica + np.stack([solo, solo], axis=1),
        "bajo": np.stack([_tono(55, segundos, 0.3)] * 2, axis=1),
        "bateria": (np.random.default_rng(0).standard_normal((int(segundos * FS), 2)) * 0.05).astype(np.float32),
        "piano": np.zeros((int(segundos * FS), 2), dtype=np.float32),            # no hay piano
        "otros": (np.random.default_rng(1).standard_normal((int(segundos * FS), 2)) * 0.0005).astype(np.float32),
    }
    r = preanalisis.medir(stems)
    assert [k for k, v in r["instrumentos"].items() if v["presente"]] == ["voz", "bajo", "bateria", "guitarra"]
    assert r["coros"]["sugerido"] and r["guitarras"]["sugerido"]

    # Voz sola al centro y guitarra solo rítmica (toda a los lados): no se propone dividir nada.
    stems["voz"] = np.stack([_tono(440, segundos, 0.3, 2.0)] * 2, axis=1)
    stems["guitarra"] = np.stack([_tono(196, segundos, 0.2), -_tono(196, segundos, 0.2)], axis=1)
    r = preanalisis.medir(stems)
    assert not r["coros"]["sugerido"] and not r["guitarras"]["sugerido"]


def _demucs_simulado(monkeypatch):
    """Sustituye a Demucs por stems sintéticos (aquí no se pueden descargar los modelos)."""
    def separar(ruta_mezcla, dir_stems, *, modelo="htdemucs_6s", progreso=lambda _: None):
        frames = sf.info(str(ruta_mezcla)).frames
        segundos = frames / FS
        voz, *_ = _voz_con_coros(segundos)
        ritmica = np.stack([_tono(196, segundos, 0.2), _tono(247, segundos, 0.2)], axis=1)
        solo = _tono(784, segundos, 0.2, 3.0)
        ondas = {"voz": voz, "guitarra": ritmica + np.stack([solo, solo], axis=1),
                 "bajo": np.stack([_tono(55, segundos, 0.3)] * 2, axis=1),
                 "bateria": np.stack([_tono(3000, segundos, 0.05)] * 2, axis=1),
                 "piano": np.stack([_tono(880, segundos, 0.002)] * 2, axis=1),   # apenas un residuo
                 "otros": np.stack([_tono(1500, segundos, 0.02)] * 2, axis=1)}
        dir_stems.mkdir(parents=True, exist_ok=True)
        rutas = {}
        for id_stem, onda in ondas.items():
            rutas[id_stem] = dir_stems / f"{id_stem}.flac"
            sf.write(str(rutas[id_stem]), onda[:frames], FS, format="FLAC", subtype="PCM_24")
        progreso(1.0)
        return rutas

    monkeypatch.setattr(separacion, "separar", separar)
    import importlib.util
    real = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda nombre, *a: object() if nombre == "demucs" else real(nombre, *a))


def test_importar_con_pistas_elegidas_coros_y_guitarras(carpeta_de_datos, tmp_path, monkeypatch):
    _demucs_simulado(monkeypatch)
    ondas, _ = demo.sintetizar(vueltas=1)
    entrada = tmp_path / "tema.wav"
    sf.write(str(entrada), sum(ondas.values()), FS)
    cliente = TestClient(servidor.app)

    # Pre-análisis: tres extractos, un Demucs (simulado) y las sugerencias.
    previo = _esperar(cliente, cliente.post("/preanalisis", json={"ruta": str(entrada)}).json())
    assert previo["estado"] == "completado", previo
    r = previo["resultado"]
    assert r["disponible"] and r["coros"]["sugerido"] and r["guitarras"]["sugerido"] and not r["tieneVideo"]
    assert r["instrumentos"]["bajo"]["presente"] and not r["instrumentos"]["piano"]["presente"]

    # Importar sin piano ni batería, separando coros y guitarras.
    trabajo = _esperar(cliente, cliente.post("/proyectos/importar", json={"ruta": str(entrada), "opciones": {
        "antiBleed": False, "extraerNotas": False, "transcribirLetras": False,
        "pistas": ["voz", "bajo", "guitarra", "otros"], "separarCoros": True, "separarGuitarras": True}}).json())
    assert trabajo["estado"] == "completado", trabajo
    proyecto = cliente.get(f"/proyectos/{trabajo['resultado']['id']}").json()
    assert [(x["id"], x["nombre"]) for x in proyecto["pistas"]] == [
        ("voz", "Voz principal"), ("coros", "Coros"), ("bajo", "Bajo"),
        ("guitarra", "Guitarra rítmica"), ("guitarra_solista", "Guitarra solista"), ("otros", "Otros")]
    carpeta = modelo.carpeta(proyecto["id"]) / "stems"
    leer = lambda nombre: sf.read(str(carpeta / f"{nombre}.flac"), dtype="float32")[0]
    frames = len(leer("voz"))
    segundos = frames / FS
    voz_original, principal, *_ = _voz_con_coros(segundos)
    np.testing.assert_allclose(leer("voz") + leer("coros"), voz_original[:frames], atol=2e-4)     # la suma se conserva
    medio = slice(FS, frames - FS)
    assert np.corrcoef(leer("voz")[medio, 0], principal[:frames][medio])[0, 1] > 0.97
    # Lo no elegido (piano y batería) está sumado en «otros», no perdido.
    esperado = _tono(1500, segundos, 0.02)[:frames] + _tono(880, segundos, 0.002)[:frames] + _tono(3000, segundos, 0.05)[:frames]
    np.testing.assert_allclose(leer("otros")[:, 0], esperado, atol=2e-4)
    assert not (carpeta / "piano.flac").exists() and not list(carpeta.glob("_*"))
    assert proyecto["avisos"] == []


def test_si_no_hay_nada_que_dividir_se_avisa_y_se_deja_el_stem(carpeta_de_datos, tmp_path):
    stems_dir = tmp_path / "stems"
    stems_dir.mkdir()
    sola = np.stack([_tono(440, 4.0)] * 2, axis=1)
    sf.write(str(stems_dir / "voz.flac"), sola, FS, format="FLAC", subtype="PCM_24")
    stems = {"voz": stems_dir / "voz.flac"}
    aviso = orquestador.dividir_voz(stems, stems_dir)
    assert "No se encontraron coros" in aviso and list(stems) == ["voz"]
    assert sorted(p.name for p in stems_dir.iterdir()) == ["voz.flac"]
