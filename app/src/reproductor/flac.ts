/**
 * Decodificador FLAC por tramos, en TypeScript.
 *
 * El reproductor de falab pide el audio en fragmentos de ~3 s. En el escritorio los sirve el
 * motor Python; en el iPad no hay motor, así que los stems FLAC del proyecto se decodifican aquí.
 * Solo se lee y decodifica el tramo pedido: la memoria no depende de la duración de la canción.
 *
 * Para saltar a un punto cualquiera no se recorre el archivo: se estima la posición en bytes, se
 * busca ahí la cabecera de un bloque (validada con sus códigos de control) y se lee su número de
 * muestra; un par de aproximaciones bastan. La reproducción seguida continúa donde quedó.
 */
import type { Lector } from "./lector";

const VENTANA = 256 * 1024;

/** CRC-8 (polinomio 0x07) de las cabeceras de bloque. */
const TABLA_CRC8 = new Uint8Array(256);
/** CRC-16 (polinomio 0x8005) de los bloques completos. */
const TABLA_CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i, c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  TABLA_CRC8[i] = c8;
  TABLA_CRC16[i] = c16;
}

class Bits {
  private acumulado = 0;
  private disponibles = 0;
  constructor(private bytes: Uint8Array, public posicion: number) {}

  leer(n: number): number {
    // Hasta 32 bits; se trabaja con multiplicaciones para no desbordar los enteros de 32 bits de JS.
    let valor = 0;
    while (n > 0) {
      if (this.disponibles === 0) {
        if (this.posicion >= this.bytes.length) throw new FaltanDatos();
        this.acumulado = this.bytes[this.posicion++];
        this.disponibles = 8;
      }
      const tomar = Math.min(n, this.disponibles);
      const trozo = (this.acumulado >> (this.disponibles - tomar)) & ((1 << tomar) - 1);
      valor = valor * (1 << tomar) + trozo;
      this.disponibles -= tomar;
      n -= tomar;
    }
    return valor;
  }

  leerConSigno(n: number): number {
    const valor = this.leer(n);
    const mitad = 2 ** (n - 1);
    return valor >= mitad ? valor - 2 * mitad : valor;
  }

  /** Cuenta de ceros hasta el primer 1 (código unario). */
  unario(): number {
    let ceros = 0;
    for (;;) {
      if (this.disponibles === 0) {
        if (this.posicion >= this.bytes.length) throw new FaltanDatos();
        this.acumulado = this.bytes[this.posicion++];
        this.disponibles = 8;
      }
      const resto = this.acumulado & ((1 << this.disponibles) - 1);
      if (resto === 0) {
        ceros += this.disponibles;
        this.disponibles = 0;
        continue;
      }
      const delante = Math.clz32(resto) - (32 - this.disponibles);
      ceros += delante;
      this.disponibles -= delante + 1;
      return ceros;
    }
  }

  alinear(): void {
    this.disponibles = 0;
  }
}

class FaltanDatos extends Error {}

interface Cabecera {
  muestra: number;     // número de la primera muestra del bloque
  tamano: number;      // muestras del bloque
  canales: number;
  asignacion: number;  // 0–7 independientes, 8 izq/dif, 9 dif/der, 10 medio/dif
  bits: number;
  bytesCabecera: number;
}

export interface InfoFlac {
  frecuencia: number;
  canales: number;
  bits: number;
  frames: number;
}

export class DecodificadorFlac {
  private ventana: Uint8Array = new Uint8Array(0);
  private inicioVentana = 0;
  /** Dónde continuar si la próxima lectura sigue a la anterior. */
  private cursor: { byte: number; muestra: number } | null = null;

  private constructor(private lector: Lector, readonly info: InfoFlac, private inicioAudio: number,
    private bloqueMinimo: number, private bloqueMaximo: number) {}

  static async abrir(lector: Lector): Promise<DecodificadorFlac> {
    const principio = await lector.leer(0, Math.min(lector.tamano, 64 * 1024));
    if (principio[0] !== 0x66 || principio[1] !== 0x4c || principio[2] !== 0x61 || principio[3] !== 0x43) {
      throw new Error("El audio del proyecto no está en formato FLAC.");
    }
    let p = 4;
    let info: InfoFlac | null = null;
    let minimo = 0, maximo = 0;
    for (;;) {
      const ultimo = (principio[p] & 0x80) !== 0;
      const tipo = principio[p] & 0x7f;
      const largo = (principio[p + 1] << 16) | (principio[p + 2] << 8) | principio[p + 3];
      if (tipo === 0) {
        const b = new Bits(principio, p + 4);
        minimo = b.leer(16);
        maximo = b.leer(16);
        b.leer(24); b.leer(24);
        const frecuencia = b.leer(20);
        const canales = b.leer(3) + 1;
        const bits = b.leer(5) + 1;
        const frames = b.leer(4) * 2 ** 32 + b.leer(32);
        info = { frecuencia, canales, bits, frames };
      }
      p += 4 + largo;
      if (ultimo) break;
      if (p + 4 > principio.length) throw new Error("Cabecera FLAC demasiado larga.");
    }
    if (!info) throw new Error("El FLAC no tiene información de formato.");
    return new DecodificadorFlac(lector, info, p, minimo, maximo);
  }

