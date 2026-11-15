/**
 * Nombres de acordes y de notas según el cifrado y la transposición.
 *
 * Es la misma lógica que `acordes.py` del motor. El proyecto guarda los acordes como números
 * (fundamental, calidad, bajo) y el reproductor los escribe aquí, de modo que en el iPad se puede
 * cambiar de cifrado y de tono sin motor de análisis. Una prueba compara ambas implementaciones.
 */
import type { Acorde, Cifrado, LineaCancionero, Ostinato, Tonalidad, TramoDeBajo } from "../tipos";

const SOSTENIDOS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BEMOLES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LATINO: Record<string, string> = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };

/** calidad -> [sufijo estándar, sufijo jazz] */
const SUFIJOS: Record<string, [string, string]> = {
  maj: ["", ""], min: ["m", "-"], "7": ["7", "7"], maj7: ["maj7", "Δ7"], m7: ["m7", "-7"], "6": ["6", "6"],
  m6: ["m6", "-6"], dim: ["dim", "°"], dim7: ["dim7", "°7"], m7b5: ["m7b5", "ø7"], aug: ["aug", "+"],
  sus4: ["sus4", "sus4"], sus2: ["sus2", "sus2"], "9": ["9", "9"], maj9: ["maj9", "Δ9"], m9: ["m9", "-9"],
};

/** Tonalidades que se escriben con bemoles (el resto, con sostenidos). */
const CON_BEMOLES = new Set(["mayor:5", "mayor:10", "mayor:3", "mayor:8", "mayor:1",
  "menor:2", "menor:7", "menor:0", "menor:5", "menor:10", "menor:3"]);

const modulo = (n: number): number => ((n % 12) + 12) % 12;

export function nombreDeNota(clase: number, bemoles: boolean, cifrado: Cifrado): string {
  const nombre = (bemoles ? BEMOLES : SOSTENIDOS)[modulo(clase)];
  return cifrado === "latino" ? LATINO[nombre[0]] + nombre.slice(1) : nombre;
}

export function nombreDeAcorde(raiz: number, calidad: string, bajo: number | null, cifrado: Cifrado, bemoles: boolean): string {
  const [estandar, jazz] = SUFIJOS[calidad] ?? ["", ""];
  let texto = nombreDeNota(raiz, bemoles, cifrado) + (cifrado === "jazz" ? jazz : estandar);
  if (bajo !== null && bajo !== raiz) texto += "/" + nombreDeNota(bajo, bemoles, cifrado);
  return texto;
}

/** Lo que guarda el proyecto: acordes y bajo como números, y el cancionero referenciando acordes. */
export interface AnalisisSinNombres {
  tonalidad: { tonica: number; modo: string; bemoles: boolean };
  acordes: Omit<Acorde, "nombre">[];
  lineaBajo: Omit<TramoDeBajo, "nombre">[];
  ostinatos: Omit<Ostinato, "nombre">[];
  cancionero: (
    | { tipo: "instrumental"; inicio: number; fin: number; acordes: number[] }
    | { tipo: "letra"; inicio: number; fin: number; texto: string; acordes: { columna: number; t: number; acorde: number }[] }
  )[];
}

export function ponerNombres(datos: AnalisisSinNombres, cifrado: Cifrado, transponer: number): {
  tonalidad: Tonalidad; acordes: Acorde[]; lineaBajo: TramoDeBajo[]; ostinatos: Ostinato[]; cancionero: LineaCancionero[];
} {
  const tonica = modulo(datos.tonalidad.tonica + transponer);
  const bemoles = transponer ? CON_BEMOLES.has(`${datos.tonalidad.modo}:${tonica}`) : !!datos.tonalidad.bemoles;
  const nota = (clase: number) => nombreDeNota(clase + transponer, bemoles, cifrado);
  const acordes: Acorde[] = datos.acordes.map((a) => {
    const raiz = modulo(a.raiz + transponer);
    const bajo = a.bajo === null || a.bajo === undefined ? null : modulo(a.bajo + transponer);
    return { ...a, raiz, bajo, nombre: nombreDeAcorde(raiz, a.calidad, bajo, cifrado, bemoles) };
  });
  const cancionero: LineaCancionero[] = datos.cancionero.map((linea) =>
    linea.tipo === "instrumental"
      ? { tipo: "instrumental", inicio: linea.inicio, fin: linea.fin, acordes: [], texto: "| " + linea.acordes.map((i) => acordes[i].nombre).join(" | ") + " |" }
      : { ...linea, acordes: linea.acordes.map((m) => ({ columna: m.columna, t: m.t, nombre: acordes[m.acorde].nombre })) });
  return {
    tonalidad: { tonica, modo: datos.tonalidad.modo, bemoles, nombre: `${nombreDeNota(tonica, bemoles, cifrado)} ${datos.tonalidad.modo}` },
    acordes,
    lineaBajo: datos.lineaBajo.map((b) => ({ ...b, nota: modulo(b.nota + transponer), nombre: nota(b.nota) })),
    ostinatos: datos.ostinatos.map((o) => ({
      ...o,
      patron: o.patron.map((x) => (x >= 0 ? modulo(x + transponer) : -1)),
      nombre: o.patron.map((x) => (x >= 0 ? nota(x) : "·")).join(" "),
    })),
    cancionero,
  };
}
