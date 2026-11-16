/** Lectura de archivos por tramos. Nada de lo que hace el reproductor carga un archivo entero. */

export interface Lector {
  /** Tamaño total en bytes. */
  readonly tamano: number;
  /** Lee `cuantos` bytes desde `desde` (menos si se acaba el archivo). */
  leer(desde: number, cuantos: number): Promise<Uint8Array>;
}

/** Archivo elegido en el navegador (o cualquier Blob). */
export class LectorDeBlob implements Lector {
  readonly tamano: number;
  constructor(private blob: Blob) {
    this.tamano = blob.size;
  }
  async leer(desde: number, cuantos: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(desde, desde + cuantos).arrayBuffer());
  }
}

/** Datos ya en memoria (pruebas). */
export class LectorDeBytes implements Lector {
  readonly tamano: number;
  lecturas = 0;
  constructor(private bytes: Uint8Array) {
    this.tamano = bytes.length;
  }
  async leer(desde: number, cuantos: number): Promise<Uint8Array> {
    this.lecturas++;
    return this.bytes.subarray(desde, Math.min(this.bytes.length, desde + cuantos));
  }
}

/** Ventana dentro de otro lector: un archivo guardado sin comprimir dentro de un .falab. */
export class LectorDeTramo implements Lector {
  constructor(private base: Lector, private inicio: number, readonly tamano: number) {}
  leer(desde: number, cuantos: number): Promise<Uint8Array> {
    const util = Math.max(0, Math.min(cuantos, this.tamano - desde));
    return util === 0 ? Promise.resolve(new Uint8Array(0)) : this.base.leer(this.inicio + desde, util);
  }
}

/**
 * Archivo guardado en el dispositivo: en el almacén privado de la app («datos») o en su carpeta
 * de Documentos («documentos», la que se ve en «Archivos» del iPad). Se abre una vez y se lee por
 * tramos con el complemento de archivos de Tauri; las lecturas van en fila porque comparten cursor.
 */
export class LectorDeArchivoDeApp implements Lector {
  private fila: Promise<unknown> = Promise.resolve();
  private manejador: { seek(desde: number, modo: number): Promise<number>; read(destino: Uint8Array): Promise<number | null> } | null = null;
  constructor(private ruta: string, readonly tamano: number, private base: "datos" | "documentos") {}

  leer(desde: number, cuantos: number): Promise<Uint8Array> {
    const tarea = this.fila.then(async () => {
      const fs = await import("@tauri-apps/plugin-fs");
      const baseDir = this.base === "datos" ? fs.BaseDirectory.AppData : fs.BaseDirectory.Document;
      this.manejador ??= await fs.open(this.ruta, { read: true, baseDir });
      await this.manejador.seek(desde, fs.SeekMode.Start);
      const destino = new Uint8Array(Math.max(0, Math.min(cuantos, this.tamano - desde)));
      let leidos = 0;
      while (leidos < destino.length) {
        const n = await this.manejador.read(destino.subarray(leidos));
        if (!n) break;
        leidos += n;
      }
      return destino.subarray(0, leidos);
    });
    this.fila = tarea.catch(() => undefined);
    return tarea;
  }
}
