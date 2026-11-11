/**
 * Motor de audio del mezclador (hilo principal).
 *
 * Grafo por pista, todo con nodos nativos de Web Audio (procesan en C++ fuera del hilo de la UI):
 *
 *   procesador ─salida i─► EQ graves (estante) ─► EQ medios (campana) ─► EQ agudos (estante)
 *              ─► fader (ganancia) ─► paneo ─► maestro ─► altavoces
 *
 * El procesador (AudioWorklet) entrega cada pista ya montada, estirada y transpuesta. Los
 * fragmentos de audio se le van enviando bajo demanda desde aquí (ver `planificarFragmentos`).
 */
import { motor } from "../servicios/motor";
import type { Proyecto, Pulso } from "../tipos";
import {
  BITS_FRAGMENTO, FRAMES_FRAGMENTO, FRECUENCIA, MAX_PISTAS,
  type EstadoTransporte, type MensajeAlProcesador, type MensajeDelProcesador, type PistaProcesador,
} from "./protocolo";

/** Segundos de proyecto que se mantienen cargados por delante y por detrás del cursor. */
const VENTANA_DELANTE = 18;
const VENTANA_DETRAS = 3;
const DESCARGAS_SIMULTANEAS = 6;
const SUAVIZADO = 0.015;

const dbALineal = (db: number): number => Math.pow(10, db / 20);
const aFrames = (segundos: number): number => Math.round(segundos * FRECUENCIA);

interface Canal {
  graves: BiquadFilterNode;
  medios: BiquadFilterNode;
  agudos: BiquadFilterNode;
  fader: GainNode;
  paneo: StereoPannerNode;
}

export interface EstadoReproduccion {
  estado: EstadoTransporte;
  /** Segundos de proyecto. */
  posicion: number;
  cuenta: number;
  esperando: boolean;
}

export class MotorAudio {
  private contexto: AudioContext | null = null;
  private nodo: AudioWorkletNode | null = null;
  private canales: Canal[] = [];
  private maestro: GainNode | null = null;
  private clics: GainNode | null = null;

  private proyecto: Proyecto | null = null;
  private pulsos: Pulso[] = [];
  private bucle: { inicio: number; fin: number } | null = null;
  private firmaMontaje = "";

  /** Fragmentos que ya tiene el procesador y los que están en camino ("fuente:indice"). */
  private cargados = new Set<string>();
  private enCurso = new Set<string>();
  private cola: string[] = [];

  estado: EstadoReproduccion = { estado: "detenido", posicion: 0, cuenta: 0, esperando: false };
  alCambiar: (estado: EstadoReproduccion) => void = () => {};

  /** Crea el contexto de audio. Debe llamarse tras un gesto del usuario (política de los navegadores). */
  async iniciar(): Promise<void> {
    if (this.contexto) {
      if (this.contexto.state === "suspended") await this.contexto.resume();
      return;
    }
    // Misma frecuencia que los stems: el procesador no necesita remuestrear nada.
    const contexto = new AudioContext({ sampleRate: FRECUENCIA, latencyHint: "interactive" });
    await contexto.audioWorklet.addModule("/worklets/falab-procesador.js");
    const nodo = new AudioWorkletNode(contexto, "falab-procesador", {
      numberOfInputs: 0,
      numberOfOutputs: MAX_PISTAS + 1,
      outputChannelCount: new Array(MAX_PISTAS + 1).fill(2),
    });
    const maestro = contexto.createGain();
    maestro.connect(contexto.destination);
    for (let i = 0; i < MAX_PISTAS; i++) {
      const graves = new BiquadFilterNode(contexto, { type: "lowshelf" });
      const medios = new BiquadFilterNode(contexto, { type: "peaking" });
      const agudos = new BiquadFilterNode(contexto, { type: "highshelf" });
      const fader = contexto.createGain();
      const paneo = new StereoPannerNode(contexto, { channelCount: 2, channelCountMode: "explicit" });
      nodo.connect(graves, i).connect(medios).connect(agudos).connect(fader).connect(paneo).connect(maestro);
      this.canales.push({ graves, medios, agudos, fader, paneo });
    }
    // El metrónomo va directo a la salida: no le afecta el volumen maestro ni la mezcla.
    const clics = contexto.createGain();
    nodo.connect(clics, MAX_PISTAS).connect(contexto.destination);

    nodo.port.onmessage = (evento: MessageEvent<MensajeDelProcesador>) => this.recibir(evento.data);
    this.contexto = contexto;
    this.nodo = nodo;
    this.maestro = maestro;
    this.clics = clics;
    if (this.proyecto) {
      const proyecto = this.proyecto;
      this.firmaMontaje = "";
      this.cargados.clear();
      this.actualizar(proyecto);
      this.fijarPulsos(this.pulsos);
    }
  }

  private enviar(mensaje: MensajeAlProcesador, transferibles: Transferable[] = []): void {
    this.nodo?.port.postMessage(mensaje, transferibles);
  }

