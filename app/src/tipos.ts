/** Modelo de datos compartido con el motor Python (proyecto.json). Tiempos en segundos. */

export interface Clip {
  id: string;
  /** Archivo de audio del que se lee (un stem). Varios clips pueden compartir fuente. */
  fuenteId: string;
  /** Posición del clip en la línea de tiempo. */
  inicio: number;
  /** Punto de la fuente donde empieza a leerse. */
  desplazamiento: number;
  duracion: number;
  /** Ganancia propia del clip en dB. */
  ganancia: number;
  fundidoEntrada: number;
  fundidoSalida: number;
}

export interface BandaEQ {
  frecuencia: number;
  ganancia: number;
  q?: number;
}

export interface Ecualizador {
  bajos: BandaEQ;
  medios: BandaEQ;
  agudos: BandaEQ;
}

export interface Pista {
  id: string;
  nombre: string;
  instrumento: string;
  color: string;
  /** Fader en dB. */
  volumen: number;
  /** De -1 (izquierda) a 1 (derecha). */
  paneo: number;
  silencio: boolean;
  solo: boolean;
  /** Transposición propia de la pista, en semitonos (se suma a la global). */
  tono: number;
  /** Envío a la reverb, de 0 (seca) a 1. */
  reverb?: number;
  eq: Ecualizador;
  clips: Clip[];
}

/** Toma de video grabada con la cámara. */
export interface TomaDeVideo {
  id: string;
  nombre: string;
  archivo: string;
  /** Instante de la canción en que empieza la imagen. */
  inicio: number;
}

export interface Fuente {
  id: string;
  archivo: string;
  frames: number;
  canales: number;
}

export interface Metronomo {
  activo: boolean;
  volumen: number;
  /** Compases de cuenta regresiva antes de reproducir (0 = sin cuenta). */
  cuentaRegresiva: number;
  /** Tiempos por compás de la cuenta (1–6). Si falta, el compás del proyecto. */
  cuentaTiempos?: number;
  /** La cuenta se marca a negras o a corcheas. */
  cuentaFigura?: "negra" | "corchea";
}

export interface Proyecto {
  version: number;
  id: string;
  nombre: string;
  creado: string;
  modificado: string;
  frecuenciaMuestreo: number;
  duracion: number;
  medioOriginal: { ruta: string; nombre: string; tieneVideo: boolean };
  bpm: number;
  compas: number;
  /** 1 = velocidad original. Cambiarla no altera el tono. */
  velocidad: number;
  /** Transposición global en semitonos. Cambiarla no altera la velocidad. */
  tono: number;
  volumenMaestro: number;
  metronomo: Metronomo;
  fuentes: Fuente[];
  pistas: Pista[];
  videos?: TomaDeVideo[];
  avisos: string[];
}

export interface Tonalidad {
  tonica: number;
  modo: string;
  bemoles: boolean;
  nombre: string;
}

export interface ResumenProyecto {
  id: string;
  nombre: string;
  modificado: string;
  duracion: number;
  bpm: number;
  pistas: number;
  /** Tamaño en disco, en bytes. */
  peso: number;
  archivos: number;
  tieneVideo: boolean;
  tonalidad: Tonalidad | null;
  /** Tonalidad del arranque de la canción (la que cuenta al ordenar un popurrí). */
  tonalidadInicial: Tonalidad | null;
}

export type OrdenPlaylist = "manual" | "alfabetico" | "duracion" | "bpm" | "tonalidad" | "quintas";

/** Una playlist es una lista ordenada de identificadores de proyecto. */
export interface Playlist {
  id: string;
  nombre: string;
  orden: OrdenPlaylist;
  proyectos: string[];
}

export type DetalleAcordes = "normal" | "alto" | "maximo";

export interface Pulso {
  t: number;
  bpm: number;
  compas: number;
  pulso: number;
  /** Tiempos del compás al que pertenece (solo si una sección cambió el compás). */
  tiempos?: number;
}

/** Marcador de ensayo: una parte de la canción (Intro, Verso, Coro…). */
export interface Seccion {
  inicio: number;
  fin: number;
  nombre: string;
  /** Tiempos por compás desde esta sección en adelante (si cambia). */
  compas?: number;
}

/** Acción del directo que puede dispararse con un pedal. */
export type AccionPedal = "reproducir" | "siguiente" | "anterior";
export type Disparador =
  | { tipo: "tecla"; codigo: string }
  | { tipo: "midi"; estado: number; dato1: number };
export type AsignacionPedal = Partial<Record<AccionPedal, Disparador[]>>;

export interface Acorde {
  inicio: number;
  fin: number;
  raiz: number;
  calidad: string;
  bajo: number | null;
  nombre: string;
  /** El bajo mantiene esta nota mientras la armonía cambia por encima (nota pedal). */
  pedal?: boolean;
}

/** Lo que toca el bajo, con independencia de los acordes. */
export interface TramoDeBajo {
  inicio: number;
  fin: number;
  nota: number;
  nombre: string;
}

export interface Ostinato {
  inicio: number;
  fin: number;
  patron: number[];
  repeticiones: number;
  nombre: string;
}

export interface Nota {
  inicio: number;
  fin: number;
  tono: number;
  velocidad: number;
}

export interface Palabra {
  inicio: number;
  fin: number;
  texto: string;
}

export interface SegmentoLetra {
  inicio: number;
  fin: number;
  texto: string;
  palabras: Palabra[];
}

export interface LineaCancionero {
  tipo: "letra" | "instrumental";
  inicio: number;
  fin: number;
  texto: string;
  acordes: { columna: number; nombre: string; t: number }[];
}

export type Cifrado = "estandar" | "jazz" | "latino";

export interface Analisis {
  mapaTempo: { bpm: number; compas: number; pulsos: Pulso[] };
  secciones: Seccion[];
  tonalidad: Tonalidad;
  acordes: Acorde[];
  lineaBajo: TramoDeBajo[];
  ostinatos: Ostinato[];
  letras: { idioma: string | null; segmentos: SegmentoLetra[] };
  cancionero: LineaCancionero[];
  pistasConNotas: string[];
  detalleAcordes: DetalleAcordes;
  letraEditada: boolean;
}

export interface Trabajo {
  id: string;
  tipo: string;
  estado: "pendiente" | "ejecutando" | "completado" | "error" | "cancelado";
  progreso: number;
  etapa: string;
  resultado: any;
  error: string | null;
}

export interface Salud {
  estado: string;
  version: string;
  carpetaDatos: string;
  componentes: { ffmpeg: boolean; rubberband: boolean; demucs: boolean; basicPitch: boolean; whisper: boolean };
}

/** Fragmentos copiados: referencias a audio, nunca muestras. */
export interface Portapapeles {
  duracion: number;
  fragmentos: (Omit<Clip, "id" | "inicio"> & { relativo: number })[];
}
