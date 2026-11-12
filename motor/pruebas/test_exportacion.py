import numpy as np
import pytest
import soundfile as sf
from scipy import signal

from falab_motor import demo, proyecto as modelo
from falab_motor.config import FRECUENCIA as FS
from falab_motor.exportacion import cancionero, cuantizacion, partitura, render, tablatura
from falab_motor.exportacion.exportar import exportar
from falab_motor.trabajos import Trabajo

MAPA = {"bpm": 120.0, "compas": 4,
        "pulsos": [{"t": 0.5 * i, "bpm": 120.0, "compas": i // 4 + 1, "pulso": i % 4 + 1} for i in range(16)]}


def test_cuantizacion_sigue_el_mapa_de_pulsos():
    # Un mapa que frena: los pulsos se separan cada vez más, pero siguen siendo negras.
    instantes = np.cumsum(np.linspace(0.4, 0.7, 12))
    mapa = {"bpm": 110, "compas": 4, "pulsos": [
        {"t": float(t), "bpm": 110, "compas": i // 4 + 1, "pulso": i % 4 + 1} for i, t in enumerate(instantes)]}
    notas = [{"inicio": float(instantes[i]) + 0.01, "fin": float(instantes[i + 1]), "tono": 60 + i} for i in range(8)]
    grupos = cuantizacion.agrupar(notas, mapa)
    assert [g["posicion"] for g in grupos] == [float(i) for i in range(8)]
    assert all(g["duracion"] == 1.0 for g in grupos)


def test_eq_plano_no_altera_y_estante_sube_los_graves():
    ruido = np.random.default_rng(1).standard_normal((FS, 2)).astype(np.float32) * 0.1
    plano = modelo.eq_por_defecto()
    np.testing.assert_array_equal(render.ecualizar(ruido, plano), ruido)
    realzado = {**plano, "bajos": {"frecuencia": 200.0, "ganancia": 12.0}}
    frecuencias, antes = signal.welch(ruido[:, 0], FS, nperseg=4096)
    _, despues = signal.welch(render.ecualizar(ruido, realzado)[:, 0], FS, nperseg=4096)
    ganancia = 10 * np.log10(despues / antes)
    assert abs(ganancia[frecuencias < 60].mean() - 12) < 1.0   # graves: +12 dB
    assert abs(ganancia[frecuencias > 5000].mean()) < 0.5       # agudos: intactos


def test_paneo_de_potencia_constante():
    onda = np.ones((10, 2), dtype=np.float32)
    np.testing.assert_allclose(render.panear(onda, -1.0), np.tile([2.0, 0.0], (10, 1)), atol=1e-6)
    np.testing.assert_allclose(render.panear(onda, 1.0), np.tile([0.0, 2.0], (10, 1)), atol=1e-6)
    assert render.panear(onda, 0.0) is onda


def test_velocidad_y_tono_son_independientes():
    t = np.arange(FS * 2) / FS
    onda = np.stack([np.sin(2 * np.pi * 440 * t)] * 2, axis=1).astype(np.float32)

    def frecuencia_dominante(x):
        espectro = np.abs(np.fft.rfft(x[:, 0] * np.hanning(len(x))))
        return np.argmax(espectro) * FS / len(x)

    lenta = render.estirar_y_transponer(onda, 0.5, 0)
    assert abs(len(lenta) / len(onda) - 2.0) < 0.02
    assert abs(frecuencia_dominante(lenta) - 440) < 5          # más lenta, mismo tono
    aguda = render.estirar_y_transponer(onda, 1.0, 12)
    assert abs(len(aguda) / len(onda) - 1.0) < 0.02
    assert abs(frecuencia_dominante(aguda) - 880) < 10         # una octava arriba, misma duración


def test_render_respeta_clips_solo_y_silencio(carpeta_de_datos):
    p = demo.crear_proyecto(vueltas=1)
    carpeta = modelo.carpeta(p["id"])
    completa = render.renderizar(p, carpeta)["mezcla"]
    assert abs(len(completa) / FS - p["duracion"]) < 0.01

    # Solo el bajo, recortado a un clip de 2 s que empieza en el segundo 1 de la fuente y se pega en 0.
    for pista in p["pistas"]:
        pista["solo"] = pista["id"] == "bajo"
    bajo = next(x for x in p["pistas"] if x["id"] == "bajo")
    bajo["clips"] = [{**bajo["clips"][0], "inicio": 0.0, "desplazamiento": 1.0, "duracion": 2.0}]
    recorte = render.renderizar(p, carpeta)["mezcla"]
    assert np.abs(recorte[2 * FS:]).max() == 0          # después del clip solo hay silencio
    recorte = recorte[:2 * FS]
    original, _ = sf.read(str(carpeta / "stems" / "bajo.flac"), dtype="float32")
    margen = int(0.01 * FS)  # fuera de los fundidos anti-clic de los bordes
    np.testing.assert_allclose(recorte[margen:-margen], original[FS + margen:3 * FS - margen], atol=2e-4)


def test_exportaciones_de_partitura_tablatura_y_cancionero(carpeta_de_datos):
    p = demo.crear_proyecto(vueltas=2)
    trabajo = Trabajo(id="t", tipo="exportar")
    salidas = {}
    for peticion in [
        {"tipo": "cancionero", "formato": "txt"}, {"tipo": "cancionero", "formato": "pdf", "cifrado": "latino"},
        {"tipo": "partitura"}, {"tipo": "midi"},
        {"tipo": "tablatura", "instrumento": "guitarra"}, {"tipo": "tablatura", "instrumento": "bajo"},
        {"tipo": "mezcla", "formato": "flac"}, {"tipo": "mezcla", "formato": "mp3"}, {"tipo": "pistas", "formato": "wav"},
    ]:
        rutas = exportar(p["id"], peticion, trabajo)["archivos"]
        assert rutas and all(__import__("os").path.getsize(r) > 100 for r in rutas), peticion
        salidas[(peticion["tipo"], peticion.get("formato") or peticion.get("instrumento"))] = rutas
    assert len(salidas[("pistas", "wav")]) == 6

    texto = open(salidas[("cancionero", "txt")][0], encoding="utf-8").read()
    assert "| C | Am | F | G" in texto             # introducción instrumental
    assert "Esta es una canción de prueba" in texto
    lineas = texto.splitlines()
    fila_acordes = lineas[lineas.index("Esta es una canción de prueba") - 1]
    assert fila_acordes.startswith("C")
    assert open(salidas[("cancionero", "pdf")][0], "rb").read(4) == b"%PDF"

    tab = open(salidas[("tablatura", "bajo")][0], encoding="utf-8").read()
    assert tab.count("\nE|") >= 1 and "G|" in tab
    fila_la = next(l for l in tab.splitlines() if l.startswith("A|"))
    fila_mi = next(l for l in tab.splitlines() if l.startswith("E|"))
    assert fila_la.startswith("A|-3-")               # Do grave (MIDI 36) = traste 3 de la cuerda La
    assert "-5-" in fila_mi                          # La grave en la cuerda Mi

    from music21 import converter

    partitura_leida = converter.parse(salidas[("partitura", None)][0])
    assert len(partitura_leida.parts) == 3
    bajo = partitura_leida.parts[0]
    assert [n.pitch.midi for n in bajo.recurse().notes][:4] == [36, 36, 36, 48]


def test_cancionero_coloca_el_acorde_sobre_su_palabra():
    letras = {"segmentos": [{"inicio": 0.0, "fin": 4.0, "texto": "uno dos tres", "palabras": [
        {"inicio": 0.0, "fin": 1.0, "texto": "uno"}, {"inicio": 1.5, "fin": 2.0, "texto": "dos"},
        {"inicio": 3.0, "fin": 4.0, "texto": "tres"}]}]}
    acordes = [{"inicio": 0.0, "fin": 3.0, "nombre": "Am"}, {"inicio": 3.0, "fin": 4.0, "nombre": "G7"}]
    lineas = cancionero.construir(letras, acordes, 4.0)
    assert lineas[0]["acordes"] == [{"columna": 0, "nombre": "Am", "t": 0.0}, {"columna": 8, "nombre": "G7", "t": 3.0}]
    assert cancionero.a_texto("T", "La menor", 100, lineas).splitlines()[-2:] == ["Am      G7", "uno dos tres"]


def test_tablatura_sin_notas_avisa():
    with pytest.raises(ValueError):
        tablatura.a_texto([], MAPA, "guitarra", "x")


def test_cancionero_no_pierde_acordes():
    """Los acordes entre líneas, varios sobre una palabra y los de paso deben aparecer todos."""
    letras = {"segmentos": [
        {"inicio": 2.0, "fin": 5.0, "texto": "uno dos", "palabras": [
            {"inicio": 2.0, "fin": 3.0, "texto": "uno"}, {"inicio": 3.2, "fin": 5.0, "texto": "dosssssss"}]},
        {"inicio": 7.0, "fin": 9.0, "texto": "tres", "palabras": [{"inicio": 7.0, "fin": 9.0, "texto": "tres"}]},
        {"inicio": 20.0, "fin": 22.0, "texto": "fin", "palabras": [{"inicio": 20.0, "fin": 22.0, "texto": "fin"}]}]}
    nombres = ["C", "G/B", "Am", "Em", "F", "G", "C", "Dm", "G7", "C"]
    tiempos = [0.0, 1.0, 2.0, 3.6, 4.4, 5.5, 6.2, 7.0, 9.5, 20.0, 23.0]
    acordes = [{"inicio": a, "fin": b, "nombre": n} for n, a, b in zip(nombres, tiempos, tiempos[1:])]
    lineas = cancionero.construir(letras, acordes, 23.0)

    primera, segunda, instrumental, ultima = lineas
    # Entrada corta (C, G/B antes de cantar), dos acordes dentro de «dosssssss» y dos en la pausa.
    assert [m["nombre"] for m in primera["acordes"]] == ["C", "G/B", "Am", "Em", "F", "G", "C"]
    columnas = [m["columna"] for m in primera["acordes"]]
    assert columnas == sorted(columnas)
    em, fa = primera["acordes"][3], primera["acordes"][4]
    assert 4 <= em["columna"] < fa["columna"] < len(primera["texto"])      # cada uno sobre su sílaba
    assert all(m["columna"] >= len(primera["texto"]) for m in primera["acordes"][5:])  # pausa: tras el texto
    assert [m["nombre"] for m in segunda["acordes"]] == ["Dm"]
    assert instrumental["tipo"] == "instrumental" and instrumental["texto"] == "| G7 |"
    assert [m["nombre"] for m in ultima["acordes"]] == ["C"]

    # Ningún cambio de acorde se queda fuera del cancionero.
    escritos = sum(len(l["acordes"]) for l in lineas) + instrumental["texto"].count("|") - 1
    assert escritos == len(acordes)
    texto = cancionero.a_texto("T", "Do mayor", 100, lineas).splitlines()
    assert texto[3] == "C G/B Am Em F G C" or texto[3].startswith("C G/B Am")