  private recibir(mensaje: MensajeDelProcesador): void {
    if (mensaje.tipo === "posicion") {
      this.estado = {
        estado: mensaje.estado,
        posicion: mensaje.posicion / FRECUENCIA,
        cuenta: mensaje.cuenta,
        esperando: mensaje.esperando,
      };
      this.alCambiar(this.estado);
      this.planificarFragmentos();
    } else if (mensaje.tipo === "falta") {
      this.pedir(`${mensaje.fuenteId}:${mensaje.indice}`, true);
    }
  }

  /** Sincroniza el motor con el proyecto: mezcla (siempre) y montaje de clips (solo si cambió). */
  actualizar(proyecto: Proyecto): void {
    const anterior = this.proyecto;
    this.proyecto = proyecto;
    if (anterior && anterior.id !== proyecto.id) {
      // Otro proyecto: el procesador debe olvidar todos los fragmentos del anterior.
      for (const fuente of anterior.fuentes) {
        const indices = [...this.cargados].filter((c) => c.startsWith(fuente.id + ":")).map((c) => Number(c.split(":")[1]));
        this.enviar({ tipo: "descartar", fuenteId: fuente.id, indices });
      }
      this.cargados.clear();
      this.enCurso.clear();
      this.cola = [];
      this.firmaMontaje = "";
      this.bucle = null;
    }
    if (!this.contexto) return;
    const ahora = this.contexto.currentTime;
    const haySolo = proyecto.pistas.some((p) => p.solo);
    proyecto.pistas.slice(0, MAX_PISTAS).forEach((pista, i) => {
      const canal = this.canales[i];
      const audible = haySolo ? pista.solo : !pista.silencio;
      canal.fader.gain.setTargetAtTime(audible ? dbALineal(pista.volumen) : 0, ahora, SUAVIZADO);
      canal.paneo.pan.setTargetAtTime(pista.paneo, ahora, SUAVIZADO);
      canal.graves.frequency.setTargetAtTime(pista.eq.bajos.frecuencia, ahora, SUAVIZADO);
      canal.graves.gain.setTargetAtTime(pista.eq.bajos.ganancia, ahora, SUAVIZADO);
      canal.medios.frequency.setTargetAtTime(pista.eq.medios.frecuencia, ahora, SUAVIZADO);
      canal.medios.gain.setTargetAtTime(pista.eq.medios.ganancia, ahora, SUAVIZADO);
      canal.medios.Q.setTargetAtTime(pista.eq.medios.q ?? 1, ahora, SUAVIZADO);
      canal.agudos.frequency.setTargetAtTime(pista.eq.agudos.frecuencia, ahora, SUAVIZADO);
      canal.agudos.gain.setTargetAtTime(pista.eq.agudos.ganancia, ahora, SUAVIZADO);
    });
    this.maestro!.gain.setTargetAtTime(dbALineal(proyecto.volumenMaestro), ahora, SUAVIZADO);
    this.clics!.gain.setTargetAtTime(dbALineal(proyecto.metronomo.volumen), ahora, SUAVIZADO);
    this.enviarParametros();

    // El montaje solo se reenvía si cambió algo que afecte a QUÉ audio suena y CUÁNDO.
    const pistas: PistaProcesador[] = proyecto.pistas.slice(0, MAX_PISTAS).map((pista) => ({
      tono: pista.tono,
      clips: pista.clips.map((clip) => {
        const inicio = aFrames(clip.inicio);
        return {
          fuenteId: clip.fuenteId,
          inicio,
          desplazamiento: aFrames(clip.desplazamiento),
          duracion: aFrames(clip.inicio + clip.duracion) - inicio,
          ganancia: dbALineal(clip.ganancia),
          fundidoEntrada: aFrames(clip.fundidoEntrada),
          fundidoSalida: aFrames(clip.fundidoSalida),
        };
      }),
    }));
    const firma = JSON.stringify(pistas);
    if (firma !== this.firmaMontaje) {
      this.firmaMontaje = firma;
      const fin = Math.max(0, ...pistas.flatMap((p) => p.clips.map((c) => c.inicio + c.duracion)));
      const fuentes = Object.fromEntries(proyecto.fuentes.map((f) => [f.id, f.frames]));
      this.planificarFragmentos();
      this.enviar({ tipo: "proyecto", pistas, fin, fuentes });
    }
  }

  private enviarParametros(): void {
    const p = this.proyecto;
    if (!p) return;
    this.enviar({
      tipo: "parametros",
      velocidad: p.velocidad,
      tono: p.tono,
      metronomo: p.metronomo.activo,
      bucle: this.bucle ? { inicio: aFrames(this.bucle.inicio), fin: aFrames(this.bucle.fin) } : null,
    });
  }

  fijarPulsos(pulsos: Pulso[]): void {
    this.pulsos = pulsos;
    const frames = new Float64Array(pulsos.map((p) => p.t * FRECUENCIA));
    const fuertes = new Uint8Array(pulsos.map((p) => (p.pulso === 1 ? 1 : 0)));
    this.enviar({ tipo: "pulsos", frames, fuertes });
  }

