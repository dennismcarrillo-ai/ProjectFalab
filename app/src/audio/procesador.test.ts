/** Pruebas del procesador de audio ejecutándolo fuera del navegador con señales conocidas. */
import { beforeAll, describe, expect, it } from "vitest";
import { FRAMES_FRAGMENTO, MAX_PISTAS, type MensajeAlProcesador, type MensajeDelProcesador } from "./protocolo";

const FS = 44100;
let Procesador: new () => any;

beforeAll(async () => {
  const g = globalThis as any;
  g.sampleRate = FS;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (m: MensajeDelProcesador) => this.recibidos.push(m), onmessage: null as any };
    recibidos: MensajeDelProcesador[] = [];
  };
  g.registerProcessor = (_nombre: string, clase: any) => (Procesador = clase);
  await import("./procesador.worklet");
});

/** Fuente de prueba: seno de `hz` en el canal izquierdo y una rampa de frames en el derecho. */
function crear(hz: number, segundos: number, clips?: any[], pistas = 1) {
  const p = new Procesador();
  const enviar = (m: MensajeAlProcesador) => p.port.onmessage({ data: m });
  const frames = Math.round(segundos * FS);
  for (let i = 0; i * FRAMES_FRAGMENTO < frames; i++) {
    const n = Math.min(FRAMES_FRAGMENTO, frames - i * FRAMES_FRAGMENTO);
    const datos = new Int16Array(n * 2);
    for (let f = 0; f < n; f++) {
      const global = i * FRAMES_FRAGMENTO + f;
      datos[f * 2] = Math.round(Math.sin((2 * Math.PI * hz * global) / FS) * 16000);
      datos[f * 2 + 1] = global % 30000;
    }
    enviar({ tipo: "fragmento", fuenteId: "a", indice: i, datos });
  }
  const clipCompleto = { fuenteId: "a", inicio: 0, desplazamiento: 0, duracion: frames, ganancia: 1, fundidoEntrada: 0, fundidoSalida: 0 };
  enviar({
    tipo: "proyecto", fin: frames, fuentes: { a: frames },
    pistas: Array.from({ length: pistas }, () => ({ tono: 0, clips: clips ?? [clipCompleto] })),
  });
  /** Ejecuta `cuantos` bloques de 128 frames y devuelve [izquierda, derecha] de la salida pedida. */
  const correr = (cuantos: number, salida = 0) => {
    const izq = new Float32Array(cuantos * 128), der = new Float32Array(cuantos * 128);
    for (let c = 0; c < cuantos; c++) {
      const salidas = Array.from({ length: MAX_PISTAS + 1 }, () => [new Float32Array(128), new Float32Array(128)]);
      p.process([], salidas);
      izq.set(salidas[salida][0], c * 128);
      der.set(salidas[salida][1], c * 128);
    }
    return [izq, der];
  };
  const posicion = (): number => {
    const informes = (p.recibidos as MensajeDelProcesador[]).filter((m) => m.tipo === "posicion");
    return (informes[informes.length - 1] as Extract<MensajeDelProcesador, { tipo: "posicion" }>).posicion;
  };
  return { p, enviar, correr, posicion, frames };
}

