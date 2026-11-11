"""Etapa 4b — Cifrado de acordes (estándar, jazz o latino) a partir de las notas detectadas.

Método: para cada pulso del mapa de tempo se construye un cromagrama (energía por cada una de
las 12 notas) con las notas MIDI de BasicPitch de los stems armónicos; se compara con plantillas
de acordes (tríadas, séptimas, disminuidos, suspendidos, sextas y novenas) y se suaviza con
Viterbi para que el acorde no «parpadee» de un pulso a otro. La fundamental se desambigua con
el stem de bajo, que también permite escribir inversiones (C/E).
"""
from __future__ import annotations

import numpy as np

SOSTENIDOS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
BEMOLES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
LATINO = {"C": "Do", "D": "Re", "E": "Mi", "F": "Fa", "G": "Sol", "A": "La", "B": "Si"}

# calidad -> (intervalos, sufijo estándar, sufijo jazz, penalización por complejidad)
CALIDADES: dict[str, tuple[tuple[int, ...], str, str, float]] = {
    "maj": ((0, 4, 7), "", "", 0.0),
    "min": ((0, 3, 7), "m", "-", 0.0),
    "7": ((0, 4, 7, 10), "7", "7", 0.02),
    "maj7": ((0, 4, 7, 11), "maj7", "Δ7", 0.02),
    "m7": ((0, 3, 7, 10), "m7", "-7", 0.02),
    "6": ((0, 4, 7, 9), "6", "6", 0.04),
    "m6": ((0, 3, 7, 9), "m6", "-6", 0.04),
    "dim": ((0, 3, 6), "dim", "°", 0.03),
    "dim7": ((0, 3, 6, 9), "dim7", "°7", 0.04),
    "m7b5": ((0, 3, 6, 10), "m7b5", "ø7", 0.04),
    "aug": ((0, 4, 8), "aug", "+", 0.04),
    "sus4": ((0, 5, 7), "sus4", "sus4", 0.04),
    "sus2": ((0, 2, 7), "sus2", "sus2", 0.05),
    "9": ((0, 4, 7, 10, 2), "9", "9", 0.05),
    "maj9": ((0, 4, 7, 11, 2), "maj9", "Δ9", 0.05),
    "m9": ((0, 3, 7, 10, 2), "m9", "-9", 0.05),
}
NOMBRES_CALIDAD = list(CALIDADES)

# Perfiles de Krumhansl-Kessler para estimar la tonalidad.
_PERFIL_MAYOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_PERFIL_MENOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_TONICAS_CON_BEMOLES = {("mayor", 5), ("mayor", 10), ("mayor", 3), ("mayor", 8), ("mayor", 1),
                        ("menor", 2), ("menor", 7), ("menor", 0), ("menor", 5), ("menor", 10), ("menor", 3)}


def nombre_nota(clase: int, *, bemoles: bool, cifrado: str = "estandar") -> str:
    nombre = (BEMOLES if bemoles else SOSTENIDOS)[clase % 12]
    if cifrado == "latino":
        return LATINO[nombre[0]] + nombre[1:]
    return nombre


def nombre_acorde(raiz: int, calidad: str, bajo: int | None = None, *,
                  cifrado: str = "estandar", bemoles: bool = False) -> str:
    """Escribe el acorde en el cifrado pedido: «estandar» (Cm7), «jazz» (C-7) o «latino» (Dom7)."""
    _, estandar, jazz, _ = CALIDADES[calidad]
    texto = nombre_nota(raiz, bemoles=bemoles, cifrado=cifrado) + (jazz if cifrado == "jazz" else estandar)
    if bajo is not None and bajo != raiz:
        texto += "/" + nombre_nota(bajo, bemoles=bemoles, cifrado=cifrado)
    return texto


def croma_desde_notas(notas: list[dict], limites: np.ndarray) -> np.ndarray:
    """Cromagrama (12, n_tramos): cada nota aporta su duración dentro del tramo × su intensidad."""
    croma = np.zeros((12, len(limites) - 1))
    for nota in notas:
        primero = max(0, int(np.searchsorted(limites, nota["inicio"], side="right")) - 1)
        for i in range(primero, len(limites) - 1):
            if limites[i] >= nota["fin"]:
                break
            comun = min(nota["fin"], limites[i + 1]) - max(nota["inicio"], limites[i])
            if comun > 0:
                croma[nota["tono"] % 12, i] += comun * (0.5 + nota.get("velocidad", 80) / 254)
    return croma


