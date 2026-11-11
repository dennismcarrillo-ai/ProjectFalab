import { describe, expect, it } from "vitest";
import type { Clip } from "../tipos";
import {
  colocar, copiarClips, copiarRango, dividir, eliminar, finDe, imantar, pegar, quitarRango,
  recortarFin, recortarInicio, vecinos,
} from "./operaciones";

const clip = (id: string, inicio: number, duracion: number, desplazamiento = 0): Clip => ({
  id, fuenteId: "voz", inicio, desplazamiento, duracion, ganancia: 0, fundidoEntrada: 0.5, fundidoSalida: 0.5,
});

/** Qué instante de la fuente suena en el instante `t` de la línea de tiempo (o null si hay silencio). */
const suena = (clips: Clip[], t: number): number | null => {
  const c = clips.find((x) => t >= x.inicio && t < finDe(x));
  return c ? c.desplazamiento + (t - c.inicio) : null;
};

describe("dividir", () => {
  it("parte el clip sin alterar lo que suena", () => {
    const partes = dividir([clip("a", 2, 10, 1)], 5);
    expect(partes).toHaveLength(2);
    expect(partes[0]).toMatchObject({ id: "a", inicio: 2, duracion: 3, desplazamiento: 1, fundidoSalida: 0 });
    expect(partes[1]).toMatchObject({ inicio: 5, duracion: 7, desplazamiento: 4, fundidoEntrada: 0, fundidoSalida: 0.5 });
    for (const t of [2, 4.99, 5, 11.9]) expect(suena(partes, t)).toBeCloseTo(suena([clip("a", 2, 10, 1)], t)!);
  });
  it("ignora cortes fuera del clip o en su borde", () => {
    expect(dividir([clip("a", 2, 10)], 2)).toHaveLength(1);
    expect(dividir([clip("a", 2, 10)], 20)).toHaveLength(1);
  });
});

describe("quitarRango", () => {
  it("abre un hueco en mitad de un clip", () => {
    const r = quitarRango([clip("a", 0, 10)], 3, 6);
    expect(r.map((c) => [c.inicio, c.duracion, c.desplazamiento])).toEqual([[0, 3, 0], [6, 4, 6]]);
    expect(new Set(r.map((c) => c.id)).size).toBe(2);
  });
  it("recorta por los lados y elimina lo cubierto", () => {
    const r = quitarRango([clip("a", 0, 4), clip("b", 4, 2), clip("c", 6, 4)], 3, 7);
    expect(r.map((c) => [c.id, c.inicio, c.duracion])).toEqual([["a", 0, 3], ["c", 7, 3]]);
    expect(r[1].desplazamiento).toBe(1);
  });
});

describe("recorte de bordes", () => {
  it("el borde izquierdo no puede leer antes del inicio de la fuente", () => {
    const c = clip("a", 5, 4, 2);
    expect(recortarInicio(c, 6)).toMatchObject({ inicio: 6, desplazamiento: 3, duracion: 3 });
    expect(recortarInicio(c, 0)).toMatchObject({ inicio: 3, desplazamiento: 0, duracion: 6 });
    expect(recortarInicio(c, 100).duracion).toBeCloseTo(0.02);
    expect(recortarInicio(c, 0, 4)).toMatchObject({ inicio: 4, desplazamiento: 1 });
  });
  it("el borde derecho no puede pasar del final de la fuente ni del clip siguiente", () => {
    const c = clip("a", 5, 4, 2);
    expect(recortarFin(c, 7, 20).duracion).toBe(2);
    expect(recortarFin(c, 100, 20).duracion).toBe(18);
    expect(recortarFin(c, 100, 20, 12).duracion).toBe(7);
    expect(recortarFin(c, 0, 20).duracion).toBeCloseTo(0.02);
  });
  it("calcula los topes con los clips vecinos", () => {
    expect(vecinos([clip("a", 0, 2), clip("b", 3, 2), clip("c", 8, 1)], "b")).toEqual({ anterior: 2, siguiente: 8 });
  });
});

describe("copiar y pegar", () => {
  it("copiar un rango y pegarlo reproduce el mismo audio en otro sitio", () => {
    const pista = [clip("a", 0, 10)];
    const copia = copiarRango(pista, 2, 5);
    expect(copia.duracion).toBe(3);
    const { clips, nuevos } = pegar(pista, copia, 20);
    expect(nuevos).toHaveLength(1);
    expect(suena(clips, 20)).toBeCloseTo(2);
    expect(suena(clips, 22.9)).toBeCloseTo(4.9);
    expect(suena(clips, 23.1)).toBeNull();
    expect(suena(clips, 4)).toBeCloseTo(4); // el original sigue intacto
  });
  it("pegar encima sobrescribe lo que había debajo", () => {
    const pista = [clip("a", 0, 10)];
    const { clips } = pegar(pista, copiarRango(pista, 0, 2), 4);
    expect(clips.map((c) => [c.inicio, c.duracion])).toEqual([[0, 4], [4, 2], [6, 4]]);
    expect(suena(clips, 5)).toBeCloseTo(1);
    expect(suena(clips, 7)).toBeCloseTo(7);
  });
  it("un rango que abarca varios clips conserva los huecos", () => {
    const pista = [clip("a", 0, 2), clip("b", 4, 2, 10)];
    const copia = copiarRango(pista, 1, 5);
    expect(copia.fragmentos.map((f) => [f.relativo, f.duracion, f.desplazamiento])).toEqual([[0, 1, 1], [3, 1, 10]]);
    expect(copiarRango(pista, 2.5, 4.5).fragmentos[0].relativo).toBeCloseTo(1.5);
  });
  it("copiar clips enteros mantiene su separación", () => {
    const copia = copiarClips([clip("a", 1, 2), clip("b", 5, 1)], ["a", "b"]);
    expect(copia.duracion).toBe(5);
    expect(copia.fragmentos.map((f) => f.relativo)).toEqual([0, 4]);
  });
  it("copiar no duplica audio: el portapapeles solo contiene referencias", () => {
    expect(JSON.stringify(copiarRango([clip("a", 0, 600)], 0, 600)).length).toBeLessThan(300);
  });
});

describe("otras operaciones", () => {
  it("colocar un clip movido lo quita de su posición anterior", () => {
    const movido = { ...clip("a", 0, 2), inicio: 5 };
    expect(colocar([clip("a", 0, 2), clip("b", 4, 4)], [movido]).map((c) => [c.id, c.inicio, c.duracion]))
      .toEqual([["b", 4, 1], ["a", 5, 2], [expect.any(String), 7, 1]]);
  });
  it("eliminar e imantar", () => {
    expect(eliminar([clip("a", 0, 1), clip("b", 1, 1)], ["a"]).map((c) => c.id)).toEqual(["b"]);
    expect(imantar(1.04, [0, 1, 2], 0.05)).toBe(1);
    expect(imantar(1.2, [0, 1, 2], 0.05)).toBe(1.2);
  });
});
