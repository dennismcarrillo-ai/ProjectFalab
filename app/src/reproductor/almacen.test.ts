import { describe, expect, it } from "vitest";
import { borrarProyecto, copiarAlAlmacen, listarProyectos, nombreSeguro, type SistemaDeArchivos } from "./almacen";

/** Sistema de archivos en memoria con la misma forma que el complemento de Tauri. */
function fsFalso(fallarAlEscribir = false) {
  const datos = new Map<string, Uint8Array>();        // "base:ruta" -> contenido
  const escrituras: number[] = [];
  const clave = (ruta: string, base: number) => `${base}:${ruta}`;
  const fs: SistemaDeArchivos = {
    BaseDirectory: { AppData: 1, Document: 2 },
    async mkdir() {},
    async open(ruta, { baseDir }) {
      datos.set(clave(ruta, baseDir), new Uint8Array(0));
      return {
        async write(trozo) {
          if (fallarAlEscribir && escrituras.length >= 1) throw new Error("disco lleno");
          // Como un sistema real, puede escribir menos de lo pedido.
          const n = Math.min(trozo.length, 3 * 1024 * 1024);
          const previo = datos.get(clave(ruta, baseDir))!;
          const unido = new Uint8Array(previo.length + n);
          unido.set(previo); unido.set(trozo.subarray(0, n), previo.length);
          datos.set(clave(ruta, baseDir), unido);
          escrituras.push(n);
          return n;
        },
        async close() {},
      };
    },
    async rename(desde, hasta, { oldPathBaseDir, newPathBaseDir }) {
      datos.set(clave(hasta, newPathBaseDir), datos.get(clave(desde, oldPathBaseDir))!);
      datos.delete(clave(desde, oldPathBaseDir));
    },
    async remove(ruta, { baseDir }) {
      if (!datos.delete(clave(ruta, baseDir))) throw new Error("no existe");
    },
    async readDir(carpeta, { baseDir }) {
      const prefijo = clave(carpeta ? carpeta + "/" : "", baseDir);
      const nombres = [...datos.keys()].filter((k) => k.startsWith(prefijo) && !k.slice(prefijo.length).includes("/"));
      if (carpeta && nombres.length === 0) throw new Error("no existe la carpeta");
      return nombres.map((k) => ({ name: k.slice(prefijo.length), isFile: true }));
    },
    async stat(ruta, { baseDir }) {
      return { size: datos.get(clave(ruta, baseDir))!.length };
    },
  };
  return { fs, datos, escrituras };
}

const archivo = (nombre: string, megas: number) => {
  const bytes = new Uint8Array(megas * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4099) bytes[i] = i % 251;
  return Object.assign(new Blob([bytes]), { name: nombre });
};

describe("almacén de proyectos del dispositivo", () => {
  it("copia por trozos, sin tener el archivo entero en memoria, y lo deja con su nombre", async () => {
    const { fs, datos, escrituras } = fsFalso();
    const origen = archivo("Canción ñ.falab", 9);
    const avances: number[] = [];
    const nombre = await copiarAlAlmacen(fs, origen, (f) => avances.push(f));
    expect(nombre).toBe("Canción ñ.falab");
    expect([...datos.keys()]).toEqual(["1:proyectos/Canción ñ.falab"]);        // sin restos de la copia parcial
    const copiado = datos.get("1:proyectos/Canción ñ.falab")!;
    expect(copiado.length).toBe(origen.size);
    expect(Buffer.from(copiado).equals(Buffer.from(await origen.arrayBuffer()))).toBe(true);
    expect(Math.max(...escrituras)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(avances[avances.length - 1]).toBe(1);
    expect(avances).toEqual([...avances].sort((a, b) => a - b));
  });

  it("si la copia falla no deja un proyecto a medias", async () => {
    const { fs, datos } = fsFalso(true);
    await expect(copiarAlAlmacen(fs, archivo("a.falab", 9))).rejects.toThrow("disco lleno");
    expect(datos.size).toBe(0);
  });

  it("lista los proyectos del almacén y de Documentos, y los borra de donde estén", async () => {
    const { fs, datos } = fsFalso();
    await copiarAlAlmacen(fs, archivo("uno.falab", 1));
    datos.set("2:dos.FALAB", new Uint8Array(10));           // dejado en «Archivos» del iPad
    datos.set("2:notas.txt", new Uint8Array(10));
    datos.set("1:proyectos/tres.falab.copiando", new Uint8Array(5));   // copia interrumpida: no cuenta
    const lista = await listarProyectos(fs);
    expect(lista.map((a) => [a.nombre, a.base, a.lector.tamano])).toEqual([["uno.falab", "datos", 1048576], ["dos.FALAB", "documentos", 10]]);
    await borrarProyecto(fs, lista[0]);
    await borrarProyecto(fs, lista[1]);
    expect((await listarProyectos(fs)).length).toBe(0);
  });

  it("sin carpetas todavía, la lista está vacía (primer arranque)", async () => {
    expect(await listarProyectos(fsFalso().fs)).toEqual([]);
  });

  it("limpia los nombres de archivo peligrosos", () => {
    expect(nombreSeguro("../../etc/passwd")).toBe("_.._etc_passwd.falab");
    expect(nombreSeguro("Mi tema: versión 2?.falab")).toBe("Mi tema_ versión 2_.falab");
    expect(nombreSeguro("")).toBe("proyecto.falab");
  });
});
