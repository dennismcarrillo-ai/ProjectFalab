"""Pistas añadidas por el usuario: audio o MIDI importado, grabaciones de micrófono y de cámara.

Las grabaciones llegan del navegador por trozos de unos segundos que se van escribiendo a disco:
ni la interfaz ni el motor guardan una toma entera en memoria, dure lo que dure.
"""
from __future__ import annotations

import base64
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from . import config, medios, proyecto as modelo
from .trabajos import Trabajo

COLORES = ["#f87171", "#34d399", "#60a5fa", "#fbbf24", "#c084fc", "#f472b6"]
EXTENSIONES_MIDI = {".mid", ".midi"}
MAX_PISTAS = 12  # salidas del procesador de audio


def _nuevo_id_de_fuente(p: dict) -> str:
    usados = {f["id"] for f in p["fuentes"]}
    n = 1
    while f"extra_{n}" in usados:
        n += 1
    return f"extra_{n}"


def _registrar(p: dict, carpeta: Path, ruta: Path, id_fuente: str, nombre: str, inicio: float,
               id_pista: str | None) -> dict:
    """Da de alta la fuente y coloca un clip con ella en la pista indicada (o en una nueva)."""
    frames = medios.frames_de(ruta)
    p["fuentes"].append({"id": id_fuente, "archivo": ruta.relative_to(carpeta).as_posix(), "frames": frames, "canales": 2})
    medios.calcular_picos(ruta, carpeta / "picos" / f"{id_fuente}.bin")
    clip = {"id": modelo.nuevo_id(), "fuenteId": id_fuente, "inicio": max(0.0, float(inicio)), "desplazamiento": 0.0,
            "duracion": frames / config.FRECUENCIA, "ganancia": 0.0, "fundidoEntrada": 0.0, "fundidoSalida": 0.0}
    pista = next((x for x in p["pistas"] if x["id"] == id_pista), None)
    if pista is None:
        if len(p["pistas"]) >= MAX_PISTAS:
            raise ValueError(f"Un proyecto admite como máximo {MAX_PISTAS} pistas.")
        extras = sum(1 for x in p["pistas"] if x.get("instrumento") == "extra")
        pista = modelo.nueva_pista(id_pista or f"pista_{modelo.nuevo_id()}", nombre, COLORES[extras % len(COLORES)], frames)
        pista["instrumento"] = "extra"
        pista["clips"] = []
        p["pistas"].append(pista)
    pista["clips"] = sorted([*pista["clips"], clip], key=lambda c: c["inicio"])
    return pista


# ------------------------------------------------------------------ importar

def _buscar_soundfont() -> Path | None:
    import os

    candidatos = [os.environ.get("FALAB_SOUNDFONT", "")]
    for base in ("/opt/homebrew/share", "/usr/local/share", "/usr/share"):
        for patron in ("soundfonts/*.sf2", "sounds/sf2/*.sf2", "fluid-synth/sf2/*.sf2"):
            candidatos += [str(r) for r in Path(base).glob(patron)]
    for candidato in candidatos:
        if candidato and Path(candidato).is_file():
            return Path(candidato)
    return None


def _sintetizar_midi(ruta_midi: Path, destino_wav: Path) -> str | None:
    """Convierte un MIDI en audio. Devuelve un aviso si hubo que usar el sintetizador básico."""
    fuente = _buscar_soundfont()
    if shutil.which("fluidsynth") and fuente:
        orden = ["fluidsynth", "-ni", "-g", "0.8", "-r", str(config.FRECUENCIA), "-F", str(destino_wav),
                 str(fuente), str(ruta_midi)]
        if subprocess.run(orden, capture_output=True, timeout=600).returncode == 0 and destino_wav.exists():
            return None
    # Sin FluidSynth: sintetizador propio muy simple (ondas con armónicos y caída), para no fallar.
    import pretty_midi

    midi = pretty_midi.PrettyMIDI(str(ruta_midi))
    fs = config.FRECUENCIA
    onda = np.zeros(int((midi.get_end_time() + 1.5) * fs), dtype=np.float32)
    for instrumento in midi.instruments:
        if instrumento.is_drum:
            continue
        for nota in instrumento.notes:
            n = int((nota.end - nota.start + 0.3) * fs)
            t = np.arange(n) / fs
            hz = 440.0 * 2 ** ((nota.pitch - 69) / 12)
            tono = sum(np.sin(2 * np.pi * hz * k * t) / k for k in range(1, 5))
            envolvente = np.minimum(1.0, t / 0.008) * np.exp(-2.5 * t) * np.minimum(1.0, (n / fs - t) / 0.05)
            inicio = int(nota.start * fs)
            onda[inicio:inicio + n] += (tono * envolvente * nota.velocity / 127 * 0.15).astype(np.float32)[: len(onda) - inicio]
    pico = float(np.max(np.abs(onda))) if len(onda) else 0.0
    if pico > 0.95:
        onda *= 0.95 / pico
    sf.write(str(destino_wav), onda, fs)
    return ("El MIDI se convirtió con un sintetizador básico. Para un sonido realista instala FluidSynth "
            "(brew install fluid-synth) y un SoundFont, e indícalo en la variable FALAB_SOUNDFONT.")


