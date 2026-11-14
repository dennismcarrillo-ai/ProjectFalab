/** Pruebas del procesador de audio ejecutándolo fuera del navegador con señales conocidas. */
import { beforeAll, describe, expect, it } from "vitest";
import { FRAMES_FRAGMENTO, MAX_PISTAS, type MensajeAlProcesador, type MensajeDelProcesador } from "./protocolo";

const FS = 44100;
let Procesador: new () => any;
let Grabador: new () => any;

beforeAll(async () => {
  const g = globalThis as any;
  g.sampleRate = FS;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (m: MensajeDelProcesador) => this.recibidos.push(m), onmessage: null as any };
    recibidos: MensajeDelProcesador[] = [];
  };
  g.currentFrame = 0;
  g.registerProcessor = (nombre: string, clase: any) => {
    if (nombre === "falab-procesador") Procesador = clase;
    else Grabador = clase;
  };
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

  it("show continuo: empalma con la canción siguiente en la muestra exacta y avisa del cambio", () => {
    const { p, enviar, posicion } = crear(440, 1); // canción actual: 44100 frames
    // Fuente de la canción siguiente: la rampa vale 20000 + frame, para distinguirla.
    const framesB = FS * 2;
    const datos = new Int16Array(framesB * 2);
    for (let f = 0; f < framesB; f++) datos[f * 2 + 1] = 20000 + (f % 10000);
    enviar({ tipo: "fragmento", fuenteId: "b", indice: 0, datos });
    const clipB = { fuenteId: "b", inicio: 0, desplazamiento: 0, duracion: framesB, ganancia: 1, fundidoEntrada: 0, fundidoSalida: 0 };
    enviar({ tipo: "encolar", montaje: {
      pistas: [{ tono: 0, clips: [clipB] }, { tono: 0, clips: [clipB] }], fin: framesB, fuentes: { b: framesB },
      velocidad: 1, tono: 0, pulsos: new Float64Array([4410]), fuertes: new Uint8Array([1]) } });
    enviar(parametros({ metronomo: true }));
    enviar(reproducir(40000));
    const bloques = 60; // 7680 frames: cruza el final (frame 44100) en el frame 4100 de la salida
    const salidas = Array.from({ length: bloques }, () => Array.from({ length: MAX_PISTAS + 1 }, () => [new Float32Array(128), new Float32Array(128)]));
    for (const s of salidas) p.process([], s);
    const unir = (pista: number) => { const t = new Float32Array(bloques * 128); salidas.forEach((s, i) => t.set(s[pista][1], i * 128)); return t; };
    const rampa = unir(0), segunda = unir(1), clics = unir(MAX_PISTAS);
    const valor = (x: number) => Math.round(x * 32768);
    expect(valor(rampa[3900])).toBe(43900 % 30000);            // todavía la canción actual
    expect(valor(rampa[4100 + 300])).toBe(20300);                // ya la siguiente, sin hueco ni desfase
    expect(valor(rampa[4100 + 5])).toBeGreaterThan(0);           // (fundido anti-clic de 3 ms al entrar)
    expect(valor(segunda[4100 + 300])).toBe(20300);              // la pista nueva arranca alineada
    expect(Math.abs(valor(segunda[4000]))).toBe(0);
    expect(p.recibidos.filter((m: MensajeDelProcesador) => m.tipo === "cambio")).toHaveLength(1);
    expect(p.recibidos.some((m: MensajeDelProcesador) => m.tipo === "fin")).toBe(false);
    expect(posicion()).toBeLessThan(4000);                       // el cursor ya cuenta en la canción nueva…
    expect(p.posicion).toBe(40000 + bloques * 128 - FS);         // …y en la muestra exacta
    // El metrónomo ya sigue los pulsos de la canción nueva (su pulso en 4410 -> salida 8510: fuera) …
    expect(Math.max(...clics.subarray(4100, 7680).map(Math.abs))).toBe(0);
    const mas = Array.from({ length: MAX_PISTAS + 1 }, () => [new Float32Array(128), new Float32Array(128)]);
    for (let i = 0; i < 8; i++) p.process([], mas);
    expect(Math.max(...mas[MAX_PISTAS][0].map(Math.abs))).toBeGreaterThan(0.2); // … y suena al llegar a él
  });

  it("show continuo: también cambia de canción con el estirador activo", () => {
    const { p, enviar, correr } = crear(440, 1);
    const framesB = FS * 3;
    const datos = new Int16Array(framesB * 2);
    for (let f = 0; f < framesB; f++) datos[f * 2] = Math.round(Math.sin((2 * Math.PI * 880 * f) / FS) * 16000);
    enviar({ tipo: "fragmento", fuenteId: "b", indice: 0, datos });
    enviar({ tipo: "fragmento", fuenteId: "b", indice: 1, datos: new Int16Array(2) });
    enviar({ tipo: "encolar", montaje: {
      pistas: [{ tono: 0, clips: [{ fuenteId: "b", inicio: 0, desplazamiento: 0, duracion: FRAMES_FRAGMENTO, ganancia: 1, fundidoEntrada: 0, fundidoSalida: 0 }] }],
      fin: FRAMES_FRAGMENTO, fuentes: { b: framesB }, velocidad: 0.5, tono: 0, pulsos: new Float64Array(0), fuertes: new Uint8Array(0) } });
    enviar(parametros({ velocidad: 0.8 }));
    enviar(reproducir(20000));
    const [onda] = correr(700);
    expect(p.recibidos.filter((m: MensajeDelProcesador) => m.tipo === "cambio")).toHaveLength(1);
    expect(Math.abs(frecuencia(onda.subarray(60000)) - 880)).toBeLessThan(12);   // suena la canción nueva, afinada
    const informes = (p.recibidos as MensajeDelProcesador[]).filter((m) => m.tipo === "posicion") as any[];
    const antes = informes[informes.length - 1].posicion;
    correr(100);
    const despues = (p.recibidos as any[]).filter((m) => m.tipo === "posicion").pop().posicion;
    expect(despues - antes).toBeCloseTo(100 * 128 * 0.5, 0);                       // a la velocidad de la nueva
  });

  it("avisa del arranque con el reloj de muestras, después de la cuenta regresiva", () => {
    const { p, enviar, correr } = crear(440, 4);
    (globalThis as any).currentFrame = 5000;
    enviar(reproducir(1000, 1)); // un clic de cuenta de 0,5 s
    correr(100);
    expect(p.recibidos.some((m: MensajeDelProcesador) => m.tipo === "arranque")).toBe(false);
    (globalThis as any).currentFrame = 90000;
    correr(100);
    const arranques = p.recibidos.filter((m: MensajeDelProcesador) => m.tipo === "arranque");
    expect(arranques).toEqual([{ tipo: "arranque", cuadro: 90000, posicion: 1000 }]);
    (globalThis as any).currentFrame = 0;
  });

  it("el capturador entrega el micrófono en trozos de PCM de 16 bits con su reloj", () => {
    const g = new Grabador();
    const trozos: { cuadro: number; datos: Int16Array }[] = [];
    g.port.postMessage = (m: any) => trozos.push(m);
    (globalThis as any).currentFrame = 7000;
    const izquierda = new Float32Array(128).fill(0.5), derecha = new Float32Array(128).fill(-0.25);
    for (let i = 0; i < 400; i++) {            // 51200 frames: más de un trozo de ~1 s
      expect(g.process([[izquierda, derecha]])).toBe(true);
      (globalThis as any).currentFrame += 128;
    }
    expect(trozos).toHaveLength(1);
    expect(trozos[0].cuadro).toBe(7000);
    expect(trozos[0].datos.length % 2).toBe(0);
    expect([trozos[0].datos[0], trozos[0].datos[1]]).toEqual([16384, -8192]);
    // Micrófono mono: el mismo audio en los dos canales. Al parar se entrega lo pendiente.
    g.process([[izquierda]]);
    g.port.onmessage({ data: { tipo: "parar" } });
    expect(trozos).toHaveLength(2);
    const ultimo = trozos[1].datos;
    expect([ultimo[ultimo.length - 2], ultimo[ultimo.length - 1]]).toEqual([16384, 16384]);
    expect(trozos[1].cuadro).toBe(7000 + (trozos[0].datos.length / 2));
    expect(g.process([[izquierda]])).toBe(false);   // tras parar, el procesador se libera
    (globalThis as any).currentFrame = 0;
  });
});