  private async asegurar(desde: number, cuantos: number): Promise<void> {
    if (desde >= this.inicioVentana && desde + cuantos <= this.inicioVentana + this.ventana.length) return;
    this.inicioVentana = desde;
    this.ventana = await this.lector.leer(desde, Math.max(cuantos, VENTANA));
  }

  /** Interpreta una cabecera de bloque en `i` (índice dentro de la ventana). Null si no lo es. */
  private cabeceraEn(i: number): Cabecera | null {
    const v = this.ventana;
    if (i + 16 > v.length || v[i] !== 0xff || (v[i + 1] & 0xfe) !== 0xf8) return null;
    const variable = (v[i + 1] & 1) === 1;
    const codigoTamano = v[i + 2] >> 4;
    const codigoFrecuencia = v[i + 2] & 0x0f;
    const asignacion = v[i + 3] >> 4;
    const codigoBits = (v[i + 3] >> 1) & 0x07;
    if (codigoTamano === 0 || codigoFrecuencia === 15 || asignacion > 10 || codigoBits === 3 || codigoBits === 7 || v[i + 3] & 1) return null;
    // Número de bloque (o de muestra), en el formato de longitud variable de UTF-8.
    let p = i + 4;
    const primero = v[p++];
    let extra = 0;
    let numero: number;
    if (primero < 0x80) numero = primero;
    else {
      if (primero >= 0xfe) return null;
      extra = primero >= 0xfc ? 5 : primero >= 0xf8 ? 4 : primero >= 0xf0 ? 3 : primero >= 0xe0 ? 2 : primero >= 0xc0 ? 1 : -1;
      if (extra < 0) return null;
      numero = primero & (0x7f >> (extra + 1));
      for (let k = 0; k < extra; k++) {
        if ((v[p] & 0xc0) !== 0x80) return null;
        numero = numero * 64 + (v[p++] & 0x3f);
      }
    }
    let tamano: number;
    if (codigoTamano === 1) tamano = 192;
    else if (codigoTamano <= 5) tamano = 576 << (codigoTamano - 2);
    else if (codigoTamano === 6) tamano = v[p++] + 1;
    else if (codigoTamano === 7) { tamano = ((v[p] << 8) | v[p + 1]) + 1; p += 2; }
    else tamano = 256 << (codigoTamano - 8);
    if (codigoFrecuencia === 12) p += 1;
    else if (codigoFrecuencia === 13 || codigoFrecuencia === 14) p += 2;
    let crc = 0;
    for (let k = i; k < p; k++) crc = TABLA_CRC8[crc ^ v[k]];
    if (crc !== v[p]) return null;
    const bits = codigoBits === 0 ? this.info.bits : [0, 8, 12, 0, 16, 20, 24][codigoBits];
    return {
      muestra: variable ? numero : numero * this.bloqueMinimo,
      tamano, asignacion, bits,
      canales: asignacion < 8 ? asignacion + 1 : 2,
      bytesCabecera: p + 1 - i,
    };
  }

  /** Decodifica el bloque que empieza en el byte `byte`. Devuelve sus canales y dónde acaba. */
  private async bloque(byte: number, comprobar: boolean): Promise<{ cabecera: Cabecera; canales: Float64Array[]; fin: number } | null> {
    // Un bloque comprimido nunca ocupa más que sin comprimir (más un pequeño margen de cabeceras).
    let margen = 64 * 1024;
    for (;;) {
      await this.asegurar(byte, Math.min(margen, this.lector.tamano - byte));
      const i = byte - this.inicioVentana;
      const cabecera = this.cabeceraEn(i);
      if (!cabecera) return null;
      try {
        const bits = new Bits(this.ventana, i + cabecera.bytesCabecera);
        const canales: Float64Array[] = [];
        for (let c = 0; c < cabecera.canales; c++) {
          // El canal «diferencia» necesita un bit más que el resto.
          const esDiferencia = (cabecera.asignacion === 8 && c === 1) || (cabecera.asignacion === 9 && c === 0) || (cabecera.asignacion === 10 && c === 1);
          canales.push(subbloque(bits, cabecera.tamano, cabecera.bits + (esDiferencia ? 1 : 0)));
        }
        bits.alinear();
        const finDatos = bits.posicion;
        if (finDatos + 2 > this.ventana.length) throw new FaltanDatos();
        if (comprobar) {
          let crc = 0;
          for (let k = i; k < finDatos; k++) crc = ((crc << 8) & 0xffff) ^ TABLA_CRC16[(crc >> 8) ^ this.ventana[k]];
          if (crc !== ((this.ventana[finDatos] << 8) | this.ventana[finDatos + 1])) return null; // falsa cabecera
        }
        deshacerEstereo(cabecera.asignacion, canales);
        return { cabecera, canales, fin: this.inicioVentana + finDatos + 2 };
      } catch (error) {
        if (!(error instanceof FaltanDatos)) throw error;
        if (this.inicioVentana + this.ventana.length >= this.lector.tamano) return null;
        margen *= 4; // el bloque no cabía en lo leído: se amplía la ventana
        this.ventana = new Uint8Array(0);
      }
    }
  }

