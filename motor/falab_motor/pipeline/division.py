"""División de un stem en dos: lo que suena en el centro y lo que suena a los lados.

Se usa para separar la voz principal de los coros y la guitarra solista de la rítmica. Se apoya
en cómo se mezcla casi toda la música grabada: la voz principal y los solos van al centro, y los
coros, dobles y guitarras rítmicas se abren a izquierda y derecha.

Es un método de señal (DSP), no un modelo neuronal. Ventajas: es rápido, no descarga nada y
conserva la suma (centro + lados = stem original, muestra a muestra). Límite: si los coros
están mezclados en el centro junto a la voz principal, no puede distinguirlos. Para ese caso
existe la vía neuronal opcional de `dividir_voz_neuronal`.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal

from ..config import FRECUENCIA
from ..medios import escribir_flac

N_FFT = 2048
SALTO = 512
SEGUNDOS_BLOQUE = 20      # se procesa por bloques para no tener el espectro entero en memoria
SEGUNDOS_SOLAPE = 1
MODELO_KARAOKE = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"


def _centro_de_bloque(bloque: np.ndarray) -> np.ndarray:
    """Señal mono que está presente por igual (y en fase) en ambos canales."""
    _, _, izq = signal.stft(bloque[:, 0], FRECUENCIA, nperseg=N_FFT, noverlap=N_FFT - SALTO)
    _, _, der = signal.stft(bloque[:, 1], FRECUENCIA, nperseg=N_FFT, noverlap=N_FFT - SALTO)
    # Parecido entre canales en cada punto del espectro: 1 = idénticos (centro), 0 = solo en un lado.
    parecido = 2 * np.real(izq * np.conj(der)) / (np.abs(izq) ** 2 + np.abs(der) ** 2 + 1e-12)
    mascara = np.clip(parecido, 0.0, 1.0) ** 2
    _, centro = signal.istft(mascara * (izq + der) / 2, FRECUENCIA, nperseg=N_FFT, noverlap=N_FFT - SALTO)
    if len(centro) < len(bloque):
        centro = np.pad(centro, (0, len(bloque) - len(centro)))
    return centro[: len(bloque)].astype(np.float32)


def separar_centro_lados(onda: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Devuelve (centro, lados), ambos estéreo y con centro + lados == onda."""
    frames = len(onda)
    bloque = SEGUNDOS_BLOQUE * FRECUENCIA
    solape = SEGUNDOS_SOLAPE * FRECUENCIA
    centro = np.zeros(frames, dtype=np.float32)
    for posicion in range(0, frames, bloque):
        desde = max(0, posicion - solape)
        hasta = min(frames, posicion + bloque + solape)
        parcial = _centro_de_bloque(onda[desde:hasta])
        if posicion == 0:
            centro[:hasta] = parcial
            continue
        # Fundido cruzado con el final del bloque anterior, para que no se oiga la costura.
        n = posicion - desde
        rampa = np.linspace(0.0, 1.0, n, dtype=np.float32)
        centro[desde:posicion] = centro[desde:posicion] * (1.0 - rampa) + parcial[:n] * rampa
        centro[posicion:hasta] = parcial[n:]
    centro_estereo = np.stack([centro, centro], axis=1)
    return centro_estereo, (onda - centro_estereo).astype(np.float32)


def relacion_lados_centro_db(centro: np.ndarray, lados: np.ndarray) -> float:
    """Energía de los lados respecto al centro, en dB (0 = iguales; muy negativo = casi todo centro)."""
    e_centro = float(np.mean(centro.astype(np.float64) ** 2))
    e_lados = float(np.mean(lados.astype(np.float64) ** 2))
    if e_lados <= 1e-12:
        return -120.0
    if e_centro <= 1e-12:
        return 120.0
    return float(10 * np.log10(e_lados / e_centro))


def dividir_archivo(ruta: Path, ruta_centro: Path, ruta_lados: Path) -> float:
    """Divide un stem en disco. Devuelve la relación lados/centro en dB."""
    import soundfile as sf

    onda, _ = sf.read(str(ruta), dtype="float32", always_2d=True)
    if onda.shape[1] == 1:
        onda = np.repeat(onda, 2, axis=1)
    centro, lados = separar_centro_lados(onda[:, :2])
    relacion = relacion_lados_centro_db(centro, lados)
    escribir_flac(ruta_centro, centro)
    escribir_flac(ruta_lados, lados)
    return relacion


# ------------------------------------------------------------- vía neuronal opcional

def ejecutable_neuronal() -> Path | None:
    """Programa `audio-separator` del entorno aislado de coros, si el usuario lo instaló.

    Vive en un entorno virtual propio (motor/.venv-coros) porque necesita versiones de PyTorch
    incompatibles con las de Demucs: así ninguna de las dos instalaciones puede romper la otra.
    """
    import os

    candidatos = [os.environ.get("FALAB_SEPARADOR_COROS", ""),
                  str(Path(__file__).resolve().parents[2] / ".venv-coros" / "bin" / "audio-separator")]
    for candidato in candidatos:
        if candidato and Path(candidato).is_file():
            return Path(candidato)
    return None


def dividir_voz_neuronal(ruta_voz: Path, ruta_principal: Path, ruta_coros: Path) -> None:
    """Separa voz principal y coros con un modelo «karaoke» (distingue coros aunque estén al centro)."""
    programa = ejecutable_neuronal()
    if programa is None:
        raise RuntimeError("El separador neuronal de coros no está instalado.")
    with tempfile.TemporaryDirectory() as carpeta:
        # El modelo llama «vocals» a la voz principal y «instrumental» a todo lo demás (aquí, los coros).
        nombres = {"Vocals": "principal", "Lead Vocals": "principal", "Karaoke": "principal",
                   "Instrumental": "coros", "Backing Vocals": "coros", "Other": "coros"}
        orden = [str(programa), str(ruta_voz), "--model_filename", MODELO_KARAOKE, "--output_dir", carpeta,
                 "--output_format", "FLAC", "--custom_output_names", json.dumps(nombres)]
        proceso = subprocess.run(orden, capture_output=True, text=True, timeout=3600)
        principal, coros = Path(carpeta) / "principal.flac", Path(carpeta) / "coros.flac"
        if proceso.returncode != 0 or not principal.exists() or not coros.exists():
            raise RuntimeError(f"El separador neuronal de coros falló: {proceso.stderr.strip()[-300:]}")
        shutil.move(str(principal), str(ruta_principal))
        shutil.move(str(coros), str(ruta_coros))
