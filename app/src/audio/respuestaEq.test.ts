import { describe, expect, it } from "vitest";
import { respuestaEq } from "./respuestaEq";

const plano = {
  bajos: { frecuencia: 120, ganancia: 0 },
  medios: { frecuencia: 1000, ganancia: 0, q: 1 },
  agudos: { frecuencia: 8000, ganancia: 0 },
};

describe("respuestaEq", () => {
  it("un EQ plano no altera ninguna frecuencia", () => {
    for (const db of respuestaEq(plano, [30, 200, 1000, 5000, 18000])) expect(Math.abs(db)).toBeLessThan(1e-9);
  });
  it("cada banda actúa en su zona", () => {
    const eq = { ...plano, bajos: { frecuencia: 120, ganancia: 9 }, medios: { frecuencia: 1000, ganancia: -6, q: 2 },
      agudos: { frecuencia: 8000, ganancia: 4 } };
    const [graves, medios, agudos, entre] = respuestaEq(eq, [25, 1000, 19000, 3500]);
    expect(graves).toBeCloseTo(9, 0);
    expect(medios).toBeCloseTo(-6, 0);
    expect(agudos).toBeCloseTo(4, 0);
    expect(Math.abs(entre)).toBeLessThan(1.5);
  });
});
