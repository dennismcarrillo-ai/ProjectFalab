"""Orquestador del pipeline local de IA.

    Medio de entrada ──FFmpeg──► mezcla.flac
        └─► 1. Demucs (stems) ─► 2. Anti-bleed (bajo/bombo) ─► 3. librosa (mapa de pulsos)
            ─► 4. BasicPitch (notas MIDI) + cifrado de acordes ─► 5. Whisper (letras)

Reglas de diseño:
* Las etapas van en SERIE y cada modelo se carga, se usa y se libera; nunca coexisten dos.
* Cada etapa escribe su resultado en disco: la siguiente lo relee solo si lo necesita.
* Si falta un modelo opcional o una etapa falla, se anota un aviso y el proyecto sigue siendo
  utilizable (por ejemplo, sin letras), en lugar de perder todo el análisis.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np

from .. import config, medios, proyecto as modelo
from ..trabajos import Cancelado, Trabajo
from . import acordes, anti_bleed, mapa_tempo

OPCIONES_POR_DEFECTO = {
    "separar": True,
    "antiBleed": True,
    "intensidadAntiBleed": 1.0,
    "extraerNotas": True,
    "transcribirLetras": True,
    "calidadLetras": "equilibrado",
    "idioma": None,
}
UMBRAL_STEM_VACIO_DB = -55.0
STEMS_CON_NOTAS = ["voz", "bajo", "guitarra", "piano", "otros"]


def importar(ruta_medio: Path, opciones: dict, trabajo: Trabajo) -> dict:
    """Ejecuta el pipeline completo sobre un archivo y devuelve el resumen del proyecto creado."""
    opciones = {**OPCIONES_POR_DEFECTO, **(opciones or {})}
    ruta_medio = Path(ruta_medio).expanduser()
    if not ruta_medio.exists():
        raise FileNotFoundError(f"No se encuentra el archivo: {ruta_medio}")
    if ruta_medio.suffix.lower() not in config.EXTENSIONES_ADMITIDAS:
        raise ValueError(f"Formato no admitido: {ruta_medio.suffix}")

    trabajo.informar(0.0, "Leyendo el archivo")
    info = medios.sondear(ruta_medio)
    if not info["tieneAudio"]:
        raise ValueError("El archivo no contiene ninguna pista de audio.")
    p = modelo.crear(ruta_medio.stem, {
        "ruta": str(ruta_medio), "nombre": ruta_medio.name, "tieneVideo": info["tieneVideo"],
    })
    carpeta = modelo.carpeta(p["id"])
    try:
        _ejecutar(p, carpeta, ruta_medio, opciones, trabajo)
    except BaseException:
        shutil.rmtree(carpeta, ignore_errors=True)  # no dejar proyectos a medias
        raise
    return {"id": p["id"], "nombre": p["nombre"], "avisos": p["avisos"]}


def _ejecutar(p: dict, carpeta: Path, ruta_medio: Path, opciones: dict, trabajo: Trabajo) -> None:
    avisos: list[str] = p["avisos"]

    def intentar(descripcion: str, funcion):
        """Ejecuta una etapa opcional; si falla, deja constancia y continúa."""
        try:
            return funcion()
        except Cancelado:
            raise
        except ImportError as error:
            avisos.append(f"{descripcion}: falta instalar el componente de IA ({error.name}).")
        except Exception as error:  # noqa: BLE001
            avisos.append(f"{descripcion}: {error}")
        return None

    # 0 · Normalización del medio de entrada.
    trabajo.informar(0.02, "Extrayendo el audio")
    mezcla = carpeta / "audio" / "mezcla.flac"
    medios.extraer_audio(ruta_medio, mezcla)
    p["duracion"] = medios.frames_de(mezcla) / config.FRECUENCIA

    # 1 · Separación de stems con Demucs.
    stems: dict[str, Path] = {}
    if opciones["separar"]:
        from . import separacion

        avance = trabajo.subetapa(0.05, 0.55, "Separando instrumentos (Demucs)")
        stems = intentar("Separación de instrumentos",
                         lambda: separacion.separar(mezcla, carpeta / "stems", progreso=avance)) or {}

    # 2 · Anti-bleed bajo/bombo.
    if opciones["antiBleed"] and "bajo" in stems and "bateria" in stems:
        trabajo.informar(0.56, "Limpiando graves (bajo y bombo)")
        intentar("Filtro anti-bleed", lambda: anti_bleed.aplicar_a_archivos(
            stems["bajo"], stems["bateria"], intensidad=float(opciones["intensidadAntiBleed"])))

    construir_pistas(p, carpeta, stems, mezcla)

    # 3 · Mapa de pulsos (sobre la batería si existe: sus transitorios son los más limpios).
    trabajo.informar(0.62, "Analizando el tempo")
    referencia = stems.get("bateria")
    if referencia is None or medios.nivel_rms_db(referencia) < UMBRAL_STEM_VACIO_DB:
        referencia = mezcla
    mapa = intentar("Mapa de tempo", lambda: mapa_tempo.analizar(referencia, mezcla)) or {
        "bpm": 120.0, "compas": 4, "pulsos": [], "duracion": p["duracion"]}
    p["bpm"], p["compas"] = mapa["bpm"], mapa["compas"]
    modelo.escribir_analisis(p["id"], "mapa_tempo", mapa)

    # 4 · Notas (BasicPitch) y acordes.
    notas: dict[str, list[dict]] = {}
    if opciones["extraerNotas"] and stems:
        from . import notas as modulo_notas

        candidatos = [s for s in STEMS_CON_NOTAS
                      if s in stems and medios.nivel_rms_db(stems[s]) > UMBRAL_STEM_VACIO_DB]
        for i, id_stem in enumerate(candidatos):
            trabajo.informar(0.65 + 0.15 * i / max(1, len(candidatos)), f"Transcribiendo notas: {id_stem}")
            resultado = intentar(f"Notas de {id_stem}", lambda s=id_stem: modulo_notas.transcribir(
                stems[s], s, carpeta / "analisis" / f"notas_{s}.mid"))
            if resultado is None and any("falta instalar" in a for a in avisos[-1:]):
                break  # sin BasicPitch no tiene sentido reintentar con cada stem
            if resultado:
                notas[id_stem] = resultado
    modelo.escribir_analisis(p["id"], "notas", notas)

    trabajo.informar(0.81, "Cifrando acordes")
    analisis_acordes = intentar("Acordes", lambda: _acordes(notas, stems, mezcla, mapa, p["duracion"]))
    modelo.escribir_analisis(p["id"], "acordes", analisis_acordes or {
        "tonalidad": {"tonica": 0, "modo": "mayor", "bemoles": False}, "acordes": []})

    # 5 · Letras con Whisper, sobre el stem de voz.
    letras = {"idioma": None, "segmentos": []}
    if opciones["transcribirLetras"]:
        from . import letras as modulo_letras

        voz = stems.get("voz", mezcla)
        if medios.nivel_rms_db(voz) > UMBRAL_STEM_VACIO_DB:
            trabajo.informar(0.84, "Transcribiendo la letra (Whisper)")
            letras = intentar("Letras", lambda: modulo_letras.transcribir(
                voz, calidad=opciones["calidadLetras"], idioma=opciones["idioma"])) or letras
    modelo.escribir_analisis(p["id"], "letras", letras)

    trabajo.informar(0.98, "Guardando el proyecto")
    modelo.guardar(p)


def construir_pistas(p: dict, carpeta: Path, stems: dict[str, Path], mezcla: Path) -> None:
    """Crea fuentes, pistas y picos de onda. Sin stems, el proyecto tiene una sola pista de mezcla."""
    p["fuentes"], p["pistas"] = [], []
    if stems:
        nombres = {clave: (nombre, color) for clave, nombre, color in config.STEMS.values()}
        entradas = [(s, *nombres[s], stems[s]) for s in config.ORDEN_PISTAS if s in stems]
    else:
        entradas = [("mezcla", "Mezcla", "#5eead4", mezcla)]
    for id_pista, nombre, color, ruta in entradas:
        frames = medios.frames_de(ruta)
        p["fuentes"].append({"id": id_pista, "archivo": ruta.relative_to(carpeta).as_posix(),
                             "frames": frames, "canales": 2})
        medios.calcular_picos(ruta, carpeta / "picos" / f"{id_pista}.bin")
        p["pistas"].append(modelo.nueva_pista(id_pista, nombre, color, frames))


def _acordes(notas: dict, stems: dict[str, Path], mezcla: Path, mapa: dict, duracion: float) -> dict:
    limites = acordes.limites_de_analisis(mapa, duracion)
    armonicas = [n for s in ("guitarra", "piano", "otros") for n in notas.get(s, [])]
    if armonicas:
        croma = acordes.croma_desde_notas(armonicas, limites)
        croma_bajo = acordes.croma_desde_notas(notas.get("bajo", []), limites)
        return acordes.detectar(limites, croma, croma_bajo)
    # Sin notas de BasicPitch: se analiza directamente el audio armónico.
    import librosa

    fs = 22050
    rutas = [stems[s] for s in ("guitarra", "piano", "otros") if s in stems] or [mezcla]
    onda = sum(librosa.load(str(r), sr=fs, mono=True)[0] for r in rutas)
    croma = acordes.croma_desde_audio(np.asarray(onda), fs, limites)
    croma_bajo = None
    if "bajo" in stems:
        croma_bajo = acordes.croma_desde_audio(librosa.load(str(stems["bajo"]), sr=fs, mono=True)[0], fs, limites)
    return acordes.detectar(limites, croma, croma_bajo)