def importar_archivo(id_proyecto: str, ruta: Path, inicio: float, id_pista: str | None, trabajo: Trabajo) -> dict:
    """Añade un archivo de audio o MIDI como clip en una pista nueva o existente."""
    ruta = Path(ruta).expanduser()
    if not ruta.exists():
        raise FileNotFoundError(f"No se encuentra el archivo: {ruta}")
    extension = ruta.suffix.lower()
    if extension not in config.EXTENSIONES_ADMITIDAS | EXTENSIONES_MIDI:
        raise ValueError(f"Formato no admitido: {extension}")
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    id_fuente = _nuevo_id_de_fuente(p)
    destino = carpeta / "audio" / f"{id_fuente}.flac"
    aviso = None
    trabajo.informar(0.1, "Convirtiendo el archivo")
    if extension in EXTENSIONES_MIDI:
        with tempfile.TemporaryDirectory() as temporal:
            wav = Path(temporal) / "midi.wav"
            aviso = _sintetizar_midi(ruta, wav)
            medios.extraer_audio(wav, destino)
    else:
        medios.extraer_audio(ruta, destino)
    trabajo.informar(0.8, "Añadiendo la pista")
    pista = _registrar(p, carpeta, destino, id_fuente, ruta.stem[:40], inicio, id_pista)
    modelo.guardar(p)
    return {"pista": pista["id"], "avisos": [aviso] if aviso else []}


# ---------------------------------------------------------------- grabaciones

_cerrojo = threading.Lock()
_sesiones: dict[str, dict] = {}


def iniciar_grabacion(id_proyecto: str, tipo: str, extension: str = "") -> str:
    """Abre una toma de «audio» (PCM de 16 bits) o de «video» (el contenedor que dé el navegador)."""
    modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    sesion = uuid.uuid4().hex[:12]
    if tipo == "audio":
        ruta = carpeta / "audio" / f"toma_{sesion}.wav"
        ruta.parent.mkdir(parents=True, exist_ok=True)
        archivo = sf.SoundFile(str(ruta), "w", config.FRECUENCIA, 2, subtype="PCM_16")
    elif tipo == "video":
        if extension not in ("webm", "mp4"):
            raise ValueError("Contenedor de video no admitido.")
        ruta = carpeta / "video" / f"toma_{sesion}.{extension}"
        ruta.parent.mkdir(parents=True, exist_ok=True)
        archivo = open(ruta, "wb")
    else:
        raise ValueError("Tipo de grabación desconocido.")
    with _cerrojo:
        _sesiones[sesion] = {"proyecto": id_proyecto, "tipo": tipo, "ruta": ruta, "archivo": archivo, "frames": 0}
    return sesion


def _sesion(id_sesion: str, id_proyecto: str) -> dict:
    with _cerrojo:
        sesion = _sesiones.get(id_sesion)
    if not sesion or sesion["proyecto"] != id_proyecto:
        raise KeyError("Grabación desconocida.")
    return sesion


