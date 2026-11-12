"""Arranque del motor: `python -m falab_motor [--puerto N]`."""
from __future__ import annotations

import argparse
import socket

import uvicorn

from . import config, drive


def _puerto_libre() -> int:
    with socket.socket() as enchufe:
        enchufe.bind(("127.0.0.1", 0))
        return enchufe.getsockname()[1]


def main() -> None:
    analizador = argparse.ArgumentParser(description="Motor local de falab")
    analizador.add_argument("--puerto", type=int, default=0, help="0 = elegir un puerto libre")
    argumentos = analizador.parse_args()
    config.asegurar_carpetas()
    drive.arrancar_sincronizador()
    puerto = argumentos.puerto or _puerto_libre()
    # La aplicación de escritorio lee esta línea para saber dónde escucha el motor.
    print(f"FALAB_MOTOR_LISTO puerto={puerto}", flush=True)
    uvicorn.run("falab_motor.servidor:app", host="127.0.0.1", port=puerto, log_level="warning")


if __name__ == "__main__":
    main()
