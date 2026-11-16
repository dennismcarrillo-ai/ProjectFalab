"""ZIP «virtual»: sirve un proyecto como archivo .falab sin escribirlo en disco.

Un .falab es un ZIP sin compresión, así que su contenido es predecible byte a byte: cabeceras
pequeñas intercaladas con los archivos del proyecto tal cual están en disco. Aquí se calcula ese
mapa y se entrega cualquier tramo leyendo directamente de los archivos originales.

Ventajas para el servidor de banda: compartir la biblioteca no duplica el espacio en disco, y un
reproductor remoto puede pedir solo los trozos de audio que necesita (peticiones por rangos).
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

FECHA_DOS = (1 << 5) | 1          # 1980-01-01
BLOQUE = 256 * 1024


@dataclass
class Entrada:
    nombre: str
    tamano: int
    crc: int
    ruta: Path | None = None       # archivo en disco…
    datos: bytes | None = None     # …o contenido en memoria (p. ej. reproductor.json)


def crc_de_archivo(ruta: Path) -> int:
    crc = 0
    with open(ruta, "rb") as archivo:
        while bloque := archivo.read(1 << 20):
            crc = zlib.crc32(bloque, crc)
    return crc & 0xFFFFFFFF


class ZipVirtual:
    def __init__(self, entradas: list[Entrada]) -> None:
        # Lista de tramos (inicio, bytes en memoria | (ruta, tamaño)).
        self._tramos: list[tuple[int, bytes | tuple[Path, int]]] = []
        posicion = 0
        indice = b""
        for entrada in entradas:
            nombre = entrada.nombre.encode("utf-8")
            comunes = struct.pack("<HHHHHIII", 20, 0x0800, 0, 0, FECHA_DOS, entrada.crc, entrada.tamano, entrada.tamano)
            local = b"PK\x03\x04" + comunes + struct.pack("<HH", len(nombre), 0) + nombre
            indice += (b"PK\x01\x02" + struct.pack("<H", 20) + comunes + struct.pack("<HHHHHII", len(nombre), 0, 0, 0, 0, 0, posicion)
                       + nombre)
            self._tramos.append((posicion, local))
            posicion += len(local)
            if entrada.tamano:
                contenido = entrada.datos if entrada.datos is not None else (entrada.ruta, entrada.tamano)
                self._tramos.append((posicion, contenido))
                posicion += entrada.tamano
        final = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, len(entradas), len(entradas), len(indice), posicion, 0)
        self._tramos.append((posicion, indice + final))
        self.tamano = posicion + len(indice) + len(final)
        if self.tamano >= 0xFFFFFFFF:
            raise ValueError("El proyecto es demasiado grande para compartirlo (más de 4 GB).")

    def leer(self, desde: int = 0, hasta: int | None = None) -> Iterator[bytes]:
        """Genera los bytes del intervalo [desde, hasta) leyendo de disco solo lo necesario."""
        hasta = self.tamano if hasta is None else min(hasta, self.tamano)
        for inicio, contenido in self._tramos:
            largo = len(contenido) if isinstance(contenido, bytes) else contenido[1]
            a, b = max(desde, inicio), min(hasta, inicio + largo)
            if b <= a:
                continue
            if isinstance(contenido, bytes):
                yield contenido[a - inicio: b - inicio]
                continue
            with open(contenido[0], "rb") as archivo:
                archivo.seek(a - inicio)
                restante = b - a
                while restante > 0:
                    bloque = archivo.read(min(BLOQUE, restante))
                    if not bloque:
                        break
                    restante -= len(bloque)
                    yield bloque
