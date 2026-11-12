import { describe, expect, it } from "vitest";
import type { Playlist, ResumenProyecto } from "../tipos";
import { desplazar, formatearPeso, ordenar } from "./biblioteca";

const p = (id: string, nombre: string, duracion: number, bpm: number, tonica: number | null, modo = "mayor", inicial?: number): ResumenProyecto => ({
  id, nombre, duracion, bpm, modificado: "", pistas: 6, peso: 0, archivos: 0, tieneVideo: false,
  tonalidad: tonica === null ? null : { tonica, modo, bemoles: false, nombre: "" },
  tonalidadInicial: inicial === undefined ? null : { tonica: inicial, modo: "mayor", bemoles: false, nombre: "" },
});
const proyectos = [
  p("a", "Zamba", 200, 120.5, 7),            // Sol mayor
  p("b", "ámbar", 90, 96, 0),                // Do mayor
  p("c", "Bolero", 300, 70, 9, "menor"),     // La menor (relativa de Do)
  p("d", "Popurrí", 150, 110, 4, "mayor", 2), // global Mi, pero arranca en Re
  p("e", "Sin análisis", 60, 100, null),
];
const lista = (orden: Playlist["orden"], ids = ["a", "b", "c", "d", "e"]): Playlist => ({ id: "x", nombre: "L", orden, proyectos: ids });
const ids = (orden: Playlist["orden"]) => ordenar(proyectos, lista(orden)).map((x) => x.id).join("");

describe("orden de playlists", () => {
  it("manual respeta el orden guardado e ignora proyectos que ya no existen", () => {
    expect(ordenar(proyectos, lista("manual", ["c", "zzz", "a"])).map((x) => x.id)).toEqual(["c", "a"]);
  });
  it("alfabético sin distinguir mayúsculas ni tildes", () => expect(ids("alfabetico")).toBe("bcdea"));
  it("por duración y por BPM", () => {
    expect(ids("duracion")).toBe("ebdac");
    expect(ids("bpm")).toBe("cbeda");
  });
  it("por tonalidad cromática usa la tonalidad inicial en los popurrís", () => {
    expect(ids("tonalidad")).toBe("bdace"); // Do, Re (popurrí), Sol, La menor, sin tonalidad
  });
  it("por círculo de quintas junta cada menor con su relativa mayor", () => {
    expect(ids("quintas")).toBe("bcade"); // Do, La menor, Sol, Re, sin tonalidad
  });
  it("sin playlist ordena todos los proyectos", () => {
    expect(ordenar(proyectos, null, "duracion")[0].id).toBe("e");
  });
});

describe("utilidades", () => {
  it("formatea tamaños", () => {
    expect(formatearPeso(900)).toBe("1 KB");
    expect(formatearPeso(57.3 * 1024 ** 2)).toBe("57.3 MB");
    expect(formatearPeso(2.5 * 1024 ** 3)).toBe("2.50 GB");
  });
  it("desplaza elementos sin salirse de la lista", () => {
    expect(desplazar(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(desplazar(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
});
