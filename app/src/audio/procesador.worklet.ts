/**
 * Procesador de audio de falab (se ejecuta en el hilo de audio, dentro de un AudioWorklet).
 *
 * Qué hace:
 *  - Lleva el transporte (reproducir, pausar, saltar, bucle, cuenta regresiva) con precisión de muestra.
 *  - Monta los clips de cada pista leyendo fragmentos de PCM de 16 bits que le va enviando el
 *    hilo principal. Solo tiene en memoria unos segundos alrededor del cursor: reproducir seis
 *    stems de 5 minutos ocupa ~40 MB en vez de los ~630 MB de decodificarlos enteros a float32.
 *  - Cambia la velocidad sin alterar el tono y el tono sin alterar la velocidad (SoundTouch, WSOLA).
 *  - Genera los clics del metrónomo en los instantes exactos del mapa de pulsos.
 *
 * Cada pista sale por una salida estéreo propia; el EQ, el fader y el paneo son nodos nativos de
 * Web Audio conectados a continuación (ver MotorAudio.ts). La última salida lleva el metrónomo.
 */
import { SoundTouch } from "soundtouchjs";
import {
  BITS_FRAGMENTO, FRAMES_FRAGMENTO, MAX_PISTAS,
  type EstadoTransporte, type MensajeAlProcesador, type MensajeDelProcesador, type Montaje, type PistaProcesador,
} from "./protocolo";

