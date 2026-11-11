"""Cola de trabajos largos (análisis, exportación, sincronización).

Se ejecuta UN trabajo pesado a la vez: así nunca hay dos modelos de IA cargados en memoria
simultáneamente, que es lo que haría colapsar un equipo de 8 GB.
"""
from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable


class Cancelado(Exception):
    """El usuario canceló el trabajo."""


@dataclass
class Trabajo:
    id: str
    tipo: str
    estado: str = "pendiente"  # pendiente | ejecutando | completado | error | cancelado
    progreso: float = 0.0
    etapa: str = ""
    resultado: Any = None
    error: str | None = None
    avisos: list[str] = field(default_factory=list)
    _cancelar: threading.Event = field(default_factory=threading.Event, repr=False)

    def informar(self, progreso: float, etapa: str | None = None) -> None:
        """Actualiza el avance (0–1) y aborta si se pidió cancelar."""
        if self._cancelar.is_set():
            raise Cancelado()
        self.progreso = max(0.0, min(1.0, progreso))
        if etapa is not None:
            self.etapa = etapa

    def subetapa(self, desde: float, hasta: float, etapa: str) -> Callable[[float], None]:
        """Devuelve un informador que reparte el avance 0–1 de una etapa en [desde, hasta]."""
        self.informar(desde, etapa)
        return lambda fraccion: self.informar(desde + (hasta - desde) * fraccion)

    def a_dict(self) -> dict:
        return {
            "id": self.id, "tipo": self.tipo, "estado": self.estado,
            "progreso": round(self.progreso, 4), "etapa": self.etapa,
            "resultado": self.resultado, "error": self.error, "avisos": self.avisos,
        }


class GestorTrabajos:
    def __init__(self) -> None:
        self._trabajos: dict[str, Trabajo] = {}
        self._ejecutor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="falab-trabajo")

    def lanzar(self, tipo: str, funcion: Callable[[Trabajo], Any]) -> Trabajo:
        trabajo = Trabajo(id=uuid.uuid4().hex[:10], tipo=tipo)
        self._trabajos[trabajo.id] = trabajo

        def envoltura() -> None:
            if trabajo._cancelar.is_set():
                trabajo.estado = "cancelado"
                return
            trabajo.estado = "ejecutando"
            try:
                trabajo.resultado = funcion(trabajo)
                trabajo.progreso = 1.0
                trabajo.estado = "completado"
            except Cancelado:
                trabajo.estado = "cancelado"
            except Exception as error:  # noqa: BLE001 - se informa a la interfaz
                traceback.print_exc()
                trabajo.error = str(error) or error.__class__.__name__
                trabajo.estado = "error"

        self._ejecutor.submit(envoltura)
        return trabajo

    def obtener(self, id_trabajo: str) -> Trabajo | None:
        return self._trabajos.get(id_trabajo)

    def cancelar(self, id_trabajo: str) -> bool:
        trabajo = self._trabajos.get(id_trabajo)
        if not trabajo:
            return False
        trabajo._cancelar.set()
        return True