def anadir_trozo(id_proyecto: str, id_sesion: str, datos_b64: str, canales: int = 2) -> int:
    """Añade a la toma un trozo recibido en base64. Devuelve los frames (o bytes) acumulados."""
    sesion = _sesion(id_sesion, id_proyecto)
    crudo = base64.b64decode(datos_b64)
    if sesion["tipo"] == "audio":
        muestras = np.frombuffer(crudo, dtype="<i2")
        if canales == 1:
            muestras = np.repeat(muestras, 2)       # micrófono mono: mismo audio en ambos canales
        muestras = muestras[: len(muestras) // 2 * 2].reshape(-1, 2)
        sesion["archivo"].write(muestras)
        sesion["frames"] += len(muestras)
    else:
        sesion["archivo"].write(crudo)
        sesion["frames"] += len(crudo)
    return sesion["frames"]


def cancelar_grabacion(id_proyecto: str, id_sesion: str) -> None:
    sesion = _sesion(id_sesion, id_proyecto)
    sesion["archivo"].close()
    sesion["ruta"].unlink(missing_ok=True)
    with _cerrojo:
        _sesiones.pop(id_sesion, None)


def terminar_audio(id_proyecto: str, id_sesion: str, inicio: float, id_pista: str | None, nombre: str) -> dict:
    """Cierra la toma de audio y la coloca como clip en la pista, en el instante `inicio`."""
    sesion = _sesion(id_sesion, id_proyecto)
    sesion["archivo"].close()
    with _cerrojo:
        _sesiones.pop(id_sesion, None)
    if sesion["frames"] < config.FRECUENCIA // 10:
        sesion["ruta"].unlink(missing_ok=True)
        raise ValueError("La grabación está vacía.")
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    id_fuente = _nuevo_id_de_fuente(p)
    destino = carpeta / "audio" / f"{id_fuente}.flac"
    datos, _ = sf.read(str(sesion["ruta"]), dtype="float32", always_2d=True)
    # Si la compensación de latencia deja el inicio antes de 0, se recorta el principio de la toma.
    if inicio < 0:
        datos = datos[int(round(-inicio * config.FRECUENCIA)):]
        inicio = 0.0
    medios.escribir_flac(destino, datos)
    sesion["ruta"].unlink(missing_ok=True)
    pista = _registrar(p, carpeta, destino, id_fuente, nombre, inicio, id_pista)
    modelo.guardar(p)
    return {"pista": pista["id"], "fuente": id_fuente}


def terminar_video(id_proyecto: str, id_sesion: str, inicio: float) -> dict:
    """Cierra la toma de cámara y la convierte a MP4 (H.264), reproducible en cualquier equipo."""
    sesion = _sesion(id_sesion, id_proyecto)
    sesion["archivo"].close()
    with _cerrojo:
        _sesiones.pop(id_sesion, None)
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    videos = p.setdefault("videos", [])
    numero = 1 + max([int(v["id"].split("_")[1]) for v in videos if v["id"].startswith("camara_")], default=0)
    id_video = f"camara_{numero}"
    destino = carpeta / "video" / f"{id_video}.mp4"
    try:
        medios.ejecutar_ffmpeg(["-i", str(sesion["ruta"]), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                                "-pix_fmt", "yuv420p", "-g", "30", "-movflags", "+faststart", str(destino)])
    finally:
        sesion["ruta"].unlink(missing_ok=True)
    videos.append({"id": id_video, "nombre": f"Cámara {numero}", "archivo": destino.relative_to(carpeta).as_posix(),
                   "inicio": max(0.0, float(inicio))})
    modelo.guardar(p)
    return {"video": id_video}


# ----------------------------------------------------------------------- video

def preparar_video_original(id_proyecto: str, trabajo: Trabajo | None = None) -> Path:
    """Copia ligera (720p, H.264, sin audio) del video original para verlo sincronizado en la app.

    Se hace una copia porque el WebView no reproduce todos los formatos (p. ej. MKV) y porque
    con fotogramas clave frecuentes los saltos de posición son inmediatos.
    """
    p = modelo.cargar(id_proyecto)
    original = p.get("medioOriginal", {})
    if not original.get("tieneVideo"):
        raise ValueError("El archivo original de este proyecto no tiene video.")
    destino = modelo.carpeta(id_proyecto) / "video" / "original.mp4"
    if destino.exists():
        return destino
    origen = Path(original["ruta"])
    if not origen.exists():
        raise FileNotFoundError(f"No se encuentra el video original: {origen}")
    if trabajo:
        trabajo.informar(0.1, "Preparando el video")
    destino.parent.mkdir(parents=True, exist_ok=True)
    temporal = destino.with_suffix(".tmp.mp4")
    medios.ejecutar_ffmpeg(["-i", str(origen), "-an", "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264",
                            "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-g", "30",
                            "-movflags", "+faststart", str(temporal)])
    temporal.replace(destino)
    return destino


def ruta_de_video(id_proyecto: str, id_video: str) -> tuple[Path, float]:
    """(archivo, instante de la canción en que empieza) del video original o de una toma de cámara."""
    p = modelo.cargar(id_proyecto)
    carpeta = modelo.carpeta(id_proyecto)
    if id_video == "original":
        return preparar_video_original(id_proyecto), 0.0
    for video in p.get("videos", []):
        if video["id"] == id_video:
            return carpeta / video["archivo"], float(video.get("inicio", 0.0))
    raise KeyError("Video desconocido.")
