/**
 * Fachada del decodificador de FLAC: lo ejecuta en un hilo aparte cuando el navegador lo permite
 * y, si no, en el hilo principal (navegadores antiguos y pruebas).
 */
import { DecodificadorFlac } from "./flac";
import type { Lector } from "./lector";

export interface FuenteDeAudio {
  /** Muestras PCM de 16 bits intercaladas (estéreo) a partir del frame `inicio`. */
  leer(inicio: number, cuantos: number): Promise<Int16Array>;
}

type Salida =
  | { tipo: "pedirBytes"; id: number; peticion: number; desde: number; cuantos: number }
  | { tipo: "muestras"; peticion: number; datos: ArrayBuffer | null; error?: string };

let hilo: Worker | null | undefined;   // undefined = aún no se ha intentado; null = no disponible
let siguienteId = 1;
const lectores = new Map<number, Lector>();
const esperas = new Map<number, { resolver(muestras: Int16Array): void; rechazar(error: Error): void }>();

function obtenerHilo(): Worker | null {
  if (hilo !== undefined) return hilo;
  try {
    hilo = new Worker(new URL("./decodificador.worker.ts", import.meta.url), { type: "module" });
    hilo.onmessage = (evento: MessageEvent<Salida>) => {
      const m = evento.data;
      if (m.tipo === "pedirBytes") {
        const lector = lectores.get(m.id);
        const responder = (datos: ArrayBuffer | null, error?: string) =>
          hilo?.postMessage({ tipo: "bytes", peticion: m.peticion, datos, error }, datos ? [datos] : []);
        if (!lector) return responder(null, "Audio cerrado.");
        lector.leer(m.desde, m.cuantos).then(
          // Copia propia: el búfer se transfiere y el lector puede estar reutilizando el suyo.
          (bytes) => responder(bytes.slice().buffer as ArrayBuffer),
          (error: Error) => responder(null, error.message),
        );
      } else {
        const espera = esperas.get(m.peticion);
        esperas.delete(m.peticion);
        if (m.datos) espera?.resolver(new Int16Array(m.datos));
        else espera?.rechazar(new Error(m.error ?? "No se pudo decodificar el audio."));
      }
    };
    // Si el hilo no llega a arrancar (navegador sin módulos en hilos), se vuelve al modo directo.
    hilo.onerror = () => {
      hilo = null;
      for (const espera of esperas.values()) espera.rechazar(new Error("El decodificador en segundo plano no está disponible."));
      esperas.clear();
    };
  } catch {
    hilo = null;
  }
  return hilo;
}

/** Abre un FLAC para leerlo por tramos sin bloquear la interfaz. */
export async function abrirAudio(lector: Lector): Promise<FuenteDeAudio> {
  let directo: Promise<DecodificadorFlac> | null = null;
  const enDirecto = (inicio: number, cuantos: number) => (directo ??= DecodificadorFlac.abrir(lector)).then((d) => d.leer(inicio, cuantos));
  if (typeof Worker === "undefined" || !obtenerHilo()) return { leer: enDirecto };

  const id = siguienteId++;
  lectores.set(id, lector);
  hilo!.postMessage({ tipo: "abrir", id, tamano: lector.tamano });
  return {
    leer(inicio, cuantos) {
      const activo = hilo;
      if (!activo) return enDirecto(inicio, cuantos);
      return new Promise<Int16Array>((resolver, rechazar) => {
        const peticion = siguienteId++;
        esperas.set(peticion, { resolver, rechazar });
        activo.postMessage({ tipo: "leer", id, peticion, inicio, cuantos });
      }).catch((error) => {
        if (hilo === null) return enDirecto(inicio, cuantos); // el hilo falló: se reintenta aquí mismo
        throw error;
      });
    },
  };
}
