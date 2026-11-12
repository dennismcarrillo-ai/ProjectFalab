"""Entrada MIDI (pedales USB o Bluetooth) para controlar el directo.

El WebView de macOS no tiene Web MIDI, así que los mensajes se leen aquí con python-rtmidi y la
interfaz los recoge con una petición que espera hasta que llega algo («long polling»): la
latencia es de pocos milisegundos y no hay sondeo constante.

Un pedal Bluetooth aparece como dispositivo MIDI normal una vez emparejado en
«Configuración de Audio MIDI» de macOS.
"""
from __future__ import annotations

import threading
from collections import deque

_condicion = threading.Condition()
_eventos: deque = deque(maxlen=256)
_contador = 0
_entradas: dict[str, object] = {}
_error: str | None = None


def _recibir(puerto: str, mensaje: list[int]) -> None:
    """Anota un mensaje MIDI y despierta a quien esté esperando."""
    global _contador
    if not mensaje or mensaje[0] >= 0xF0:
        return  # reloj, «active sensing», sysex…: no son pulsaciones
    with _condicion:
        _contador += 1
        _eventos.append({
            "n": _contador, "puerto": puerto, "estado": mensaje[0] & 0xF0, "canal": (mensaje[0] & 0x0F) + 1,
            "dato1": mensaje[1] if len(mensaje) > 1 else 0, "dato2": mensaje[2] if len(mensaje) > 2 else 0,
        })
        _condicion.notify_all()


def explorar() -> dict:
    """Abre los puertos MIDI nuevos y cierra los desaparecidos. Devuelve el estado."""
    global _error
    try:
        import rtmidi
    except ImportError:
        return {"disponible": False, "puertos": [], "ultimo": _contador,
                "error": "Falta el componente python-rtmidi. Vuelve a ejecutar scripts/instalar_mac.sh."}
    try:
        sonda = rtmidi.MidiIn()
        nombres = list(sonda.get_ports())
        for nombre in list(_entradas):
            if nombre not in nombres:
                _entradas.pop(nombre).close_port()  # type: ignore[attr-defined]
        for indice, nombre in enumerate(nombres):
            if nombre in _entradas:
                continue
            entrada = rtmidi.MidiIn()
            entrada.ignore_types(sysex=True, timing=True, active_sense=True)
            entrada.set_callback(lambda evento, _datos=None, n=nombre: _recibir(n, list(evento[0])))
            entrada.open_port(indice)
            _entradas[nombre] = entrada
        del sonda
        _error = None
    except Exception as error:  # noqa: BLE001 - un controlador MIDI defectuoso no debe tumbar el motor
        _error = str(error) or error.__class__.__name__
    return {"disponible": True, "puertos": sorted(_entradas), "ultimo": _contador, "error": _error}


def esperar(desde: int, segundos: float = 20.0) -> list[dict]:
    """Devuelve los mensajes posteriores al número `desde`, esperando si aún no hay ninguno."""
    with _condicion:
        if _contador <= desde:
            _condicion.wait(timeout=max(0.0, min(segundos, 30.0)))
        return [e for e in _eventos if e["n"] > desde]
