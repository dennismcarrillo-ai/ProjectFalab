/** Utilidades de formato de tiempo y niveles. */

/** 83.456 -> "1:23.456" */
export function formatearTiempo(segundos: number, decimales = 3): string {
  const s = Math.max(0, segundos);
  const minutos = Math.floor(s / 60);
  const resto = s - minutos * 60;
  const entero = Math.floor(resto).toString().padStart(2, "0");
  if (decimales === 0) return `${minutos}:${entero}`;
  const fraccion = (resto - Math.floor(resto)).toFixed(decimales).slice(2);
  return `${minutos}:${entero}.${fraccion}`;
}

/** Acepta "1:23.5", "83.5" o "1:02:03" y devuelve segundos (o null si no se entiende). */
export function leerTiempo(texto: string): number | null {
  const limpio = texto.trim().replace(",", ".");
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(limpio)) return null;
  return limpio.split(":").reduce((total, parte) => total * 60 + Number(parte), 0);
}

export function formatearDb(db: number): string {
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export function formatearSemitonos(n: number): string {
  return n === 0 ? "0" : `${n > 0 ? "+" : "−"}${Math.abs(n)}`;
}
