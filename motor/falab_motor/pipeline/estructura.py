"""Estructura de la canción: marcadores de ensayo (Intro, Verso, Coro…) y compás por sección.

La detección automática encuentra bien DÓNDE cambia la música (por repetición de armonía y
timbre) y acierta menos con el NOMBRE de cada parte, que depende de convenciones. Por eso todo
es editable: el resultado automático es un punto de partida.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

FS = 22050
SALTO = 1024
NOMBRES = ["Intro", "Verso", "Pre-coro", "Coro", "Puente", "Solo", "Instrumental", "Final"]


def _limites_de_pulsos(mapa: dict, duracion: float) -> np.ndarray:
    tiempos = np.array([p["t"] for p in mapa.get("pulsos", [])])
    if len(tiempos) < 8:
        tiempos = np.arange(0.0, max(duracion, 1.0), 0.5)
    return tiempos


def detectar(ruta_mezcla: Path, ruta_voz: Path | None, mapa: dict, duracion: float) -> list[dict]:
    """Devuelve [{inicio, fin, nombre}] cubriendo toda la canción."""
    import librosa

    onda, _ = librosa.load(str(ruta_mezcla), sr=FS, mono=True)
    if len(onda) < FS * 8:
        return [{"inicio": 0.0, "fin": round(duracion, 3), "nombre": "Canción"}]
    tiempos = _limites_de_pulsos(mapa, duracion)
    cuadros = librosa.time_to_frames(tiempos, sr=FS, hop_length=SALTO)

    # Rasgos por pulso: armonía (cromagrama) y timbre (MFCC), normalizados.
    croma = librosa.feature.chroma_cqt(y=onda, sr=FS, hop_length=SALTO)
    timbre = librosa.feature.mfcc(y=onda, sr=FS, hop_length=SALTO, n_mfcc=13)
    croma_p = librosa.util.sync(croma, cuadros, aggregate=np.median)
    timbre_p = librosa.util.sync(timbre, cuadros, aggregate=np.mean)
    timbre_p = (timbre_p - timbre_p.mean(axis=1, keepdims=True)) / (timbre_p.std(axis=1, keepdims=True) + 1e-9)
    rasgos = np.vstack([croma_p * 2.0, timbre_p * 0.5])
    n_pulsos = rasgos.shape[1]

    # Segmentación aglomerativa: une pulsos vecinos parecidos hasta quedarse con k tramos.
    k = int(np.clip(round(duracion / 22.0), 2, 14))
    k = min(k, max(2, n_pulsos // 8))
    cortes = librosa.segment.agglomerative(rasgos, k)          # índices de tramo sincronizado
    # sync devuelve un tramo inicial [0, primer pulso): el tramo i empieza en el pulso i-1.
    instantes = [0.0] + [float(tiempos[min(max(c - 1, 0), len(tiempos) - 1)]) for c in cortes[1:]]

    # ¿Se canta? Lo dice el stem de voz. Que la voz entre o salga es, además, la señal más clara
    # de cambio de sección (intro -> verso, verso -> solo…), aunque la armonía no cambie.
    energia_voz = None
    if ruta_voz is not None and ruta_voz.exists():
        voz, _ = librosa.load(str(ruta_voz), sr=FS, mono=True)
        energia_voz = librosa.feature.rms(y=voz, frame_length=2048, hop_length=SALTO)[0]
    umbral = 0.2 * float(np.percentile(energia_voz, 90)) if energia_voz is not None and energia_voz.size else 0.0
    if energia_voz is not None and umbral > 0:
        from scipy.ndimage import median_filter

        activa = librosa.util.sync((energia_voz > umbral)[None, :].astype(float), cuadros, aggregate=np.mean)[0]
        # Se suaviza a lo largo de dos compases: una pausa para respirar no es un cambio de sección.
        cantando = median_filter((activa > 0.25).astype(float), size=9, mode="nearest") > 0.5
        for i in np.flatnonzero(np.diff(cantando.astype(int)) != 0):
            instantes.append(float(tiempos[min(i, len(tiempos) - 1)]))

    # Los cambios de sección caen en primer tiempo de compás: se ajusta al «1» más cercano.
    unos = np.array([p["t"] for p in mapa.get("pulsos", []) if p.get("pulso") == 1])
    if len(unos):
        instantes = [0.0] + [float(unos[np.argmin(np.abs(unos - t))]) for t in instantes[1:]]
    instantes = sorted({round(t, 3) for t in instantes if t < duracion - 4.0})
    limpios = [instantes[0]]
    for t in instantes[1:]:
        if t - limpios[-1] >= 6.0:      # nada de secciones de un par de compases
            limpios.append(t)
    bordes = limpios + [round(duracion, 3)]

    tramos = []
    for inicio, fin in zip(bordes, bordes[1:]):
        a, b = librosa.time_to_frames([inicio, fin], sr=FS, hop_length=SALTO)
        perfil = croma[:, a:max(a + 1, b)].mean(axis=1)
        perfil = perfil / (np.linalg.norm(perfil) + 1e-9)
        con_voz = False
        if energia_voz is not None and umbral > 0:
            con_voz = float(np.mean(energia_voz[a:max(a + 1, b)] > umbral)) > 0.3
        tramos.append({"inicio": inicio, "fin": fin, "perfil": perfil, "voz": con_voz})

    # Tramos con armonía casi idéntica son la misma parte de la canción (misma etiqueta).
    grupos: list[np.ndarray] = []
    for tramo in tramos:
        parecido = [float(g @ tramo["perfil"]) for g in grupos]
        if parecido and max(parecido) > 0.94:
            tramo["grupo"] = int(np.argmax(parecido))
        else:
            tramo["grupo"] = len(grupos)
            grupos.append(tramo["perfil"])

    cantados = [t for t in tramos if t["voz"]]
    repeticiones: dict[int, int] = {}
    for t in cantados:
        repeticiones[t["grupo"]] = repeticiones.get(t["grupo"], 0) + 1
    grupo_verso = cantados[0]["grupo"] if cantados else None
    candidatos = [g for g, n in repeticiones.items() if n >= 2 and g != grupo_verso] or \
                 [g for g, n in repeticiones.items() if n >= 2]
    grupo_coro = max(candidatos, key=lambda g: repeticiones[g]) if candidatos else None
    if len(repeticiones) <= 1:
        grupo_coro = None           # una sola parte cantada: no hay con qué distinguir verso de coro
    elif grupo_coro == grupo_verso:
        grupo_verso = None

    secciones = []
    for i, t in enumerate(tramos):
        if not t["voz"]:
            nombre = "Intro" if i == 0 else "Final" if i == len(tramos) - 1 else "Instrumental"
        elif t["grupo"] == grupo_coro:
            nombre = "Coro"
        elif t["grupo"] == grupo_verso or repeticiones.get(t["grupo"], 0) >= 2:
            nombre = "Verso"
        else:
            nombre = "Puente" if i > len(tramos) // 2 else "Verso"
        if secciones and secciones[-1]["nombre"] == nombre and nombre in ("Intro", "Final", "Instrumental"):
            secciones[-1]["fin"] = t["fin"]
        else:
            secciones.append({"inicio": t["inicio"], "fin": t["fin"], "nombre": nombre})
    return secciones


def normalizar(secciones: list[dict], duracion: float) -> list[dict]:
    """Valida y ordena las secciones editadas a mano; cada una termina donde empieza la siguiente."""
    limpias = []
    for seccion in sorted(secciones, key=lambda s: float(s["inicio"])):
        inicio = max(0.0, min(float(seccion["inicio"]), duracion))
        nombre = str(seccion.get("nombre", "")).strip()[:40] or "Sección"
        if limpias and inicio - limpias[-1]["inicio"] < 0.5:
            continue
        nueva = {"inicio": round(inicio, 3), "fin": round(duracion, 3), "nombre": nombre}
        if seccion.get("compas"):
            nueva["compas"] = int(np.clip(int(seccion["compas"]), 1, 12))
        limpias.append(nueva)
    if limpias and limpias[0]["inicio"] > 0.5:
        limpias.insert(0, {"inicio": 0.0, "fin": limpias[0]["inicio"], "nombre": "Intro"})
    for actual, siguiente in zip(limpias, limpias[1:]):
        actual["fin"] = siguiente["inicio"]
    return limpias


def aplicar_compases(mapa: dict, secciones: list[dict]) -> dict:
    """Renumera compás y pulso según el compás indicado en cada sección.

    Funciona como en una partitura: el compás de una sección rige desde su primer pulso hasta
    que otra sección indique uno distinto. Sin indicaciones, el mapa queda tal cual.
    """
    cambios = [(s["inicio"], int(s["compas"])) for s in secciones if s.get("compas")]
    pulsos = mapa.get("pulsos", [])
    if not cambios or not pulsos:
        return mapa
    nuevos = []
    siguiente_cambio = 0
    tiempos_por_compas = None
    compas, pulso = 0, 0
    for original in pulsos:
        while siguiente_cambio < len(cambios) and original["t"] >= cambios[siguiente_cambio][0] - 0.06:
            tiempos_por_compas = cambios[siguiente_cambio][1]
            siguiente_cambio += 1
            compas, pulso = (nuevos[-1]["compas"] if nuevos else 0), tiempos_por_compas  # el próximo será un «1»
        if tiempos_por_compas is None:
            nuevos.append(original)
            continue
        if pulso >= tiempos_por_compas:
            compas, pulso = compas + 1, 1
        else:
            pulso += 1
        nuevos.append({**original, "compas": compas, "pulso": pulso, "tiempos": tiempos_por_compas})
    return {**mapa, "pulsos": nuevos}


def corregir_mapa(mapa: dict, operacion: str) -> dict:
    """Arreglos típicos de un mapa de pulsos automático.

    - «doble»: el seguidor contó a la mitad del tempo real; se añade un pulso entre cada dos.
    - «mitad»: contó al doble; se conserva un pulso de cada dos.
    - «desplazar»: el tiempo «1» está mal colocado; se mueve un pulso más tarde.
    """
    pulsos = mapa.get("pulsos", [])
    tiempos_por_compas = mapa.get("compas", 4)
    if len(pulsos) < 4:
        raise ValueError("Este proyecto no tiene mapa de pulsos.")
    primero = next((i for i, p in enumerate(pulsos) if p["pulso"] == 1), 0)
    if operacion == "doble":
        tiempos = []
        for a, b in zip(pulsos, pulsos[1:]):
            tiempos += [a["t"], (a["t"] + b["t"]) / 2]
        tiempos.append(pulsos[-1]["t"])
        primero *= 2
    elif operacion == "mitad":
        tiempos = [p["t"] for p in pulsos[primero % 2::2]]
        primero = (primero - primero % 2) // 2
    elif operacion == "desplazar":
        tiempos = [p["t"] for p in pulsos]
        primero += 1
    else:
        raise ValueError(f"Operación desconocida: {operacion}")
    if len(tiempos) < 4:
        raise ValueError("El mapa quedaría con muy pocos pulsos.")
    intervalos = np.diff(tiempos)
    intervalos = np.append(intervalos, intervalos[-1])
    relleno = np.pad(intervalos, 4, mode="edge")
    locales = 60.0 / np.maximum([np.median(relleno[i:i + 9]) for i in range(len(tiempos))], 1e-3)
    nuevos = []
    for i, (t, bpm) in enumerate(zip(tiempos, locales)):
        relativo = i - primero
        nuevos.append({"t": round(float(t), 4), "bpm": round(float(bpm), 2),
                       "compas": relativo // tiempos_por_compas + 1, "pulso": relativo % tiempos_por_compas + 1})
    return {**mapa, "bpm": round(float(np.median(locales)), 2), "pulsos": nuevos}