declare const sampleRate: number;
declare function registerProcessor(nombre: string, clase: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

const CUANTO = 128;            // frames por llamada a process()
const BLOQUE = 1024;           // frames de entrada que se leen de una vez
const FUNDIDO_MINIMO = 132;    // 3 ms: evita clics en los cortes
const ESCALA = 1 / 32768;
const MAX_ALIMENTACIONES = 12; // tope de bloques por cuanto, para no bloquear el hilo de audio

/** Cola FIFO de audio estéreo entrelazado. */
class Cola {
  private datos = new Float32Array(2 * 16384);
  private inicio = 0;
  frames = 0;

  vaciar(): void {
    this.inicio = 0;
    this.frames = 0;
  }

  /** Reserva sitio para `n` frames al final y devuelve dónde escribirlos. */
  reservar(n: number): { destino: Float32Array; desde: number } {
    if (this.inicio > 0) {
      this.datos.copyWithin(0, this.inicio * 2, (this.inicio + this.frames) * 2);
      this.inicio = 0;
    }
    if ((this.frames + n) * 2 > this.datos.length) {
      const mayor = new Float32Array(Math.max(this.datos.length * 2, (this.frames + n) * 2));
      mayor.set(this.datos.subarray(0, this.frames * 2));
      this.datos = mayor;
    }
    const desde = this.frames * 2;
    this.frames += n;
    return { destino: this.datos, desde };
  }

  meterSilencio(n: number): void {
    if (n <= 0) return;
    const { destino, desde } = this.reservar(n);
    destino.fill(0, desde, desde + n * 2);
  }

  meter(origen: Float32Array, n: number): void {
    const { destino, desde } = this.reservar(n);
    destino.set(origen.subarray(0, n * 2), desde);
  }

  sacar(izquierda: Float32Array, derecha: Float32Array, n: number): void {
    let i = this.inicio * 2;
    for (let f = 0; f < n; f++) {
      izquierda[f] = this.datos[i++];
      derecha[f] = this.datos[i++];
    }
    this.inicio += n;
    this.frames -= n;
  }
}

interface Clic {
  retardo: number; // frames que faltan para que empiece
  edad: number;    // frames ya sonados
  frecuencia: number;
}

class ProcesadorFalab extends AudioWorkletProcessor {
  private pistas: PistaProcesador[] = [];
  private fin = 0;
  private framesDeFuente = new Map<string, number>();
  private fragmentos = new Map<string, Map<number, Int16Array>>();

  private estado: EstadoTransporte = "detenido";
  /** Próximo frame del proyecto que se leerá de las fuentes. */
  private lectura = 0;
  /** Frame del proyecto que está sonando ahora mismo (lo que ve el usuario). */
  private posicion = 0;
  private velocidad = 1;
  private tono = 0;
  private bucle: { inicio: number; fin: number } | null = null;

  // --- Show continuo -------------------------------------------------------------------
  // El cambio de canción tiene dos momentos, porque lo que se LEE va por delante de lo que se
  // OYE (lo ya leído espera en las colas):
  //   1) la lectura llega al final  -> se empieza a leer la canción siguiente («en tránsito»);
  //   2) el oyente llega al final   -> el cursor, el metrónomo y la interfaz pasan a la nueva.
  /** Canción encolada, aún sin empezar a leerse. */
  private siguiente: Montaje | null = null;
  /** Canción que ya se está leyendo pero todavía no ha empezado a sonar. */
  private enTransito: Montaje | null = null;
  /** Montaje de la canción que aún suena, por si hay que deshacer el tránsito. */
  private actual: { pistas: PistaProcesador[]; fin: number; velocidad: number; tono: number } | null = null;
  /** Final de la canción que se está leyendo. */
  private finLectura = 0;
  /** Posición (de la canción que suena) en la que empezará a oírse la siguiente. */
  private posicionDeCambio = 0;
  /** Velocidad de lo que está saliendo por los altavoces. */
  private velocidadSalida = 1;

  private colas: Cola[] = [];
  private estiradores: SoundTouch[] = [];
  private temporales: Float32Array[] = [];
  private traspaso = new Float32Array(2 * 8192);

  private metronomo = false;
  private pulsos: Float64Array = new Float64Array(0);
  private fuertes: Uint8Array = new Uint8Array(0);
  private siguientePulso = 0;
  private clics: Clic[] = [];
  private cuentaRestante = 0;
  private cuentaTotal = 0;
  private cuentaIntervalo = 0;
  private cuentaHastaClic = 0;
  private compas = 4;

  private esperando = false;
  private pedidos = new Set<string>();
  private cuantosDesdeInforme = 0;

  constructor() {
    super();
    for (let i = 0; i < MAX_PISTAS; i++) {
      this.colas.push(new Cola());
      this.estiradores.push(new SoundTouch());
      this.temporales.push(new Float32Array(BLOQUE * 2));
    }
    this.port.onmessage = (evento: MessageEvent<MensajeAlProcesador>) => this.recibir(evento.data);
  }

  private enviar(mensaje: MensajeDelProcesador): void {
    this.port.postMessage(mensaje);
  }

  private recibir(m: MensajeAlProcesador): void {
    switch (m.tipo) {
      case "proyecto":
        this.deshacerTransito();
        this.pistas = m.pistas.slice(0, MAX_PISTAS);
        this.fin = m.fin;
        this.finLectura = m.fin;
        this.framesDeFuente = new Map(Object.entries(m.fuentes));
        // La edición cambió: lo ya estirado en las colas corresponde al montaje anterior.
        this.resincronizar(this.posicion);
        break;
      case "pulsos":
        this.pulsos = m.frames;
        this.fuertes = m.fuertes;
        this.buscarPulso();
        break;
      case "encolar":
        if (this.enTransito) break; // ya se está leyendo: demasiado tarde para cambiarla
        this.siguiente = m.montaje && { ...m.montaje, pistas: m.montaje.pistas.slice(0, MAX_PISTAS) };
        break;
      case "fragmento": {
        let mapa = this.fragmentos.get(m.fuenteId);
        if (!mapa) this.fragmentos.set(m.fuenteId, (mapa = new Map()));
        mapa.set(m.indice, m.datos);
        this.pedidos.delete(`${m.fuenteId}:${m.indice}`);
        break;
      }
      case "descartar": {
        const mapa = this.fragmentos.get(m.fuenteId);
        if (mapa) for (const indice of m.indices) mapa.delete(indice);
        break;
      }
      case "reproducir":
        this.resincronizar(m.desde);
        this.compas = m.compas;
        this.cuentaRestante = m.clicsDeCuenta;
        this.cuentaTotal = m.clicsDeCuenta;
        this.cuentaIntervalo = Math.max(1, Math.round(m.intervaloDeCuenta));
        this.cuentaHastaClic = 0;
        this.estado = m.clicsDeCuenta > 0 ? "cuenta" : "reproduciendo";
        this.informar();
        break;
      case "pausar":
        this.estado = "detenido";
        this.clics.length = 0;
        this.cuentaRestante = 0;
        this.informar();
        break;
      case "saltar":
        this.resincronizar(m.posicion);
        this.informar();
        break;
      case "parametros": {
        // Estos parámetros son los de la canción que SUENA (en tránsito, `this.velocidad` es ya la siguiente).
        const velocidadVigente = this.actual ? this.actual.velocidad : this.velocidad;
        const tonoVigente = this.actual ? this.actual.tono : this.tono;
        const cambia = m.velocidad !== velocidadVigente || m.tono !== tonoVigente;
        this.metronomo = m.metronomo;
        this.bucle = m.bucle && m.bucle.fin - m.bucle.inicio > CUANTO * 4 ? m.bucle : null;
        if (cambia) {
          this.deshacerTransito();
          this.velocidad = m.velocidad;
          this.tono = m.tono;
          this.resincronizar(this.posicion);
        }
        break;
      }
    }
  }

  /** Vacía todo lo que estaba en curso y retoma la lectura exactamente en `posicion`. */
  private resincronizar(posicion: number): void {
    this.deshacerTransito();
    this.velocidadSalida = this.velocidad;
    this.posicion = Math.max(0, Math.min(posicion, this.fin));
    this.lectura = Math.floor(this.posicion);
    for (let i = 0; i < MAX_PISTAS; i++) {
      this.colas[i].vaciar();
      const estirador = this.estiradores[i];
      estirador.clear();
      estirador.inputBuffer.clear();
      estirador.outputBuffer.clear();
    }
    this.pedidos.clear();
    this.buscarPulso();
  }

  /** Si ya se estaba leyendo la canción siguiente, vuelve a la actual y la deja encolada de nuevo. */
  private deshacerTransito(): void {
    if (!this.enTransito || !this.actual) return;
    this.siguiente = this.enTransito;
    this.enTransito = null;
    this.pistas = this.actual.pistas;
    this.finLectura = this.actual.fin;
    this.velocidad = this.actual.velocidad;
    this.tono = this.actual.tono;
    this.actual = null;
  }

  /** Momento 1 del cambio: la lectura pasa a la canción siguiente (lo ya leído sigue sonando). */
  private empezarALeerLaSiguiente(eraDirecto: boolean): void {
    const nueva = this.siguiente!;
    this.siguiente = null;
    this.actual = { pistas: this.pistas, fin: this.finLectura, velocidad: this.velocidad, tono: this.tono };
    this.pistas = nueva.pistas;
    this.finLectura = nueva.fin;
    this.velocidad = nueva.velocidad;
    this.tono = nueva.tono;
    for (const [id, frames] of Object.entries(nueva.fuentes)) this.framesDeFuente.set(id, frames);
    this.lectura = 0;
    this.enTransito = nueva;
    // Todas las pistas de la canción nueva deben arrancar alineadas. Si había estirador se
    // descarta su cola interna (unos milisegundos del final, normalmente ya en silencio).
    let pendientes = 0;
    for (let p = 0; p < MAX_PISTAS; p++) {
      if (p < this.actual.pistas.length) pendientes = Math.max(pendientes, this.colas[p].frames);
      else this.colas[p].vaciar();
    }
    for (let p = 0; p < MAX_PISTAS; p++) {
      this.colas[p].meterSilencio(pendientes - this.colas[p].frames);
      if (!eraDirecto || !this.sinProcesar()) {
        const estirador = this.estiradores[p];
        estirador.clear();
        estirador.inputBuffer.clear();
        estirador.outputBuffer.clear();
      }
    }
    this.posicionDeCambio = this.posicion + pendientes * this.velocidadSalida;
  }

  private buscarPulso(): void {
    let a = 0;
    let b = this.pulsos.length;
    while (a < b) {
      const medio = (a + b) >> 1;
      if (this.pulsos[medio] < this.posicion) a = medio + 1;
      else b = medio;
    }
    this.siguientePulso = a;
  }

  /** ¿Hace falta el estirador? A velocidad y tono originales el audio pasa bit a bit. */
  private sinProcesar(): boolean {
    if (this.velocidad !== 1 || this.tono !== 0) return false;
    for (const pista of this.pistas) if (pista.tono !== 0) return false;
    return true;
  }

  /**
   * Monta en `destino` (entrelazado) los frames [desde, desde+n) de una pista.
   * Devuelve false, sin efectos secundarios, si falta algún fragmento por llegar.
   */
  private leer(pista: PistaProcesador, desde: number, n: number, destino: Float32Array): boolean {
    destino.fill(0, 0, n * 2);
    for (const clip of pista.clips) {
      const a = Math.max(desde, clip.inicio);
      const b = Math.min(desde + n, clip.inicio + clip.duracion);
      if (b <= a) continue;
      const total = this.framesDeFuente.get(clip.fuenteId) ?? 0;
      const mapa = this.fragmentos.get(clip.fuenteId);
      const entrada = Math.max(clip.fundidoEntrada, FUNDIDO_MINIMO);
      const salida = Math.max(clip.fundidoSalida, FUNDIDO_MINIMO);
      let f = a;
      while (f < b) {
        const enFuente = clip.desplazamiento + (f - clip.inicio);
        if (enFuente >= total) break; // más allá del final del archivo: silencio
        const indice = enFuente >> BITS_FRAGMENTO;
        const dentro = enFuente & (FRAMES_FRAGMENTO - 1);
        const datos = mapa?.get(indice);
        if (!datos) {
          const clave = `${clip.fuenteId}:${indice}`;
          if (!this.pedidos.has(clave)) {
            this.pedidos.add(clave);
            this.enviar({ tipo: "falta", fuenteId: clip.fuenteId, indice });
          }
          return false;
        }
        const cuantos = Math.min(b - f, (datos.length >> 1) - dentro);
        if (cuantos <= 0) break;
        let salidaIdx = (f - desde) * 2;
        let origenIdx = dentro * 2;
        let relativo = f - clip.inicio;
        for (let i = 0; i < cuantos; i++, relativo++) {
          let g = clip.ganancia * ESCALA;
          if (relativo < entrada) g *= relativo / entrada;
          const resto = clip.duracion - 1 - relativo;
          if (resto < salida) g *= resto / salida;
          destino[salidaIdx++] += datos[origenIdx++] * g;
          destino[salidaIdx++] += datos[origenIdx++] * g;
        }
        f += cuantos;
      }
    }
    return true;
  }

  /** Lee un bloque de todas las pistas y lo deja listo en sus colas. False si hay que esperar. */
  private alimentar(directo: boolean): boolean {
    if (this.siguiente && !this.bucle && this.lectura >= this.finLectura) {
      this.empezarALeerLaSiguiente(directo);
      directo = this.sinProcesar();
    }
    let n = BLOQUE;
    if (this.bucle && this.lectura < this.bucle.fin) n = Math.min(n, this.bucle.fin - this.lectura);
    // Con una canción encolada se lee justo hasta el final, para empalmar en la muestra exacta.
    else if (this.siguiente && this.lectura < this.finLectura) n = Math.min(n, this.finLectura - this.lectura);
    const pistas = this.pistas.length;
    for (let p = 0; p < pistas; p++) {
      if (!this.leer(this.pistas[p], this.lectura, n, this.temporales[p])) return false;
    }
    for (let p = 0; p < pistas; p++) {
      if (directo) {
        this.colas[p].meter(this.temporales[p], n);
        continue;
      }
      const estirador = this.estiradores[p];
      estirador.tempo = this.velocidad;
      estirador.pitchSemitones = this.tono + this.pistas[p].tono;
      estirador.inputBuffer.putSamples(this.temporales[p], 0, n);
      estirador.process();
      const listos = estirador.outputBuffer.frameCount;
      if (listos > 0) {
        if (this.traspaso.length < listos * 2) this.traspaso = new Float32Array(listos * 4);
        estirador.outputBuffer.receiveSamples(this.traspaso, listos);
        this.colas[p].meter(this.traspaso, listos);
      }
    }
    this.lectura += n;
    if (this.bucle && this.lectura >= this.bucle.fin && this.lectura - n < this.bucle.fin) {
      this.lectura = this.bucle.inicio;
    }
    return true;
  }

  private programarClic(retardo: number, fuerte: boolean): void {
    this.clics.push({ retardo: Math.max(0, Math.round(retardo)), edad: 0, frecuencia: fuerte ? 1760 : 1175 });
  }

  private pintarClics(izquierda: Float32Array, derecha: Float32Array): void {
    const duracion = Math.round(sampleRate * 0.06);
    for (let c = this.clics.length - 1; c >= 0; c--) {
      const clic = this.clics[c];
      for (let f = 0; f < CUANTO; f++) {
        if (clic.retardo > 0) {
          clic.retardo--;
          continue;
        }
        if (clic.edad >= duracion) break;
        const t = clic.edad / sampleRate;
        const muestra = Math.sin(2 * Math.PI * clic.frecuencia * t) * Math.exp(-t * 70) * 0.9;
        izquierda[f] += muestra;
        derecha[f] += muestra;
        clic.edad++;
      }
      if (clic.edad >= duracion) this.clics.splice(c, 1);
    }
  }

  private informar(): void {
    this.cuantosDesdeInforme = 0;
    this.enviar({
      tipo: "posicion",
      posicion: this.posicion,
      estado: this.estado,
      // Número del clic de cuenta que acaba de sonar (1, 2, 3…); 0 fuera de la cuenta.
      cuenta: this.estado === "cuenta" ? this.cuentaTotal - this.cuentaRestante : 0,
      esperando: this.esperando,
    });
  }

  process(_entradas: Float32Array[][], salidas: Float32Array[][]): boolean {
    const salidaClics = salidas[salidas.length - 1];

    if (this.estado === "cuenta") {
      // Cuenta regresiva: clics al tempo de la canción antes de arrancar.
      if (this.cuentaHastaClic < CUANTO) {
        if (this.cuentaRestante <= 0) {
          this.estado = "reproduciendo";
        } else {
          this.programarClic(this.cuentaHastaClic, this.cuentaRestante % this.compas === 0);
          this.cuentaRestante--;
          this.cuentaHastaClic += this.cuentaIntervalo;
          this.informar();
        }
      }
      this.cuentaHastaClic -= CUANTO;
    }

    if (this.estado === "reproduciendo") {
      let intentos = 0;
      let faltan = true;
      this.esperando = false;
      while (intentos++ < MAX_ALIMENTACIONES) {
        faltan = false;
        for (let p = 0; p < this.pistas.length; p++) if (this.colas[p].frames < CUANTO) faltan = true;
        if (!faltan) break;
        if (!this.alimentar(this.sinProcesar())) {
          this.esperando = true;
          break;
        }
      }
      if (!faltan || this.pistas.length === 0) {
        // Durante un cambio de canción aún pueden quedar pistas de la anterior terminando de sonar.
        const sonando = Math.max(this.pistas.length, this.actual ? this.actual.pistas.length : 0);
        for (let p = 0; p < sonando; p++) {
          if (this.colas[p].frames >= CUANTO) this.colas[p].sacar(salidas[p][0], salidas[p][1], CUANTO);
        }
        const avance = CUANTO * this.velocidadSalida;
        if (this.metronomo) {
          const hasta = this.posicion + avance;
          while (this.siguientePulso < this.pulsos.length && this.pulsos[this.siguientePulso] < hasta) {
            const retardo = (this.pulsos[this.siguientePulso] - this.posicion) / this.velocidadSalida;
            this.programarClic(retardo, this.fuertes[this.siguientePulso] === 1);
            this.siguientePulso++;
          }
        }
        this.posicion += avance;
        if (this.bucle && this.posicion >= this.bucle.fin) {
          this.posicion = this.bucle.inicio + (this.posicion - this.bucle.fin);
          this.buscarPulso();
        } else if (this.enTransito && this.posicion >= this.posicionDeCambio) {
          // Momento 2 del cambio: el oyente entra en la canción nueva.
          this.posicion = (this.posicion - this.posicionDeCambio) * (this.enTransito.velocidad / this.velocidadSalida);
          this.fin = this.enTransito.fin;
          this.pulsos = this.enTransito.pulsos;
          this.fuertes = this.enTransito.fuertes;
          this.velocidadSalida = this.enTransito.velocidad;
          this.enTransito = null;
          this.actual = null;
          this.buscarPulso();
          this.enviar({ tipo: "cambio" });
          this.informar();
        } else if (this.posicion >= this.fin && !this.enTransito) {
          this.estado = "detenido";
          this.resincronizar(0);
          this.informar();
          this.enviar({ tipo: "fin" });
        }
      }
    }

    if (this.clics.length > 0 && salidaClics) this.pintarClics(salidaClics[0], salidaClics[1]);
    if (++this.cuantosDesdeInforme >= 10 && this.estado !== "detenido") this.informar();
    return true;
  }
}

registerProcessor("falab-procesador", ProcesadorFalab);
