/**
 * Lector mínimo de ZIP para los proyectos .falab.
 *
 * El escritorio guarda los .falab SIN comprimir (el FLAC ya lo está). Gracias a eso, cada
 * archivo interno es un tramo contiguo del .falab y se puede leer directamente, sin extraer nada:
 * un proyecto en el iPad es un único archivo y no ocupa el doble.
 */
import { LectorDeTramo, type Lector } from "./lector";

interface Entrada {
  desplazamiento: number; // de la cabecera local
  tamano: number;
  metodo: number;
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

export class Paquete {
  private constructor(private lector: Lector, private entradas: Map<string, Entrada>) {}

  static async abrir(lector: Lector): Promise<Paquete> {
    // El índice (directorio central) está al final del archivo.
    const cola = Math.min(lector.tamano, 66000);
    const final = await lector.leer(lector.tamano - cola, cola);
    let fin = -1;
    for (let i = final.length - 22; i >= 0; i--) {
      if (final[i] === 0x50 && final[i + 1] === 0x4b && final[i + 2] === 0x05 && final[i + 3] === 0x06) {
        fin = i;
        break;
      }
    }
    if (fin < 0) throw new Error("El archivo no es un proyecto de falab válido.");
    const cuantas = u16(final, fin + 10);
    const tamanoIndice = u32(final, fin + 12);
    const inicioIndice = u32(final, fin + 16);
    if (inicioIndice === 0xffffffff) throw new Error("El proyecto es demasiado grande para este reproductor.");
    const indice = await lector.leer(inicioIndice, tamanoIndice);
    const entradas = new Map<string, Entrada>();
    const texto = new TextDecoder();
    let p = 0;
    for (let n = 0; n < cuantas && p + 46 <= indice.length; n++) {
      if (u32(indice, p) !== 0x02014b50) break;
      const largoNombre = u16(indice, p + 28);
      const nombre = texto.decode(indice.subarray(p + 46, p + 46 + largoNombre));
      entradas.set(nombre, { metodo: u16(indice, p + 10), tamano: u32(indice, p + 24), desplazamiento: u32(indice, p + 42) });
      p += 46 + largoNombre + u16(indice, p + 30) + u16(indice, p + 32);
    }
    return new Paquete(lector, entradas);
  }

  nombres(): string[] {
    return [...this.entradas.keys()];
  }

  tiene(nombre: string): boolean {
    return this.entradas.has(nombre);
  }

  /** Lector por tramos de un archivo interno (no se copia ni se extrae). */
  async archivo(nombre: string): Promise<Lector> {
    const entrada = this.entradas.get(nombre);
    if (!entrada) throw new Error(`El proyecto no contiene «${nombre}».`);
    if (entrada.metodo !== 0) throw new Error("Este proyecto está comprimido: vuelve a exportarlo desde falab.");
    const cabecera = await this.lector.leer(entrada.desplazamiento, 30);
    if (u32(cabecera, 0) !== 0x04034b50) throw new Error("El proyecto está dañado.");
    const datos = entrada.desplazamiento + 30 + u16(cabecera, 26) + u16(cabecera, 28);
    return new LectorDeTramo(this.lector, datos, entrada.tamano);
  }

  async json<T>(nombre: string): Promise<T> {
    const lector = await this.archivo(nombre);
    return JSON.parse(new TextDecoder().decode(await lector.leer(0, lector.tamano))) as T;
  }
}
