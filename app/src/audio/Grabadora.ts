/**
 * Grabación de micrófono (y, opcionalmente, de cámara) sincronizada con la canción.
 *
 * - El audio se captura en el mismo AudioWorklet y con el mismo reloj de muestras que el
 *   reproductor, así que la toma se coloca en la línea de tiempo con precisión de muestra; solo
 *   queda compensar la latencia de la tarjeta de sonido.
 * - Tanto el audio como el video viajan al motor por trozos de ~1 s y se escriben a disco al
 *   llegar: grabar diez minutos no ocupa más memoria que grabar diez segundos.
 */
import { motor } from "../servicios/motor";
import { motorAudio } from "./MotorAudio";
import { FRECUENCIA, type MensajeDelGrabador } from "./protocolo";

export interface OpcionesDeGrabacion {
  microfono: string;      // deviceId, o "" para el predeterminado
  conCamara: boolean;
  camara: string;
  /** Ajuste manual, en milisegundos, que se suma a la latencia medida. */
  ajusteLatencia: number;
}

export const OPCIONES_POR_DEFECTO: OpcionesDeGrabacion = { microfono: "", conCamara: false, camara: "", ajusteLatencia: 0 };

function aBase64(bytes: Uint8Array): string {
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}

export interface ResultadoDeGrabacion {
  pista?: string;
  video?: string;
}

export class Grabadora {
  private flujo: MediaStream | null = null;
  private fuente: MediaStreamAudioSourceNode | null = null;
  private nodo: AudioWorkletNode | null = null;
  private camara: MediaRecorder | null = null;
  private idProyecto = "";
  private sesionAudio = "";
  private sesionVideo = "";
  /** Trozos capturados antes de saber en qué muestra arrancó la canción (solo los últimos). */
  private enEspera: MensajeDelGrabador[] = [];
  private arranque: { cuadro: number; posicion: number } | null = null;
  private envios: Promise<unknown> = Promise.resolve();
  private latencia = 0;
  private fallo: Error | null = null;
  /** Flujo de la cámara, para mostrar la vista previa mientras se graba. */
  vistaPrevia: MediaStream | null = null;

