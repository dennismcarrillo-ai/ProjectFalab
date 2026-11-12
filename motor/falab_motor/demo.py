"""Crea un proyecto de demostración con stems sintéticos: `python -m falab_motor.demo`.

Sirve para probar la interfaz y las exportaciones sin haber descargado todavía los modelos de
IA. Los stems se sintetizan (no pasan por Demucs), pero el anti-bleed, el mapa de pulsos y el
cifrado de acordes se calculan de verdad sobre ese audio.
"""
from __future__ import annotations

import numpy as np

from . import config, medios, proyecto as modelo
from .pipeline import acordes, anti_bleed, mapa_tempo, orquestador

FS = config.FRECUENCIA
BPM = 96.0
# Progresión I–vi–IV–V7 en Do mayor, un compás por acorde: (nombre, notas MIDI, fundamental del bajo)
PROGRESION = [("C", [60, 64, 67], 36), ("Am", [57, 60, 64], 33), ("F", [53, 57, 60], 29), ("G7", [55, 59, 62, 65], 31)]
LETRA = ["Esta es una canción de prueba", "que falab separa en pistas",
         "con sus acordes y su compás", "lista para editar y mezclar"]


def _hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _nota(midi: float, segundos: float, armonicos: int = 6, caida: float = 3.0) -> np.ndarray:
    t = np.arange(int(segundos * FS)) / FS
    onda = sum(np.sin(2 * np.pi * _hz(midi) * k * t) / k for k in range(1, armonicos + 1))
    envolvente = np.minimum(1.0, t / 0.01) * np.exp(-caida * t)
    return (onda * envolvente).astype(np.float32)


def _bombo() -> np.ndarray:
    t = np.arange(int(0.25 * FS)) / FS
    fase = 2 * np.pi * (45 * t + (110 / 30) * (1 - np.exp(-30 * t)))
    return (np.sin(fase) * np.exp(-14 * t)).astype(np.float32)


def _ruido(segundos: float, caida: float, semilla: int) -> np.ndarray:
    t = np.arange(int(segundos * FS)) / FS
    blanco = np.random.default_rng(semilla).standard_normal(len(t))
    return (np.diff(blanco, prepend=0) * np.exp(-caida * t)).astype(np.float32)


def _poner(destino: np.ndarray, sonido: np.ndarray, segundo: float, ganancia: float = 1.0) -> None:
    inicio = int(segundo * FS)
    n = min(len(sonido), len(destino) - inicio)
    if n > 0:
        destino[inicio:inicio + n] += sonido[:n] * ganancia


