/** Picos de onda precalculados por el motor: dibujar ondas no requiere decodificar audio. */
import { useEffect, useState } from "react";
import { motor } from "../servicios/motor";

export const FRAMES_POR_PICO = 256;
const cache = new Map<string, Int8Array>();
const pendientes = new Map<string, Promise<Int8Array>>();

export function usarPicos(idProyecto: string, idFuente: string | null): Int8Array | null {
  const clave = `${idProyecto}:${idFuente}`;
  const [picos, fijar] = useState<Int8Array | null>(cache.get(clave) ?? null);
  useEffect(() => {
    let vigente = true;
    if (idFuente === null) {  // pista vacía: no hay onda que pedir
      fijar(null);
      return;
    }
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

/** Picos de varias fuentes a la vez (una pista con varias tomas grabadas usa una fuente por toma). */
export function usarPicosDe(idProyecto: string, idsFuente: string[]): Map<string, Int8Array> {
  const firma = idsFuente.join("|");
  const [, refrescar] = useState(0);
  useEffect(() => {
    let vigente = true;
    for (const idFuente of firma ? firma.split("|") : []) {
      const clave = `${idProyecto}:${idFuente}`;
      if (cache.has(clave)) continue;
      let promesa = pendientes.get(clave);
      if (!promesa) {
        promesa = motor.picos(idProyecto, idFuente);
        pendientes.set(clave, promesa);
      }
      promesa
        .then((datos) => {
          cache.set(clave, datos);
          if (vigente) refrescar((n) => n + 1);
        })
        .catch(() => undefined)
        .finally(() => pendientes.delete(clave));
    }
    return () => {
      vigente = false;
    };
  }, [idProyecto, firma]);
  const resultado = new Map<string, Int8Array>();
  for (const idFuente of idsFuente) {
    const datos = cache.get(`${idProyecto}:${idFuente}`);
    if (datos) resultado.set(idFuente, datos);
  }
  return resultado;
}

export function olvidarPicos(): void {
  cache.clear();
}
