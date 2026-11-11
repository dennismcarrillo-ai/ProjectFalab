/**
 * Respuesta en frecuencia del ecualizador de 3 bandas, para dibujar su curva.
 * Usa los mismos coeficientes bicuadráticos que los BiquadFilterNode de Web Audio (y que el
 * render de exportación en Python), así que la curva dibujada es la que realmente se oye.
 */
import type { Ecualizador } from "../tipos";
import { FRECUENCIA } from "./protocolo";

type Coeficientes = [number, number, number, number, number, number]; // b0 b1 b2 a0 a1 a2

function estante(frecuencia: number, db: number, agudo: boolean): Coeficientes {
  const A = Math.pow(10, db / 40);
  const w0 = (2 * Math.PI * frecuencia) / FRECUENCIA;
  const cos = Math.cos(w0);
  const raiz = 2 * ((Math.sin(w0) / 2) * Math.SQRT2) * Math.sqrt(A);
  const s = agudo ? -1 : 1;
  return [
    A * (A + 1 - s * (A - 1) * cos + raiz),
    s * 2 * A * (A - 1 - s * (A + 1) * cos),
    A * (A + 1 - s * (A - 1) * cos - raiz),
    A + 1 + s * (A - 1) * cos + raiz,
    -s * 2 * (A - 1 + s * (A + 1) * cos),
    A + 1 + s * (A - 1) * cos - raiz,
  ];
}

function campana(frecuencia: number, db: number, q: number): Coeficientes {
  const A = Math.pow(10, db / 40);
  const w0 = (2 * Math.PI * frecuencia) / FRECUENCIA;
  const alfa = Math.sin(w0) / (2 * Math.max(q, 0.001));
  return [1 + alfa * A, -2 * Math.cos(w0), 1 - alfa * A, 1 + alfa / A, -2 * Math.cos(w0), 1 - alfa / A];
}

function magnitudDb([b0, b1, b2, a0, a1, a2]: Coeficientes, frecuencia: number): number {
  const w = (2 * Math.PI * frecuencia) / FRECUENCIA;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const num = Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2);
  const den = Math.hypot(a0 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
  return 20 * Math.log10(num / den);
}

/** Ganancia total en dB del EQ en cada una de las frecuencias dadas. */
export function respuestaEq(eq: Ecualizador, frecuencias: number[]): number[] {
  const filtros = [
    estante(eq.bajos.frecuencia, eq.bajos.ganancia, false),
    campana(eq.medios.frecuencia, eq.medios.ganancia, eq.medios.q ?? 1),
    estante(eq.agudos.frecuencia, eq.agudos.ganancia, true),
  ];
  return frecuencias.map((f) => filtros.reduce((suma, filtro) => suma + magnitudDb(filtro, f), 0));
}
