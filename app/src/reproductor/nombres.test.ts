import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Cifrado } from "../tipos";
import { ponerNombres } from "./nombres";

/** Casos generados por el motor Python: el reproductor debe escribir exactamente lo mismo. */
const { entrada, casos } = JSON.parse(readFileSync(new URL("./muestras/nombres.json", import.meta.url), "utf8"));

describe("nombres de acordes en el reproductor", () => {
  for (const caso of casos) {
    it(`coincide con el motor: cifrado ${caso.cifrado}, transposición ${caso.transponer}`, () => {
      const r = ponerNombres(entrada, caso.cifrado as Cifrado, caso.transponer);
      expect(r.tonalidad).toEqual(caso.tonalidad);
      expect(r.acordes.map((a) => a.nombre)).toEqual(caso.acordes.map((a: any) => a.nombre));
      expect(r.acordes.map((a) => [a.raiz, a.bajo])).toEqual(caso.acordes.map((a: any) => [a.raiz, a.bajo]));
      expect(r.lineaBajo).toEqual(caso.lineaBajo);
      expect(r.ostinatos).toEqual(caso.ostinatos);
      expect(r.cancionero).toEqual(caso.cancionero);
    });
  }
});