def croma_desde_audio(onda: np.ndarray, fs: int, limites: np.ndarray) -> np.ndarray:
    """Alternativa sin BasicPitch: cromagrama CQT del audio, promediado por tramo."""
    import librosa

    salto = 2048
    croma = librosa.feature.chroma_cqt(y=onda, sr=fs, hop_length=salto)
    cuadros = np.clip(librosa.time_to_frames(limites, sr=fs, hop_length=salto), 0, croma.shape[1])
    salida = np.zeros((12, len(limites) - 1))
    for i in range(len(limites) - 1):
        a, b = cuadros[i], max(cuadros[i] + 1, cuadros[i + 1])
        tramo = croma[:, a:b]
        if tramo.size:
            salida[:, i] = tramo.mean(axis=1)
    # Se resta el fondo para que el ruido de banda ancha no parezca un acorde.
    salida = np.maximum(salida - np.median(salida, axis=0, keepdims=True), 0.0)
    return salida


def estimar_tonalidad(croma_total: np.ndarray) -> dict:
    """Tonalidad por correlación con los perfiles de Krumhansl-Kessler."""
    mejor = (-2.0, 0, "mayor")
    if croma_total.sum() > 0:
        for tonica in range(12):
            for modo, perfil in (("mayor", _PERFIL_MAYOR), ("menor", _PERFIL_MENOR)):
                r = float(np.corrcoef(croma_total, np.roll(perfil, tonica))[0, 1])
                if r > mejor[0]:
                    mejor = (r, tonica, modo)
    _, tonica, modo = mejor
    return {"tonica": tonica, "modo": modo, "bemoles": (modo, tonica) in _TONICAS_CON_BEMOLES}


def _plantillas() -> tuple[np.ndarray, np.ndarray]:
    filas, penalizaciones = [], []
    for raiz in range(12):
        for calidad in NOMBRES_CALIDAD:
            intervalos, _, _, penal = CALIDADES[calidad]
            fila = np.zeros(12)
            fila[[(raiz + i) % 12 for i in intervalos]] = 1.0
            filas.append(fila / np.linalg.norm(fila))
            penalizaciones.append(penal)
    return np.array(filas), np.array(penalizaciones)