  fijarBucle(bucle: { inicio: number; fin: number } | null): void {
    this.bucle = bucle;
    this.enviarParametros();
    this.planificarFragmentos();
  }

  /** BPM de la canción en el instante `t`, según el mapa de pulsos. */
  private bpmEn(t: number): number {
    let bpm = this.proyecto?.bpm ?? 120;
    for (const pulso of this.pulsos) {
      if (pulso.t > t) break;
      bpm = pulso.bpm;
    }
    return bpm;
  }

  async reproducir(): Promise<void> {
    await this.iniciar();
    const p = this.proyecto;
    if (!p) return;
    const desde = this.estado.posicion;
    // La cuenta regresiva va al tempo que el oyente va a escuchar (tempo local × velocidad).
    const clics = p.metronomo.cuentaRegresiva * p.compas;
    const intervalo = (60 / (this.bpmEn(desde) * p.velocidad)) * FRECUENCIA;
    this.planificarFragmentos();
    this.enviar({
      tipo: "reproducir", desde: aFrames(desde), clicsDeCuenta: clics, intervaloDeCuenta: intervalo, compas: p.compas,
    });
  }

  pausar(): void {
    this.enviar({ tipo: "pausar" });
  }

  saltar(segundos: number): void {
    const posicion = Math.max(0, segundos);
    this.estado = { ...this.estado, posicion };
    this.alCambiar(this.estado);
    this.planificarFragmentos();
    this.enviar({ tipo: "saltar", posicion: aFrames(posicion) });
  }

  // ------------------------------------------------------------ carga de audio por fragmentos

  /** Calcula qué fragmentos hacen falta alrededor del cursor, pide los que falten y suelta el resto. */
  private planificarFragmentos(): void {
    const p = this.proyecto;
    if (!p || !this.nodo) return;
    const necesarios = new Set<string>();
    const anotar = (desde: number, hasta: number) => {
      for (const pista of p.pistas) {
        for (const clip of pista.clips) {
          const a = Math.max(desde, clip.inicio);
          const b = Math.min(hasta, clip.inicio + clip.duracion);
          if (b <= a) continue;
          const primero = aFrames(clip.desplazamiento + (a - clip.inicio)) >> BITS_FRAGMENTO;
          const ultimo = aFrames(clip.desplazamiento + (b - clip.inicio)) >> BITS_FRAGMENTO;
          for (let i = primero; i <= ultimo; i++) necesarios.add(`${clip.fuenteId}:${i}`);
        }
      }
    };
    const cursor = this.estado.posicion;
    anotar(cursor - VENTANA_DETRAS, cursor + VENTANA_DELANTE * Math.max(1, p.velocidad));
    if (this.bucle) anotar(this.bucle.inicio, this.bucle.inicio + VENTANA_DELANTE / 2);

    for (const clave of necesarios) this.pedir(clave, false);
    // Lo que queda lejos del cursor se libera: así la memoria no crece con la duración del tema.
    const sobrantes = new Map<string, number[]>();
    for (const clave of this.cargados) {
      if (necesarios.has(clave)) continue;
      const [fuenteId, indice] = clave.split(":");
      if (!sobrantes.has(fuenteId)) sobrantes.set(fuenteId, []);
      sobrantes.get(fuenteId)!.push(Number(indice));
      this.cargados.delete(clave);
    }
    for (const [fuenteId, indices] of sobrantes) this.enviar({ tipo: "descartar", fuenteId, indices });
  }

  private pedir(clave: string, urgente: boolean): void {
    if (this.cargados.has(clave) || this.enCurso.has(clave)) return;
    const enCola = this.cola.indexOf(clave);
    if (enCola >= 0) {
      if (!urgente) return;
      this.cola.splice(enCola, 1);
    }
    if (urgente) this.cola.unshift(clave);
    else this.cola.push(clave);
    this.bombear();
  }

  private bombear(): void {
    const p = this.proyecto;
    while (p && this.enCurso.size < DESCARGAS_SIMULTANEAS && this.cola.length > 0) {
      const clave = this.cola.shift()!;
      const [fuenteId, indiceTexto] = clave.split(":");
      const indice = Number(indiceTexto);
      this.enCurso.add(clave);
      motor
        .pcm(p.id, fuenteId, indice * FRAMES_FRAGMENTO, FRAMES_FRAGMENTO)
        .then((datos) => {
          if (this.proyecto?.id !== p.id) return; // llegó tarde: ya hay otro proyecto abierto
          this.cargados.add(clave);
          this.enviar({ tipo: "fragmento", fuenteId, indice, datos }, [datos.buffer]);
        })
        .catch((error) => console.error("No se pudo cargar el fragmento", clave, error))
        .finally(() => {
          this.enCurso.delete(clave);
          this.bombear();
        });
    }
  }

  /** Megabytes de audio que tiene cargados el reproductor ahora mismo. */
  get memoriaMB(): number {
    return (this.cargados.size * FRAMES_FRAGMENTO * 4) / (1024 * 1024);
  }
}

export const motorAudio = new MotorAudio();