def sintetizar(vueltas: int = 4) -> tuple[dict[str, np.ndarray], dict]:
    """Devuelve ({id_stem: onda estéreo}, letras con marcas de tiempo por palabra)."""
    pulso = 60.0 / BPM
    compases = vueltas * len(PROGRESION)
    frames = int((compases * 4 * pulso + 1.0) * FS)
    stems = {s: np.zeros(frames, dtype=np.float32) for s in config.ORDEN_PISTAS}
    segmentos = []
    for compas in range(compases):
        _, notas, grave = PROGRESION[compas % len(PROGRESION)]
        t0 = compas * 4 * pulso
        for p in range(4):
            t = t0 + p * pulso
            _poner(stems["bajo"], _nota(grave + (12 if p == 3 else 0), pulso * 0.95, 4, 2.0), t, 0.5)
            _poner(stems["bateria"], _bombo(), t, 0.8 if p in (0, 2) else 0.0)
            _poner(stems["bateria"], _ruido(0.18, 28, compas * 8 + p), t, 0.35 if p in (1, 3) else 0.0)
            _poner(stems["bateria"], _ruido(0.05, 90, 1000 + compas * 8 + p), t + pulso / 2, 0.15)
            for n in notas:  # guitarra: rasgueo en cada pulso
                _poner(stems["guitarra"], _nota(n, pulso * 0.9, 8, 5.0), t + 0.004 * notas.index(n), 0.16)
        for n in notas:      # piano: acorde tenido todo el compás
            _poner(stems["piano"], _nota(n + 12, 4 * pulso, 3, 0.9), t0, 0.14)
        _poner(stems["otros"], _nota(notas[0] + 24, 4 * pulso, 2, 0.3), t0, 0.05)
        if (compas // len(PROGRESION)) % 2 == 1:  # la voz entra en las vueltas pares
            palabras = LETRA[compas % len(LETRA)].split()
            paso = 4 * pulso / (len(palabras) + 1)
            marcas = []
            for i, palabra in enumerate(palabras):
                _poner(stems["voz"], _nota(notas[i % len(notas)] + 12, paso * 0.9, 5, 1.5), t0 + i * paso, 0.22)
                marcas.append({"inicio": round(t0 + i * paso, 3), "fin": round(t0 + (i + 0.9) * paso, 3),
                               "texto": palabra})
            segmentos.append({"inicio": marcas[0]["inicio"], "fin": marcas[-1]["fin"],
                              "texto": " ".join(palabras), "palabras": marcas})
    estereo = {}
    for i, (id_stem, onda) in enumerate(stems.items()):
        apertura = 0.15 * ((i % 3) - 1)  # una ligera apertura estéreo distinta por instrumento
        estereo[id_stem] = np.stack([onda * (1 - apertura), onda * (1 + apertura)], axis=1).astype(np.float32)
    return estereo, {"idioma": "es", "segmentos": segmentos}


def crear_proyecto(nombre: str = "Demostración falab", vueltas: int = 4) -> dict:
    config.asegurar_carpetas()
    ondas, letras = sintetizar(vueltas)
    p = modelo.crear(nombre, {"ruta": "", "nombre": "(sintético)", "tieneVideo": False})
    carpeta = modelo.carpeta(p["id"])
    # Se simula el sangrado típico de Demucs para que el anti-bleed tenga algo que corregir.
    bajo = ondas["bajo"] + 0.25 * ondas["bateria"]
    bateria = 0.75 * ondas["bateria"] + 0.0 * ondas["bajo"]
    ondas["bajo"], ondas["bateria"], _ = anti_bleed.reducir_sangrado(bajo, bateria)
    stems = {}
    for id_stem, onda in ondas.items():
        stems[id_stem] = carpeta / "stems" / f"{id_stem}.flac"
        medios.escribir_flac(stems[id_stem], onda)
    mezcla = carpeta / "audio" / "mezcla.flac"
    medios.escribir_flac(mezcla, sum(ondas.values()))
    p["duracion"] = medios.frames_de(mezcla) / FS
    orquestador.construir_pistas(p, carpeta, stems, mezcla)
    mapa = mapa_tempo.analizar(stems["bateria"], mezcla)
    p["bpm"], p["compas"] = mapa["bpm"], mapa["compas"]
    modelo.escribir_analisis(p["id"], "mapa_tempo", mapa)
    modelo.escribir_analisis(p["id"], "notas", notas_exactas(vueltas))
    modelo.escribir_analisis(p["id"], "acordes", orquestador._acordes({}, stems, mezcla, mapa, p["duracion"]))
    modelo.escribir_analisis(p["id"], "letras", letras)
    from .pipeline import estructura

    modelo.escribir_analisis(p["id"], "estructura", {
        "secciones": estructura.detectar(mezcla, stems["voz"], mapa, p["duracion"]), "automatica": True})
    p["avisos"].append("Proyecto de demostración con audio sintético (no ha pasado por Demucs ni Whisper).")
    modelo.guardar(p)
    return p


def notas_exactas(vueltas: int = 4) -> dict[str, list[dict]]:
    """Las notas MIDI que se sintetizaron (hacen el papel de la salida de BasicPitch)."""
    pulso = 60.0 / BPM
    notas: dict[str, list[dict]] = {"bajo": [], "guitarra": [], "piano": []}
    for compas in range(vueltas * len(PROGRESION)):
        _, tonos, grave = PROGRESION[compas % len(PROGRESION)]
        t0 = compas * 4 * pulso
        for p in range(4):
            t = t0 + p * pulso
            notas["bajo"].append({"inicio": t, "fin": t + pulso * 0.95, "tono": grave + (12 if p == 3 else 0), "velocidad": 90})
            notas["guitarra"] += [{"inicio": t, "fin": t + pulso * 0.9, "tono": n, "velocidad": 80} for n in tonos]
        notas["piano"] += [{"inicio": t0, "fin": t0 + 4 * pulso, "tono": n + 12, "velocidad": 70} for n in tonos]
    return notas


if __name__ == "__main__":
    creado = crear_proyecto()
    print(f"Proyecto de demostración creado: {creado['id']} en {modelo.carpeta(creado['id'])}")
