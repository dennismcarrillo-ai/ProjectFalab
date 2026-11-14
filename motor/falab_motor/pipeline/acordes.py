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


# Nivel de detalle -> (subdivisiones por pulso, coste de cambiar de acorde).
# Con más detalle sobreviven los acordes de paso de un solo pulso (o de medio pulso).
DETALLES = {"normal": (1, 0.18), "alto": (1, 0.09), "maximo": (2, 0.06)}


def limites_de_analisis(mapa_tempo: dict, duracion: float, subdivisiones: int = 1) -> np.ndarray:
    """Instantes que delimitan los tramos de análisis: los pulsos (o fracciones), o una rejilla fija."""
    tiempos = [p["t"] for p in mapa_tempo.get("pulsos", [])]
    if len(tiempos) < 4:
        return np.arange(0.0, max(duracion, 0.5) + 0.5, 0.5 / subdivisiones)
    limites = np.array(tiempos)
    if limites[0] > 0.05:
        limites = np.insert(limites, 0, 0.0)
    if limites[-1] < duracion - 0.05:
        limites = np.append(limites, duracion)
    if subdivisiones > 1:
        indices = np.arange(len(limites))
        finos = np.linspace(0, len(limites) - 1, (len(limites) - 1) * subdivisiones + 1)
        limites = np.interp(finos, indices, limites)
    return limites


def tonalidad_inicial(analisis: dict, segundos: float = 30.0) -> dict | None:
    """Tonalidad de los primeros `segundos`, deducida de los acordes que suenan en ese tramo."""
    croma = np.zeros(12)
    for acorde in analisis.get("acordes", []):
        if acorde["inicio"] >= segundos:
            break
        peso = min(acorde["fin"], segundos) - acorde["inicio"]
        for intervalo in CALIDADES[acorde["calidad"]][0]:
            croma[(acorde["raiz"] + intervalo) % 12] += peso
        croma[acorde["raiz"]] += peso  # la fundamental pesa doble
    if croma.sum() <= 0:
        return None
    tonalidad = estimar_tonalidad(croma)
    nombre = f"{nombre_nota(tonalidad['tonica'], bemoles=tonalidad['bemoles'])} {tonalidad['modo']}"
    return {**tonalidad, "nombre": nombre}


# ------------------------------------------------------------ línea de bajo

def linea_de_bajo(limites: np.ndarray, croma_bajo: np.ndarray | None) -> list[dict]:
    """Nota que toca el bajo en cada tramo, agrupando tramos seguidos con la misma nota.

    Es independiente de los acordes: permite ver qué hace el bajo (inversiones, notas pedal,
    ostinatos) frente a la armonía general.
    """
    if croma_bajo is None or croma_bajo.shape[1] == 0:
        return []
    energia = croma_bajo.sum(axis=0)
    umbral = 0.12 * (np.percentile(energia, 90) if energia.any() else 1.0)
    notas = np.where(energia > umbral, croma_bajo.argmax(axis=0), -1)
    linea: list[dict] = []
    for i, nota in enumerate(notas):
        if nota < 0:
            continue
        inicio, fin = float(limites[i]), float(limites[i + 1])
        if linea and linea[-1]["nota"] == int(nota) and abs(linea[-1]["fin"] - inicio) < 1e-6:
            linea[-1]["fin"] = round(fin, 4)
        else:
            linea.append({"inicio": round(inicio, 4), "fin": round(fin, 4), "nota": int(nota)})
    return linea


def marcar_pedales(acordes: list[dict], linea: list[dict], minimo: int = 3) -> None:
    """Marca las notas pedal: el bajo mantiene una nota mientras la armonía cambia por encima.

    En esos acordes se anota el bajo real aunque no pertenezca al acorde (p. ej. F/C – G/C – C).
    """
    def bajo_de(acorde: dict) -> int | None:
        pesos = np.zeros(12)
        for tramo in linea:
            comun = min(tramo["fin"], acorde["fin"]) - max(tramo["inicio"], acorde["inicio"])
            if comun > 0:
                pesos[tramo["nota"]] += comun
        if pesos.sum() <= 0 or pesos.max() < 0.7 * pesos.sum():
            return None
        return int(pesos.argmax())

    bajos = [bajo_de(a) for a in acordes]
    i = 0
    while i < len(acordes):
        j = i
        while j + 1 < len(acordes) and bajos[j + 1] is not None and bajos[j + 1] == bajos[i] \
                and abs(acordes[j + 1]["inicio"] - acordes[j]["fin"]) < 0.05:
            j += 1
        tramo = acordes[i:j + 1]
        distintos = {(a["raiz"], a["calidad"]) for a in tramo}
        if bajos[i] is not None and len(tramo) >= minimo and len(distintos) >= 2:
            for acorde in tramo:
                acorde["pedal"] = True
                acorde["bajo"] = None if acorde["raiz"] == bajos[i] else bajos[i]
        i = j + 1


def ostinatos(limites: np.ndarray, croma_bajo: np.ndarray | None, tiempos_por_compas: int = 4,
              subdivisiones: int = 1) -> list[dict]:
    """Tramos donde el bajo repite el mismo dibujo de notas, compás tras compás."""
    if croma_bajo is None or croma_bajo.shape[1] == 0:
        return []
    energia = croma_bajo.sum(axis=0)
    umbral = 0.12 * (np.percentile(energia, 90) if energia.any() else 1.0)
    notas = np.where(energia > umbral, croma_bajo.argmax(axis=0), -1)
    periodo = tiempos_por_compas * subdivisiones
    encontrados: list[dict] = []
    n = len(notas)
    i = 0
    while i + 2 * periodo <= n:
        patron = notas[i:i + periodo]
        # Un ostinato tiene dibujo: al menos dos notas distintas y casi sin silencios.
        if len(set(patron[patron >= 0])) < 2 or np.sum(patron < 0) > periodo // 4:
            i += 1
            continue
        repeticiones = 1
        while i + (repeticiones + 1) * periodo <= n and \
                np.mean(notas[i + repeticiones * periodo: i + (repeticiones + 1) * periodo] == patron) >= 0.85:
            repeticiones += 1
        if repeticiones >= 4:
            fin = i + repeticiones * periodo
            encontrados.append({"inicio": round(float(limites[i]), 4), "fin": round(float(limites[fin]), 4),
                                "patron": [int(x) for x in patron], "repeticiones": repeticiones})
            i = fin
        else:
            i += 1
    return encontrados


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

    def nota(clase: int) -> str:
        return nombre_nota((clase + transponer) % 12, bemoles=bemoles, cifrado=cifrado)

    linea = [{**tramo, "nota": (tramo["nota"] + transponer) % 12, "nombre": nota(tramo["nota"])}
             for tramo in analisis.get("lineaBajo", [])]
    repetidos = [{**o, "patron": [(x + transponer) % 12 if x >= 0 else -1 for x in o["patron"]],
                  "nombre": " ".join(nota(x) if x >= 0 else "·" for x in o["patron"])}
                 for o in analisis.get("ostinatos", [])]
    return {"tonalidad": {**tonalidad, "nombre": nombre_tonalidad}, "acordes": acordes,
            "lineaBajo": linea, "ostinatos": repetidos}