  /** Busca, desde `byte`, el primer bloque válido. */
  private async buscarBloque(byte: number): Promise<{ byte: number; muestra: number } | null> {
    let desde = Math.max(this.inicioAudio, byte);
    while (desde < this.lector.tamano) {
      await this.asegurar(desde, Math.min(VENTANA, this.lector.tamano - desde));
      const limite = this.ventana.length - 16;
      for (let i = desde - this.inicioVentana; i < limite; i++) {
        if (this.ventana[i] !== 0xff || (this.ventana[i + 1] & 0xfe) !== 0xf8) continue;
        const posible = this.inicioVentana + i;
        const cabecera = this.cabeceraEn(i);
        if (!cabecera) continue;
        // Los códigos de control de la cabecera pueden coincidir por azar: se confirma con el del bloque entero.
        const completo = await this.bloque(posible, true);
        if (completo) return { byte: posible, muestra: completo.cabecera.muestra };
        await this.asegurar(desde, Math.min(VENTANA, this.lector.tamano - desde));
      }
      if (this.inicioVentana + this.ventana.length >= this.lector.tamano) break;
      desde = this.inicioVentana + limite;
    }
    return null;
  }

  /** Coloca el cursor en el bloque que contiene la muestra `objetivo`. */
  private async saltar(objetivo: number): Promise<void> {
    const total = Math.max(1, this.info.frames);
    const bytesAudio = this.lector.tamano - this.inicioAudio;
    let estimacion = this.inicioAudio + Math.floor((objetivo / total) * bytesAudio);
    let mejor = { byte: this.inicioAudio, muestra: 0 };
    for (let intento = 0; intento < 12; intento++) {
      // Se apunta un poco antes para caer en un bloque anterior al objetivo.
      const hallado = await this.buscarBloque(Math.max(this.inicioAudio, estimacion - 2 * VENTANA / 8));
      if (!hallado) {
        estimacion = Math.max(this.inicioAudio, estimacion - VENTANA);
        if (estimacion === this.inicioAudio && intento > 0) break;
        continue;
      }
      if (hallado.muestra <= objetivo) {
        if (hallado.muestra >= mejor.muestra) mejor = hallado;
        // Suficientemente cerca: el resto se avanza decodificando.
        if (objetivo - hallado.muestra < this.bloqueMaximo * 24 || hallado.byte === this.inicioAudio) break;
        const porMuestra = bytesAudio / total;
        estimacion = hallado.byte + Math.floor((objetivo - hallado.muestra) * porMuestra * 0.9);
      } else {
        const porMuestra = bytesAudio / total;
        estimacion = Math.max(this.inicioAudio, hallado.byte - Math.ceil((hallado.muestra - objetivo) * porMuestra * 1.5) - VENTANA / 4);
        if (hallado.byte <= this.inicioAudio) break;
      }
    }
    this.cursor = mejor;
  }

  /**
   * Devuelve `cuantos` frames desde `inicio` en PCM de 16 bits estéreo entrelazado
   * (lo que consume el procesador de audio). Más allá del final devuelve menos frames.
   */
  async leer(inicio: number, cuantos: number): Promise<Int16Array> {
    const fin = Math.min(this.info.frames, inicio + cuantos);
    const total = Math.max(0, fin - inicio);
    const salida = new Int16Array(total * 2);
    if (total === 0) return salida;
    const continua = this.cursor && this.cursor.muestra <= inicio && inicio - this.cursor.muestra < this.bloqueMaximo * 8;
    if (!continua) await this.saltar(inicio);
    const reducir = 2 ** Math.max(0, this.info.bits - 16);
    const ampliar = 2 ** Math.max(0, 16 - this.info.bits);
    let { byte, muestra } = this.cursor!;
    let primero = true;
    while (muestra < fin) {
      const decodificado = await this.bloque(byte, primero && !continua);
      primero = false;
      if (!decodificado) break; // final del archivo o bloque dañado: el resto queda en silencio
      const { cabecera, canales } = decodificado;
      muestra = cabecera.muestra;
      const izquierda = canales[0];
      const derecha = canales[1] ?? canales[0]; // mono: mismo audio en ambos canales
      const desde = Math.max(inicio, muestra);
      const hasta = Math.min(fin, muestra + cabecera.tamano);
      for (let m = desde; m < hasta; m++) {
        const o = (m - inicio) * 2;
        salida[o] = Math.floor(izquierda[m - muestra] / reducir) * ampliar;
        salida[o + 1] = Math.floor(derecha[m - muestra] / reducir) * ampliar;
      }
      byte = decodificado.fin;
      muestra += cabecera.tamano;
      this.cursor = { byte, muestra };
    }
    return salida;
  }
}

