/**
 * Decodificación de FLAC fuera del hilo de la interfaz.
 *
 * Descomprimir el audio de todas las pistas es el trabajo más pesado del reproductor. Hecho en el
 * hilo principal, en un teléfono la pantalla se queda «pegada» a ratos. Aquí se hace aparte: el
 * hilo principal solo trae los bytes (del archivo o de la red) cuando este hilo se los pide.
 */
import { DecodificadorFlac } from "./flac";
import type { Lector } from "./lector";

type Entrada =
  | { tipo: "abrir"; id: number; tamano: number }
  | { tipo: "leer"; id: number; peticion: number; inicio: number; cuantos: number }
  | { tipo: "bytes"; peticion: number; datos: ArrayBuffer | null; error?: string }
  | { tipo: "cerrar"; id: number };

const hilo = self as unknown as { postMessage(mensaje: unknown, transferibles?: Transferable[]): void; onmessage: ((e: MessageEvent<Entrada>) => void) | null };

let siguientePeticion = 1;
const esperas = new Map<number, { resolver(bytes: Uint8Array): void; rechazar(error: Error): void }>();
const abiertos = new Map<number, Promise<DecodificadorFlac>>();

/** Lector que pide cada tramo al hilo principal. */
class LectorRemoto implements Lector {
  constructor(private id: number, readonly tamano: number) {}
  leer(desde: number, cuantos: number): Promise<Uint8Array> {
    return new Promise((resolver, rechazar) => {
      const peticion = siguientePeticion++;
      esperas.set(peticion, { resolver, rechazar });
      hilo.postMessage({ tipo: "pedirBytes", id: this.id, peticion, desde, cuantos });
    });
  }
}

hilo.onmessage = (evento) => {
  const m = evento.data;
  if (m.tipo === "abrir") {
    abiertos.set(m.id, DecodificadorFlac.abrir(new LectorRemoto(m.id, m.tamano)));
    // Un fallo al abrir se comunica en la primera lectura.
    abiertos.get(m.id)!.catch(() => undefined);
  } else if (m.tipo === "bytes") {
    const espera = esperas.get(m.peticion);
    esperas.delete(m.peticion);
    if (m.datos) espera?.resolver(new Uint8Array(m.datos));
    else espera?.rechazar(new Error(m.error ?? "No se pudo leer el archivo."));
  } else if (m.tipo === "leer") {
    const decodificador = abiertos.get(m.id);
    if (!decodificador) return hilo.postMessage({ tipo: "muestras", peticion: m.peticion, datos: null, error: "Audio cerrado." });
    decodificador
      .then((d) => d.leer(m.inicio, m.cuantos))
      .then((muestras) => {
        // Se envía una copia exacta del tramo: el búfer cambia de hilo sin copiarse otra vez.
        const datos = muestras.buffer.byteLength === muestras.byteLength ? muestras.buffer : muestras.slice().buffer;
        hilo.postMessage({ tipo: "muestras", peticion: m.peticion, datos }, [datos as ArrayBuffer]);
      })
      .catch((error: Error) => hilo.postMessage({ tipo: "muestras", peticion: m.peticion, datos: null, error: error.message }));
  } else if (m.tipo === "cerrar") {
    abiertos.delete(m.id);
  }
};