  /** Pide permiso, abre el micrófono (y la cámara) y deja la captura corriendo a la espera del arranque. */
  async preparar(idProyecto: string, opciones: OpcionesDeGrabacion): Promise<void> {
    await motorAudio.iniciar();
    const contexto = motorAudio.contextoDeAudio!;
    this.idProyecto = idProyecto;
    this.flujo = await navigator.mediaDevices.getUserMedia({
      // Sin procesado de llamada: queremos el sonido del instrumento tal cual.
      audio: {
        deviceId: opciones.microfono ? { exact: opciones.microfono } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
      video: opciones.conCamara
        ? { deviceId: opciones.camara ? { exact: opciones.camara } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
    });
    const pistaDeAudio = this.flujo.getAudioTracks()[0];
    // Lo grabado llega tarde por dos motivos: lo que tarda en sonar la canción (salida) y lo que
    // tarda en entrar el micrófono (entrada). Se resta todo para que la toma quede en su sitio.
    const entrada = (pistaDeAudio.getSettings() as { latency?: number }).latency ?? 0.01;
    this.latencia = (contexto.outputLatency || 0) + (contexto.baseLatency || 0) + entrada + opciones.ajusteLatencia / 1000;

    this.sesionAudio = (await motor.grabacion.iniciar(idProyecto, "audio")).sesion;
    this.fuente = contexto.createMediaStreamSource(this.flujo);
    this.nodo = new AudioWorkletNode(contexto, "falab-grabador", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2 });
    this.nodo.port.onmessage = (evento: MessageEvent<MensajeDelGrabador>) => this.recibir(evento.data);
    this.fuente.connect(this.nodo);

    if (opciones.conCamara && this.flujo.getVideoTracks().length) {
      this.vistaPrevia = new MediaStream(this.flujo.getVideoTracks());
      const tipo = ["video/mp4", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
      if (!tipo) throw new Error("Este equipo no puede grabar video desde la aplicación.");
      this.sesionVideo = (await motor.grabacion.iniciar(idProyecto, "video", tipo.startsWith("video/mp4") ? "mp4" : "webm")).sesion;
      this.camara = new MediaRecorder(this.vistaPrevia, { mimeType: tipo, videoBitsPerSecond: 2_500_000 });
      this.camara.ondataavailable = (evento) => {
        if (evento.data.size === 0) return;
        const sesion = this.sesionVideo;
        this.encolar(async () => motor.grabacion.trozo(idProyecto, sesion, aBase64(new Uint8Array(await evento.data.arrayBuffer()))));
      };
    }
  }

  /** La canción ha arrancado: a partir de esa muestra, todo lo capturado es toma. */
  marcarArranque(cuadro: number, posicion: number): void {
    if (this.arranque) return;
    this.arranque = { cuadro, posicion };
    this.camara?.start(1000);
    const pendientes = this.enEspera;
    this.enEspera = [];
    for (const trozo of pendientes) this.recibir(trozo);
  }

  private recibir(trozo: MensajeDelGrabador): void {
    if (!this.arranque) {
      // Durante la cuenta regresiva solo hace falta conservar el último par de segundos.
      this.enEspera.push(trozo);
      if (this.enEspera.length > 3) this.enEspera.shift();
      return;
    }
    let datos = trozo.datos;
    const sobran = this.arranque.cuadro - trozo.cuadro; // muestras anteriores al arranque
    if (sobran >= datos.length / 2) return;
    if (sobran > 0) datos = datos.subarray(sobran * 2);
    const bytes = new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength);
    const sesion = this.sesionAudio;
    this.encolar(() => motor.grabacion.trozo(this.idProyecto, sesion, aBase64(bytes)));
  }

  /** Los trozos se envían de uno en uno y en orden. */
  private encolar(tarea: () => Promise<unknown>): void {
    this.envios = this.envios.then(tarea).catch((error) => {
      this.fallo ??= error as Error;
    });
  }

  private soltarDispositivos(): void {
    this.nodo?.port.postMessage({ tipo: "parar" });
    this.fuente?.disconnect();
    this.flujo?.getTracks().forEach((pista) => pista.stop());
    this.flujo = this.fuente = this.nodo = this.vistaPrevia = null;
  }

  /** Detiene la captura y deja la toma colocada en la pista. Con `descartar`, la borra. */
  async terminar(idPista: string | undefined, nombre: string, descartar = false): Promise<ResultadoDeGrabacion> {
    const camara = this.camara;
    if (camara && camara.state !== "inactive") {
      await new Promise<void>((resolver) => {
        camara.onstop = () => resolver();
        camara.stop();
      });
    }
    this.nodo?.port.postMessage({ tipo: "parar" });
    await new Promise((resolver) => setTimeout(resolver, 60)); // último trozo del capturador
    this.soltarDispositivos();
    await this.envios;
    const sinToma = descartar || !this.arranque || this.fallo !== null;
    const resultado: ResultadoDeGrabacion = {};
    try {
      const audio = await motor.grabacion.terminar(this.idProyecto, this.sesionAudio, sinToma
        ? { descartar: true }
        : { inicio: this.arranque!.posicion - this.latencia, pista: idPista, nombre });
      resultado.pista = audio.pista;
    } finally {
      if (this.sesionVideo) {
        const video = await motor.grabacion.terminar(this.idProyecto, this.sesionVideo, sinToma || !camara
          ? { descartar: true }
          : { tipo: "video", inicio: this.arranque!.posicion });
        resultado.video = video.video;
      }
      this.camara = null;
    }
    if (this.fallo) throw this.fallo;
    return resultado;
  }

  get latenciaMs(): number {
    return Math.round(this.latencia * 1000);
  }
  get segundosGrabados(): number {
    const contexto = motorAudio.contextoDeAudio;
    return this.arranque && contexto ? (contexto.currentTime * FRECUENCIA - this.arranque.cuadro) / FRECUENCIA : 0;
  }
}