def detectar(
    limites: np.ndarray,
    croma_armonia: np.ndarray,
    croma_bajo: np.ndarray | None = None,
    *,
    coste_cambio: float = 0.18,
) -> dict:
    """Devuelve {tonalidad, acordes:[{inicio, fin, raiz, calidad, bajo}]}.

    `limites` son los instantes que delimitan los tramos (normalmente los pulsos) y los
    cromagramas tienen una columna por tramo.
    """
    n = croma_armonia.shape[1]
    if n == 0:
        return {"tonalidad": estimar_tonalidad(np.zeros(12)), "acordes": []}
    if croma_bajo is None:
        croma_bajo = np.zeros_like(croma_armonia)
    plantillas, penalizaciones = _plantillas()
    n_calidades = len(NOMBRES_CALIDAD)

    # El bajo también forma parte de la armonía, con menos peso para no tapar las tensiones.
    total = croma_armonia + 0.5 * croma_bajo
    norma = np.linalg.norm(total, axis=0)
    umbral_silencio = 0.08 * (np.percentile(norma, 90) if norma.any() else 1.0)
    unitario = total / np.maximum(norma, 1e-9)
    bajo_unitario = croma_bajo / np.maximum(croma_bajo.sum(axis=0), 1e-9)

    emision = plantillas @ unitario - penalizaciones[:, None]          # (estados, tramos)
    emision += 0.2 * np.repeat(bajo_unitario, n_calidades, axis=0)     # la fundamental suele estar en el bajo
    sin_acorde = np.where(norma < umbral_silencio, 1.0, 0.35)[None, :]  # estado «N»
    emision = np.vstack([emision, sin_acorde])

    # Viterbi con un único coste por cambiar de acorde.
    estados = emision.shape[0]
    acumulado = emision[:, 0].copy()
    anterior = np.zeros((estados, n), dtype=np.int32)
    for t in range(1, n):
        mejor_previo = int(np.argmax(acumulado))
        cambiar = acumulado[mejor_previo] - coste_cambio
        quedarse = acumulado >= cambiar
        anterior[:, t] = np.where(quedarse, np.arange(estados), mejor_previo)
        acumulado = np.where(quedarse, acumulado, cambiar) + emision[:, t]
    camino = np.empty(n, dtype=np.int32)
    camino[-1] = int(np.argmax(acumulado))
    for t in range(n - 1, 0, -1):
        camino[t - 1] = anterior[camino[t], t]

    acordes = []
    inicio = 0
    for t in range(1, n + 1):
        if t < n and camino[t] == camino[inicio]:
            continue
        estado = int(camino[inicio])
        if estado < estados - 1:
            raiz, calidad = divmod(estado, n_calidades)
            notas_acorde = {(raiz + i) % 12 for i in CALIDADES[NOMBRES_CALIDAD[calidad]][0]}
            grave = croma_bajo[:, inicio:t].sum(axis=1)
            nota_bajo = int(np.argmax(grave)) if grave.sum() > 0 else None
            # Solo se anota inversión si el bajo toca claramente otra nota del propio acorde.
            if nota_bajo is not None and (nota_bajo == raiz or nota_bajo not in notas_acorde
                                          or grave[nota_bajo] < 0.6 * grave.sum()):
                nota_bajo = None
            acordes.append({
                "inicio": round(float(limites[inicio]), 4), "fin": round(float(limites[t]), 4),
                "raiz": int(raiz), "calidad": NOMBRES_CALIDAD[calidad], "bajo": nota_bajo,
            })
        inicio = t
    return {"tonalidad": estimar_tonalidad(total.sum(axis=1)), "acordes": acordes}


def limites_de_analisis(mapa_tempo: dict, duracion: float) -> np.ndarray:
    """Instantes que delimitan los tramos de análisis: los pulsos, o una rejilla de 0,5 s."""
    tiempos = [p["t"] for p in mapa_tempo.get("pulsos", [])]
    if len(tiempos) < 4:
        return np.arange(0.0, max(duracion, 0.5) + 0.5, 0.5)
    limites = np.array(tiempos)
    if limites[0] > 0.05:
        limites = np.insert(limites, 0, 0.0)
    if limites[-1] < duracion - 0.05:
        limites = np.append(limites, duracion)
    return limites


def con_nombres(analisis: dict, cifrado: str = "estandar", transponer: int = 0) -> dict:
    """Añade a cada acorde su nombre en el cifrado pedido y el nombre de la tonalidad.

    `transponer` (semitonos) desplaza acordes y tonalidad: es lo que se muestra cuando el usuario
    sube o baja el tono de la canción.
    """
    tonalidad = dict(analisis.get("tonalidad") or {"tonica": 0, "modo": "mayor", "bemoles": False})
    if transponer:
        tonalidad["tonica"] = (tonalidad["tonica"] + transponer) % 12
        tonalidad["bemoles"] = (tonalidad["modo"], tonalidad["tonica"]) in _TONICAS_CON_BEMOLES
    bemoles = bool(tonalidad.get("bemoles"))
    acordes = []
    for a in analisis.get("acordes", []):
        raiz = (a["raiz"] + transponer) % 12
        bajo = None if a.get("bajo") is None else (a["bajo"] + transponer) % 12
        acordes.append({**a, "raiz": raiz, "bajo": bajo,
                        "nombre": nombre_acorde(raiz, a["calidad"], bajo, cifrado=cifrado, bemoles=bemoles)})
    nombre_tonalidad = f"{nombre_nota(tonalidad['tonica'], bemoles=bemoles, cifrado=cifrado)} {tonalidad['modo']}"
    return {"tonalidad": {**tonalidad, "nombre": nombre_tonalidad}, "acordes": acordes}
