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
  eq: Ecualizador;
  clips: Clip[];
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
}

export interface Acorde {
  inicio: number;
  fin: number;
  raiz: number;
  calidad: string;
  bajo: number | null;
  nombre: string;
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
  tonalidad: Tonalidad;
  acordes: Acorde[];
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
