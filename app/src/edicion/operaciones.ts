/**
 * Edición no lineal y NO DESTRUCTIVA.
 *
 * Un clip es solo una referencia {fuente, desplazamiento, duración}. Cortar, copiar, pegar o
 * recortar crea o modifica referencias de unos pocos bytes: el audio en disco no se toca y no se
 * duplica ninguna muestra en memoria. Por eso deshacer/rehacer puede guardar instantáneas
 * completas de la edición sin coste apreciable de RAM.
 *
 * Todas las funciones son puras: reciben la lista de clips de una pista y devuelven otra nueva.
 */
import type { Clip, Portapapeles } from "../tipos";

export const DURACION_MINIMA = 0.02;

export const finDe = (clip: Clip): number => clip.inicio + clip.duracion;

export function nuevoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const ordenar = (clips: Clip[]): Clip[] => [...clips].sort((a, b) => a.inicio - b.inicio);

/** Parte en dos todo clip que contenga el instante `t`. */
export function dividir(clips: Clip[], t: number): Clip[] {
  const resultado: Clip[] = [];
  for (const clip of clips) {
    if (t - clip.inicio < DURACION_MINIMA || finDe(clip) - t < DURACION_MINIMA) {
      resultado.push(clip);
      continue;
    }
    const corte = t - clip.inicio;
    resultado.push(
      { ...clip, duracion: corte, fundidoSalida: 0 },
      {
        ...clip,
        id: nuevoId(),
        inicio: t,
        desplazamiento: clip.desplazamiento + corte,
        duracion: clip.duracion - corte,
        fundidoEntrada: 0,
      },
    );
  }
  return resultado;
}

/** Vacía el intervalo [desde, hasta): recorta o parte los clips que lo pisan. */
export function quitarRango(clips: Clip[], desde: number, hasta: number): Clip[] {
  const resultado: Clip[] = [];
  for (const clip of clips) {
    const fin = finDe(clip);
    if (fin <= desde || clip.inicio >= hasta) {
      resultado.push(clip);
      continue;
    }
    if (clip.inicio < desde && desde - clip.inicio >= DURACION_MINIMA) {
      resultado.push({ ...clip, duracion: desde - clip.inicio, fundidoSalida: 0 });
    }
    if (fin > hasta && fin - hasta >= DURACION_MINIMA) {
      resultado.push({
        ...clip,
        id: clip.inicio < desde ? nuevoId() : clip.id,
        inicio: hasta,
        desplazamiento: clip.desplazamiento + (hasta - clip.inicio),
        duracion: fin - hasta,
        fundidoEntrada: 0,
      });
    }
  }
  return resultado;
}

/** Inserta clips sobrescribiendo lo que hubiera debajo (como pegar sobre una cinta). */
export function colocar(clips: Clip[], nuevos: Clip[]): Clip[] {
  let resultado = clips.filter((c) => !nuevos.some((n) => n.id === c.id));
  for (const nuevo of nuevos) {
    resultado = quitarRango(resultado, nuevo.inicio, finDe(nuevo));
  }
  return ordenar([...resultado, ...nuevos]);
}

/** Mueve el borde izquierdo del clip a `nuevoInicio` (recorte o ampliación hacia la izquierda). */
export function recortarInicio(clip: Clip, nuevoInicio: number, limiteIzquierdo = 0): Clip {
  const fin = finDe(clip);
  // No se puede leer antes del principio de la fuente ni invadir el clip anterior.
  const minimo = Math.max(limiteIzquierdo, clip.inicio - clip.desplazamiento, 0);
  const inicio = Math.min(Math.max(nuevoInicio, minimo), fin - DURACION_MINIMA);
  const delta = inicio - clip.inicio;
  return { ...clip, inicio, desplazamiento: clip.desplazamiento + delta, duracion: fin - inicio };
}

/** Mueve el borde derecho del clip a `nuevoFin` (recorte o ampliación hacia la derecha). */
export function recortarFin(clip: Clip, nuevoFin: number, duracionFuente: number, limiteDerecho = Infinity): Clip {
  const maximo = Math.min(limiteDerecho, clip.inicio + (duracionFuente - clip.desplazamiento));
  const fin = Math.max(Math.min(nuevoFin, maximo), clip.inicio + DURACION_MINIMA);
  return { ...clip, duracion: fin - clip.inicio };
}

export function mover(clip: Clip, nuevoInicio: number): Clip {
  return { ...clip, inicio: Math.max(0, nuevoInicio) };
}

/** Fin del clip anterior e inicio del siguiente: los topes al arrastrar un borde. */
export function vecinos(clips: Clip[], id: string): { anterior: number; siguiente: number } {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return { anterior: 0, siguiente: Infinity };
  let anterior = 0;
  let siguiente = Infinity;
  for (const otro of clips) {
    if (otro.id === id) continue;
    if (finDe(otro) <= clip.inicio + 1e-6) anterior = Math.max(anterior, finDe(otro));
    if (otro.inicio >= finDe(clip) - 1e-6) siguiente = Math.min(siguiente, otro.inicio);
  }
  return { anterior, siguiente };
}

function aPortapapeles(clips: Clip[]): Portapapeles {
  if (clips.length === 0) return { duracion: 0, fragmentos: [] };
  const origen = Math.min(...clips.map((c) => c.inicio));
  const fin = Math.max(...clips.map(finDe));
  return {
    duracion: fin - origen,
    fragmentos: ordenar(clips).map(({ id: _id, inicio, ...resto }) => ({ ...resto, relativo: inicio - origen })),
  };
}

/** Copia clips enteros. */
export function copiarClips(clips: Clip[], ids: string[]): Portapapeles {
  return aPortapapeles(clips.filter((c) => ids.includes(c.id)));
}

/** Copia el tramo [desde, hasta) de la pista, aunque corte clips por la mitad. */
export function copiarRango(clips: Clip[], desde: number, hasta: number): Portapapeles {
  // Lo que queda al quitar todo lo de fuera del rango es justo lo de dentro.
  const dentro = quitarRango(quitarRango(clips, -Infinity, desde), hasta, Infinity);
  const copia = aPortapapeles(dentro);
  if (copia.fragmentos.length === 0) return copia;
  // El portapapeles conserva los silencios del principio y del final de la selección.
  const origen = Math.min(...dentro.map((c) => c.inicio));
  return {
    duracion: hasta - desde,
    fragmentos: copia.fragmentos.map((f) => ({ ...f, relativo: f.relativo + (origen - desde) })),
  };
}

/** Pega el portapapeles en el instante `t`. Devuelve los clips y los ids de los recién creados. */
export function pegar(clips: Clip[], portapapeles: Portapapeles, t: number): { clips: Clip[]; nuevos: string[] } {
  const creados: Clip[] = portapapeles.fragmentos.map(({ relativo, ...resto }) => ({
    ...resto,
    id: nuevoId(),
    inicio: t + relativo,
  }));
  return { clips: colocar(clips, creados), nuevos: creados.map((c) => c.id) };
}

export function eliminar(clips: Clip[], ids: string[]): Clip[] {
  return clips.filter((c) => !ids.includes(c.id));
}

/** Ajusta `t` al punto de imán más cercano si está a menos de `tolerancia` segundos. */
export function imantar(t: number, puntos: number[], tolerancia: number): number {
  let mejor = t;
  let distancia = tolerancia;
  for (const punto of puntos) {
    const d = Math.abs(punto - t);
    if (d < distancia) {
      distancia = d;
      mejor = punto;
    }
  }
  return mejor;
}
