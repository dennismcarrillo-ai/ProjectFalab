/**
 * Almacén de proyectos del dispositivo (reproductor en Android y iPad).
 *
 * En Android otras apps no pueden dejar archivos en la carpeta de falab, así que los .falab se
 * eligen con el selector del sistema y se COPIAN al espacio privado de la app. La copia se hace
 * por trozos de pocos MB: un proyecto de 300 MB nunca está entero en memoria.
 */
import { LectorDeArchivoDeApp, type Lector } from "./lector";

export const CARPETA = "proyectos";
const TROZO = 4 * 1024 * 1024;

/** Lo mínimo del complemento de archivos de Tauri que se usa aquí (permite probarlo sin Tauri). */
export interface SistemaDeArchivos {
  BaseDirectory: { AppData: number; Document: number };
  mkdir(ruta: string, opciones: { baseDir: number; recursive: boolean }): Promise<void>;
  open(ruta: string, opciones: { baseDir: number; write?: boolean; create?: boolean; truncate?: boolean }): Promise<{
    write(datos: Uint8Array): Promise<number>;
    close(): Promise<void>;
  }>;
  rename(desde: string, hasta: string, opciones: { oldPathBaseDir: number; newPathBaseDir: number }): Promise<void>;
  remove(ruta: string, opciones: { baseDir: number }): Promise<void>;
  readDir(ruta: string, opciones: { baseDir: number }): Promise<{ name: string; isFile: boolean }[]>;
  stat(ruta: string, opciones: { baseDir: number }): Promise<{ size: number }>;
}

/** Deja el nombre en algo seguro como nombre de archivo, conservando tildes y espacios. */
export function nombreSeguro(nombre: string): string {
  const limpio = nombre.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return limpio.toLowerCase().endsWith(".falab") ? limpio : `${limpio || "proyecto"}.falab`;
}

/** Copia un archivo elegido por el usuario al almacén de la app. Devuelve el nombre con que quedó. */
export async function copiarAlAlmacen(fs: SistemaDeArchivos, archivo: Blob & { name: string },
  alAvanzar: (fraccion: number) => void = () => {}): Promise<string> {
  const base = fs.BaseDirectory.AppData;
  const nombre = nombreSeguro(archivo.name);
  const destino = `${CARPETA}/${nombre}`;
  // Se escribe con otro nombre y se renombra al terminar: una copia interrumpida nunca parece un proyecto.
  const parcial = `${destino}.copiando`;
  await fs.mkdir(CARPETA, { baseDir: base, recursive: true });
  const salida = await fs.open(parcial, { baseDir: base, write: true, create: true, truncate: true });
  try {
    for (let desde = 0; desde < archivo.size; desde += TROZO) {
      const bytes = new Uint8Array(await archivo.slice(desde, desde + TROZO).arrayBuffer());
      let escritos = 0;
      while (escritos < bytes.length) escritos += await salida.write(bytes.subarray(escritos));
      alAvanzar(Math.min(1, (desde + bytes.length) / archivo.size));
    }
    await salida.close();
    await fs.rename(parcial, destino, { oldPathBaseDir: base, newPathBaseDir: base });
  } catch (error) {
    await salida.close().catch(() => undefined);
    await fs.remove(parcial, { baseDir: base }).catch(() => undefined);
    throw error;
  }
  return nombre;
}

export interface ArchivoDeProyecto {
  nombre: string;
  lector: Lector;
  /** Dónde está, para poder borrarlo. */
  base: "datos" | "documentos";
}

/**
 * Proyectos guardados en el dispositivo: los copiados al almacén de la app y, en el iPad, los
 * que el usuario dejó en la carpeta de falab de la app «Archivos».
 */
export async function listarProyectos(fs: SistemaDeArchivos): Promise<ArchivoDeProyecto[]> {
  const encontrados: ArchivoDeProyecto[] = [];
  const mirar = async (carpeta: string, base: "datos" | "documentos") => {
    const baseDir = base === "datos" ? fs.BaseDirectory.AppData : fs.BaseDirectory.Document;
    let entradas: { name: string; isFile: boolean }[];
    try {
      entradas = await fs.readDir(carpeta, { baseDir });
    } catch {
      return; // la carpeta aún no existe o no es accesible en esta plataforma
    }
    for (const entrada of entradas) {
      if (!entrada.isFile || !entrada.name.toLowerCase().endsWith(".falab")) continue;
      const ruta = carpeta ? `${carpeta}/${entrada.name}` : entrada.name;
      try {
        const { size } = await fs.stat(ruta, { baseDir });
        encontrados.push({ nombre: entrada.name, lector: new LectorDeArchivoDeApp(ruta, size, base), base });
      } catch {
        /* archivo ilegible: se ignora */
      }
    }
  };
  await mirar(CARPETA, "datos");
  await mirar("", "documentos");
  return encontrados;
}

export async function borrarProyecto(fs: SistemaDeArchivos, archivo: Pick<ArchivoDeProyecto, "nombre" | "base">): Promise<void> {
  if (archivo.base === "datos") await fs.remove(`${CARPETA}/${archivo.nombre}`, { baseDir: fs.BaseDirectory.AppData });
  else await fs.remove(archivo.nombre, { baseDir: fs.BaseDirectory.Document });
}

/** Complemento de archivos real de Tauri. */
export async function sistemaDeArchivos(): Promise<SistemaDeArchivos> {
  return (await import("@tauri-apps/plugin-fs")) as unknown as SistemaDeArchivos;
}
