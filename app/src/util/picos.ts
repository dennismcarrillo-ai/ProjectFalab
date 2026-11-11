/** Picos de onda precalculados por el motor: dibujar ondas no requiere decodificar audio. */
import { useEffect, useState } from "react";
import { motor } from "../servicios/motor";

export const FRAMES_POR_PICO = 256;
const cache = new Map<string, Int8Array>();
const pendientes = new Map<string, Promise<Int8Array>>();

export function usarPicos(idProyecto: string, idFuente: string): Int8Array | null {
  const clave = `${idProyecto}:${idFuente}`;
  const [picos, fijar] = useState<Int8Array | null>(cache.get(clave) ?? null);
  useEffect(() => {
    let vigente = true;
    const enCache = cache.get(clave);
    if (enCache) {
      fijar(enCache);
      return;
    }
    let promesa = pendientes.get(clave);
    if (!promesa) {
      promesa = motor.picos(idProyecto, idFuente);
      pendientes.set(clave, promesa);
    }
    promesa
      .then((datos) => {
        cache.set(clave, datos);
        if (vigente) fijar(datos);
      })
      .catch(() => undefined)
      .finally(() => pendientes.delete(clave));
    return () => {
      vigente = false;
    };
  }, [clave, idProyecto, idFuente]);
  return picos;
}

export function olvidarPicos(): void {
  cache.clear();
}
