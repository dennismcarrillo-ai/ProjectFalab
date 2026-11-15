import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DecodificadorFlac } from "./flac";
import { LectorDeBytes } from "./lector";
import { Paquete } from "./zip";

const muestra = (nombre: string) => new Uint8Array(readFileSync(new URL(`./muestras/${nombre}`, import.meta.url)));
const pcm = (nombre: string) => {
  const b = readFileSync(new URL(`./muestras/${nombre}`, import.meta.url));
  return new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
};

/** ZIP sin compresión, como los .falab que escribe el escritorio. */
function zip(archivos: Record<string, Uint8Array>): Uint8Array {
  const partes: Uint8Array[] = [];
  const indice: Uint8Array[] = [];
  let posicion = 0;
  const codificar = new TextEncoder();
  for (const [nombre, datos] of Object.entries(archivos)) {
    const n = codificar.encode(nombre);
    const local = new Uint8Array(30 + n.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint32(18, datos.length, true); v.setUint32(22, datos.length, true);
    v.setUint16(26, n.length, true); local.set(n, 30);
    const central = new Uint8Array(46 + n.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint32(20, datos.length, true); c.setUint32(24, datos.length, true);
    c.setUint16(28, n.length, true); c.setUint32(42, posicion, true); central.set(n, 46);
    partes.push(local, datos); indice.push(central);
    posicion += local.length + datos.length;
  }
  const tamanoIndice = indice.reduce((s, x) => s + x.length, 0);
  const fin = new Uint8Array(22);
  const f = new DataView(fin.buffer);
  f.setUint32(0, 0x06054b50, true); f.setUint16(8, indice.length, true); f.setUint16(10, indice.length, true);
  f.setUint32(12, tamanoIndice, true); f.setUint32(16, posicion, true);
  const todo = new Uint8Array(posicion + tamanoIndice + 22);
  let o = 0;
  for (const p of [...partes, ...indice, fin]) { todo.set(p, o); o += p.length; }
  return todo;
}

describe("decodificador FLAC", () => {
  it("decodifica estéreo de 24 bits idéntico a la referencia (16 bits entrelazado)", async () => {
    const d = await DecodificadorFlac.abrir(new LectorDeBytes(muestra("estereo24.flac")));
    const esperado = pcm("estereo24.pcm");
    expect(d.info).toEqual({ frecuencia: 44100, canales: 2, bits: 24, frames: esperado.length / 2 });
    const todo = await d.leer(0, d.info.frames);
    expect(todo.length).toBe(esperado.length);
    let distintas = 0;
    for (let i = 0; i < esperado.length; i++) if (todo[i] !== esperado[i]) distintas++;
    expect(distintas).toBe(0);
  });

  it("lee tramos sueltos, saltando a cualquier punto, con el mismo resultado", async () => {
    const lector = new LectorDeBytes(muestra("estereo24.flac"));
    const d = await DecodificadorFlac.abrir(lector);
    const esperado = pcm("estereo24.pcm");
    for (const [inicio, cuantos] of [[50000, 3000], [123, 4096], [30000, 9000], [0, 10], [57000, 400], [20500, 5000]]) {
      const tramo = await d.leer(inicio, cuantos);
      expect(Array.from(tramo)).toEqual(Array.from(esperado.subarray(inicio * 2, (inicio + cuantos) * 2)));
    }
  });

  it("la lectura seguida continúa donde quedó, sin volver a buscar", async () => {
    const lector = new LectorDeBytes(muestra("estereo24.flac"));
    const d = await DecodificadorFlac.abrir(lector);
    const esperado = pcm("estereo24.pcm");
    const trozos: number[] = [];
    for (let inicio = 0; inicio < d.info.frames; inicio += 7000) trozos.push(...(await d.leer(inicio, 7000)));
    expect(trozos.length).toBe(esperado.length);
    expect(trozos.every((v, i) => v === esperado[i])).toBe(true);
  });

  it("más allá del final devuelve solo lo que hay", async () => {
    const d = await DecodificadorFlac.abrir(new LectorDeBytes(muestra("estereo24.flac")));
    expect((await d.leer(d.info.frames - 100, 5000)).length).toBe(200);
    expect((await d.leer(d.info.frames + 10, 100)).length).toBe(0);
  });

  it("convierte mono de 16 bits a estéreo", async () => {
    const d = await DecodificadorFlac.abrir(new LectorDeBytes(muestra("mono16.flac")));
    const esperado = pcm("mono16.pcm");
    const tramo = await d.leer(1000, 6000);
    for (let i = 0; i < 6000; i++) {
      expect(tramo[i * 2]).toBe(esperado[1000 + i]);
      expect(tramo[i * 2 + 1]).toBe(esperado[1000 + i]);
    }
  });

  it("rechaza lo que no es FLAC", async () => {
    await expect(DecodificadorFlac.abrir(new LectorDeBytes(new Uint8Array(100)))).rejects.toThrow(/FLAC/);
  });
});

describe("paquete .falab", () => {
  it("lee archivos internos por tramos sin extraerlos, incluido el audio", async () => {
    const flac = muestra("estereo24.flac");
    const json = new TextEncoder().encode(JSON.stringify({ id: "abc", nombre: "Canción ñ" }));
    const paquete = await Paquete.abrir(new LectorDeBytes(zip({ "proyecto.json": json, "stems/voz.flac": flac })));
    expect(paquete.nombres()).toEqual(["proyecto.json", "stems/voz.flac"]);
    expect(await paquete.json("proyecto.json")).toEqual({ id: "abc", nombre: "Canción ñ" });
    const d = await DecodificadorFlac.abrir(await paquete.archivo("stems/voz.flac"));
    const esperado = pcm("estereo24.pcm");
    expect(Array.from(await d.leer(40000, 2000))).toEqual(Array.from(esperado.subarray(80000, 84000)));
    await expect(paquete.archivo("no-existe")).rejects.toThrow(/no contiene/);
  });

  it("rechaza un archivo que no es un proyecto", async () => {
    await expect(Paquete.abrir(new LectorDeBytes(new Uint8Array(500)))).rejects.toThrow(/válido/);
  });
});
