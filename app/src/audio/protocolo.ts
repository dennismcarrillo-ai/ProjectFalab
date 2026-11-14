/** Mensajes entre el hilo principal y el procesador de audio (AudioWorklet). */

/** Cada fragmento de fuente tiene 2^17 frames (~3 s a 44,1 kHz) en PCM de 16 bits. */
export const BITS_FRAGMENTO = 17;
export const FRAMES_FRAGMENTO = 1 << BITS_FRAGMENTO;
export const MAX_PISTAS = 12;
export const FRECUENCIA = 44100;

/** Clip expresado en frames enteros, tal como lo consume el procesador. */
export interface ClipProcesador {
  fuenteId: string;
  inicio: number;
  desplazamiento: number;
  duracion: number;
  ganancia: number; // lineal
  fundidoEntrada: number;
  fundidoSalida: number;
}

export interface PistaProcesador {
  clips: ClipProcesador[];
  tono: number;
}

/** Todo lo que el procesador necesita para reproducir una canción entera. */
export interface Montaje {
  pistas: PistaProcesador[];
  fin: number;
  fuentes: Record<string, number>;
  velocidad: number;
  tono: number;
  pulsos: Float64Array;
  fuertes: Uint8Array;
}

export type MensajeAlProcesador =
  | { tipo: "proyecto"; pistas: PistaProcesador[]; fin: number; fuentes: Record<string, number> }
  /** Show continuo: canción que debe empezar, sin cortes, cuando acabe la actual (null = ninguna). */
  | { tipo: "encolar"; montaje: Montaje | null }
  | { tipo: "pulsos"; frames: Float64Array; fuertes: Uint8Array }
  | { tipo: "fragmento"; fuenteId: string; indice: number; datos: Int16Array }
  | { tipo: "descartar"; fuenteId: string; indices: number[] }
  | { tipo: "reproducir"; desde: number; clicsDeCuenta: number; intervaloDeCuenta: number; compas: number }
  | { tipo: "pausar" }
  | { tipo: "saltar"; posicion: number }
  | {
      tipo: "parametros";
      velocidad: number;
      tono: number;
      metronomo: boolean;
      bucle: { inicio: number; fin: number } | null;
    };

export type EstadoTransporte = "detenido" | "cuenta" | "reproduciendo";

export type MensajeDelProcesador =
  | { tipo: "posicion"; posicion: number; estado: EstadoTransporte; cuenta: number; esperando: boolean }
  | { tipo: "falta"; fuenteId: string; indice: number }
  /**
   * La reproducción acaba de arrancar (tras la cuenta regresiva, si la hay). `cuadro` es el
   * reloj de muestras del contexto de audio: permite alinear una grabación con la canción.
   */
  | { tipo: "arranque"; cuadro: number; posicion: number }
  /** La canción encolada ha empezado a sonar. */
  | { tipo: "cambio" }
  | { tipo: "fin" };

/** Mensajes del capturador de micrófono (segundo procesador del mismo AudioWorklet). */
export type MensajeDelGrabador = {
  tipo: "trozo";
  /** Reloj de muestras del contexto en la primera muestra del trozo. */
  cuadro: number;
  /** PCM de 16 bits estéreo entrelazado. */
  datos: Int16Array;
};