function deshacerEstereo(asignacion: number, canales: Float64Array[]): void {
  if (asignacion < 8) return;
  const [a, b] = canales;
  const n = a.length;
  if (asignacion === 8) for (let i = 0; i < n; i++) b[i] = a[i] - b[i];          // izquierda, diferencia
  else if (asignacion === 9) for (let i = 0; i < n; i++) a[i] = a[i] + b[i];     // diferencia, derecha
  else {
    for (let i = 0; i < n; i++) {                                                  // medio, diferencia
      const diferencia = b[i];
      const medio = a[i] * 2 + (Math.abs(diferencia) % 2);
      a[i] = (medio + diferencia) / 2;
      b[i] = (medio - diferencia) / 2;
    }
  }
}

const FIJOS = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function subbloque(bits: Bits, tamano: number, profundidad: number): Float64Array {
  if (bits.leer(1) !== 0) throw new Error("Bloque FLAC dañado.");
  const tipo = bits.leer(6);
  let desperdiciados = 0;
  if (bits.leer(1) === 1) desperdiciados = bits.unario() + 1;
  profundidad -= desperdiciados;
  const salida = new Float64Array(tamano);
  if (tipo === 0) {
    salida.fill(bits.leerConSigno(profundidad));
  } else if (tipo === 1) {
    for (let i = 0; i < tamano; i++) salida[i] = bits.leerConSigno(profundidad);
  } else if (tipo >= 8 && tipo <= 12) {
    const orden = tipo - 8;
    for (let i = 0; i < orden; i++) salida[i] = bits.leerConSigno(profundidad);
    residuo(bits, salida, orden);
    predecir(salida, orden, FIJOS[orden], 0);
  } else if (tipo >= 32) {
    const orden = tipo - 31;
    for (let i = 0; i < orden; i++) salida[i] = bits.leerConSigno(profundidad);
    const precision = bits.leer(4) + 1;
    const desplazamiento = bits.leerConSigno(5);
    const coeficientes: number[] = [];
    for (let i = 0; i < orden; i++) coeficientes.push(bits.leerConSigno(precision));
    residuo(bits, salida, orden);
    predecir(salida, orden, coeficientes, desplazamiento);
  } else {
    throw new Error("Tipo de bloque FLAC no admitido.");
  }
  if (desperdiciados) {
    const factor = 2 ** desperdiciados;
    for (let i = 0; i < tamano; i++) salida[i] *= factor;
  }
  return salida;
}

/** Lee el residuo (códigos de Rice por particiones) en `salida[orden..]`. */
function residuo(bits: Bits, salida: Float64Array, orden: number): void {
  const metodo = bits.leer(2);
  if (metodo > 1) throw new Error("Codificación de residuo FLAC no admitida.");
  const bitsParametro = metodo === 0 ? 4 : 5;
  const escape = metodo === 0 ? 15 : 31;
  const particiones = 1 << bits.leer(4);
  const porParticion = salida.length >> Math.log2(particiones);
  let i = orden;
  for (let p = 0; p < particiones; p++) {
    const fin = p === 0 ? porParticion : i + porParticion;
    const parametro = bits.leer(bitsParametro);
    if (parametro === escape) {
      const n = bits.leer(5);
      for (; i < fin; i++) salida[i] = n === 0 ? 0 : bits.leerConSigno(n);
    } else {
      const base = 2 ** parametro;
      for (; i < fin; i++) {
        const sinSigno = bits.unario() * base + (parametro ? bits.leer(parametro) : 0);
        salida[i] = sinSigno % 2 === 0 ? sinSigno / 2 : -(sinSigno + 1) / 2;
      }
    }
  }
}

/** Reconstruye la señal a partir del residuo: cada muestra es su residuo más una predicción lineal. */
function predecir(salida: Float64Array, orden: number, coeficientes: number[], desplazamiento: number): void {
  const divisor = 2 ** desplazamiento;
  for (let i = orden; i < salida.length; i++) {
    let suma = 0;
    for (let k = 0; k < orden; k++) suma += coeficientes[k] * salida[i - 1 - k];
    salida[i] += Math.floor(suma / divisor);
  }
}