/** Frecuencia dominante contando cruces por cero (suficiente para un seno). */
function frecuencia(onda: Float32Array): number {
  let cruces = 0;
  for (let i = 1; i < onda.length; i++) if (onda[i - 1] <= 0 && onda[i] > 0) cruces++;
  return (cruces * FS) / onda.length;
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const parametros = (extra: Partial<Extract<MensajeAlProcesador, { tipo: "parametros" }>> = {}): MensajeAlProcesador =>
  ({ tipo: "parametros", velocidad: 1, tono: 0, metronomo: false, bucle: null, ...extra });
const reproducir = (desde = 0, clics = 0): MensajeAlProcesador =>
  ({ tipo: "reproducir", desde, clicsDeCuenta: clics, intervaloDeCuenta: FS / 2, compas: 4 });

describe("procesador de audio", () => {
  it("a velocidad y tono originales reproduce las muestras exactas de la fuente", () => {
    const { enviar, correr, posicion } = crear(440, 4);
    enviar(reproducir(1000));
    const [, rampa] = correr(40);
    for (const f of [200, 2000, 5000]) expect(Math.round(rampa[f] * 32768)).toBe(1000 + f);
    expect(posicion()).toBe(1000 + 40 * 128);
  });

  it("detenido no suena nada y saltar mueve el cursor", () => {
    const { enviar, correr, posicion } = crear(440, 2);
    expect(rms(correr(10)[0])).toBe(0);
    enviar({ tipo: "saltar", posicion: 12345 });
    expect(posicion()).toBe(12345);
  });

  it("al 50 % de velocidad el tono no cambia y el cursor avanza a la mitad", () => {
    const { enviar, correr, posicion } = crear(440, 6);
    enviar(parametros({ velocidad: 0.5 }));
    enviar(reproducir());
    const [onda] = correr(700); // ~2 s de salida
    const estable = onda.subarray(20000);
    expect(rms(estable)).toBeGreaterThan(0.2);
    expect(Math.abs(frecuencia(estable) - 440)).toBeLessThan(6);
    // Los primeros bloques son de arranque del estirador; después avanza a 0,5× exactos.
    const antes = posicion();
    correr(100);
    expect(posicion() - antes).toBeCloseTo(100 * 128 * 0.5, 0);
  });

  it("subir 12 semitonos duplica la frecuencia sin cambiar la velocidad", () => {
    const { enviar, correr, posicion } = crear(220, 6);
    enviar(parametros({ tono: 12 }));
    enviar(reproducir());
    const [onda] = correr(600);
    expect(Math.abs(frecuencia(onda.subarray(20000)) - 440)).toBeLessThan(8);
    const antes = posicion();
    correr(100);
    expect(posicion() - antes).toBeCloseTo(100 * 128, 0);
  });

  it("monta clips recortados y pegados leyendo el tramo correcto de la fuente", () => {
    // Un clip que empieza en el frame 4410 de la línea de tiempo y lee la fuente desde el frame 20000.
    const clips = [{ fuenteId: "a", inicio: 4410, desplazamiento: 20000, duracion: 8820, ganancia: 0.5, fundidoEntrada: 0, fundidoSalida: 0 }];
    const { enviar, correr } = crear(440, 4, clips);
    enviar(reproducir());
    const [, rampa] = correr(120);
    expect(rampa[4000]).toBe(0);                                       // antes del clip: silencio
    expect(Math.round(rampa[4410 + 1000] * 32768 * 2)).toBe(21000);   // dentro: fuente[20000 + 1000] × 0,5
    expect(rampa[4410 + 8820 + 10]).toBe(0);                           // después: silencio
    expect(Math.abs(rampa[4410 + 2])).toBeLessThan(0.02);              // fundido anti-clic en el borde
  });

  it("repite el tramo en bucle", () => {
    const { enviar, correr, posicion } = crear(440, 4);
    enviar(parametros({ bucle: { inicio: 10000, fin: 20000 } }));
    enviar(reproducir(10000));
    const [, rampa] = correr(100); // 12800 frames: da una vuelta completa
    expect(Math.round(rampa[9999] * 32768)).toBe(19999);
    expect(Math.round(rampa[10000] * 32768)).toBe(10000);
    expect(posicion()).toBe(10000 + ((100 * 128) % 10000));
  });

  it("espera sin avanzar si falta un fragmento y lo pide", () => {
    const { p, enviar, correr, posicion } = crear(440, 8);
    enviar({ tipo: "descartar", fuenteId: "a", indices: [1] });
    enviar(reproducir(FRAMES_FRAGMENTO + 500));
    expect(rms(correr(5)[0])).toBe(0);
    expect(posicion()).toBe(FRAMES_FRAGMENTO + 500);
    expect(p.recibidos.some((m: MensajeDelProcesador) => m.tipo === "falta" && m.indice === 1)).toBe(true);
  });

  it("la cuenta regresiva da los clics antes de arrancar y el metrónomo sigue el mapa de pulsos", () => {
    const { enviar, correr, posicion } = crear(440, 6);
    enviar({ tipo: "pulsos", frames: new Float64Array([0, 11025, 30000]), fuertes: new Uint8Array([1, 0, 0]) });
    enviar(parametros({ metronomo: true }));
    enviar(reproducir(0, 2)); // 2 clics separados 0,5 s
    const cuanto = 128;
    const [pista] = correr(Math.floor(FS / cuanto) - 2);          // casi 1 s: aún en la cuenta
    expect(rms(pista)).toBe(0);
    expect(posicion()).toBe(0);
    const [clics] = correr(400, MAX_PISTAS);                       // salida del metrónomo
    const arranque = Math.ceil(FS / cuanto) * cuanto - (Math.floor(FS / cuanto) - 2) * cuanto;
    const pico = (centro: number) => Math.max(...clics.subarray(Math.max(0, centro), centro + 400).map(Math.abs));
    expect(pico(arranque)).toBeGreaterThan(0.3);                   // pulso en 0
    expect(pico(arranque + 11025)).toBeGreaterThan(0.3);           // pulso irregular en 11025
    expect(pico(arranque + 20000)).toBeLessThan(0.01);             // entre pulsos, silencio
    expect(pico(arranque + 30000)).toBeGreaterThan(0.3);           // pulso irregular en 30000
  });

  it("varias pistas salen sincronizadas también con el estirador activo", () => {
    const { enviar, correr } = crear(440, 6, undefined, 2);
    enviar(parametros({ velocidad: 0.8 }));
    enviar(reproducir());
    const a = correr(300, 0)[0];
    const { enviar: e2, correr: c2 } = crear(440, 6, undefined, 2);
    e2(parametros({ velocidad: 0.8 }));
    e2(reproducir());
    const b = c2(300, 1)[0];
    expect(rms(a)).toBeGreaterThan(0.1);
    expect(Array.from(a.subarray(30000, 30100))).toEqual(Array.from(b.subarray(30000, 30100)));
  });
});
