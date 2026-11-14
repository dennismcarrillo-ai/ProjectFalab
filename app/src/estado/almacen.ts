/** Estado global de la aplicación (Zustand). */
import { create } from "zustand";
import { Grabadora, OPCIONES_POR_DEFECTO, type OpcionesDeGrabacion } from "../audio/Grabadora";
import { motorAudio, type EstadoReproduccion } from "../audio/MotorAudio";
import {
  copiarClips, copiarRango, dividir, eliminar, finDe, pegar, quitarRango,
} from "../edicion/operaciones";
import {
  motor, seguirTrabajo, type EventoMidi, type OpcionesImportar, type PeticionExportar,
} from "../servicios/motor";
import type {
  AccionPedal, Analisis, AsignacionPedal, Cifrado, Clip, DetalleAcordes, Disparador, Ecualizador, OrdenPlaylist,
  Pista, Playlist, Portapapeles, Proyecto, ResumenProyecto, Salud, Seccion, Trabajo,
} from "../tipos";
import { desplazar, ordenar } from "../util/biblioteca";

export type Vista = "editor" | "karaoke" | "cancionero" | "partitura";
export type Dialogo = null | "exportar" | "drive" | "estructura" | "pedal" | "grabacion";

const CLAVE_GRABACION = "falab.grabacion";
function leerOpcionesDeGrabacion(): OpcionesDeGrabacion {
  try {
    return { ...OPCIONES_POR_DEFECTO, ...JSON.parse(localStorage.getItem(CLAVE_GRABACION) ?? "{}") };
  } catch {
    return OPCIONES_POR_DEFECTO;
  }
}
const COLORES_DE_PISTA = ["#f87171", "#34d399", "#60a5fa", "#fbbf24", "#c084fc", "#f472b6"];
const MAX_PISTAS = 12;
type Montaje = Record<string, Clip[]>;

const MAX_HISTORIAL = 100;

/**
 * La posición de reproducción cambia ~30 veces por segundo: vive en su propio almacén para que
 * solo se redibujen el cursor y el karaoke, no toda la interfaz.
 */
export const usarReproduccion = create<EstadoReproduccion>(() => ({
  estado: "detenido", posicion: 0, cuenta: 0, esperando: false,
}));
motorAudio.alCambiar = (estado) => usarReproduccion.setState(estado);

interface EstadoApp {
  salud: Salud | null;
  errorMotor: string | null;
  proyectos: ResumenProyecto[];
  playlists: Playlist[];
  /** Playlist en la que se está trabajando (null = todos los proyectos). */
  playlistActiva: string | null;
  /** Orden de la vista «Todos los proyectos». */
  ordenGeneral: OrdenPlaylist;
  panelLateral: boolean;
  /** Grabación en curso: «preparando» (permisos), «esperando» (cuenta regresiva) o «grabando». */
  grabacion: null | { estado: "preparando" | "esperando" | "grabando" | "guardando"; vistaPrevia: MediaStream | null };
  opcionesDeGrabacion: OpcionesDeGrabacion;
  /** Video que se muestra en la ventana flotante («original», una toma de cámara o ninguno). */
  ventanaVideo: string | null;
  /** Panel derecho con la tablatura sincronizada. */
  panelTablatura: boolean;
  driveAutomatico: boolean;
  /** Show continuo: al acabar una canción empieza la siguiente de la lista, sin cortes. */
  showContinuo: boolean;
  pedal: AsignacionPedal;
  /** Si no es null, el próximo pedal o tecla pulsado se entrega aquí en vez de ejecutar su acción. */
  aprendiendo: ((disparador: Disparador) => void) | null;
  proyecto: Proyecto | null;
  analisis: Analisis | null;
  cifrado: Cifrado;
  vista: Vista;
  dialogo: Dialogo;

  clipsSeleccionados: string[];
  pistaActiva: string | null;
  rango: { inicio: number; fin: number } | null;
  portapapeles: Portapapeles | null;
  pasado: Montaje[];
  futuro: Montaje[];

  zoom: number; // píxeles por segundo
  iman: boolean;
  bucle: boolean;
  guardado: "guardado" | "pendiente" | "guardando" | "error";
  trabajo: (Trabajo & { titulo: string }) | null;
  aviso: { texto: string; tipo: "info" | "error"; archivos?: string[]; idProyecto?: string } | null;

  conectar(): Promise<void>;
  refrescarProyectos(): Promise<void>;
  abrir(id: string): Promise<void>;
  cerrar(): Promise<void>;
  eliminarProyecto(id: string): Promise<void>;
  importar(origen: string | File, opciones: OpcionesImportar): Promise<void>;
  crearDemo(): Promise<void>;
  exportar(peticion: PeticionExportar): Promise<void>;
  ejecutar(titulo: string, lanzar: () => Promise<Trabajo>): Promise<Trabajo | null>;
  cancelarTrabajo(): void;

  fijar(parcial: Partial<Pick<EstadoApp,
    "vista" | "dialogo" | "zoom" | "iman" | "aviso" | "pistaActiva" | "playlistActiva" | "ordenGeneral" | "panelLateral"
    | "panelTablatura" | "ventanaVideo">>): void;

  // Pistas nuevas, grabación y video
  anadirPista(): void;
  eliminarPista(id: string): void;
  importarEnPista(origen: string | File): Promise<void>;
  fijarOpcionesDeGrabacion(parcial: Partial<OpcionesDeGrabacion>): void;
  alternarGrabacion(): Promise<void>;
  eliminarToma(id: string): void;

  // Biblioteca
  crearPlaylist(nombre: string): Promise<void>;
  cambiarPlaylist(id: string, parcial: Partial<Pick<Playlist, "nombre" | "orden">>): Promise<void>;
  eliminarPlaylist(id: string): Promise<void>;
  alternarEnPlaylist(idPlaylist: string, idProyecto: string): Promise<void>;
  moverEnPlaylist(idPlaylist: string, idProyecto: string, delta: number): Promise<void>;
  /** Proyectos de la playlist activa en su orden: la «cola» de Siguiente/Anterior. */
  cola(): ResumenProyecto[];
  irA(delta: number): Promise<void>;
  exportarPaquete(id: string, destino?: string): Promise<void>;
  importarPaquete(ruta: string): Promise<void>;
  fijarDriveAutomatico(activo: boolean): Promise<void>;
  guardarLetras(lineas: { inicio: number; texto: string }[]): Promise<void>;
  recalcularAcordes(detalle: DetalleAcordes): Promise<void>;

  // Directo
  alternarShow(): void;
  /** Fija el tempo de reproducción en BPM (cambia la velocidad sin alterar el tono). */
  fijarBpm(bpm: number): void;
  guardarEstructura(secciones: Seccion[]): Promise<void>;
  detectarEstructura(): Promise<void>;
  corregirMapa(operacion: "doble" | "mitad" | "desplazar"): Promise<void>;
  generarGuias(): Promise<void>;
  fijarPedal(pedal: AsignacionPedal): Promise<void>;
  aprender(receptor: ((disparador: Disparador) => void) | null): void;
  /** Ejecuta la acción asignada a ese disparador (o lo entrega a quien esté aprendiendo). */
  disparar(disparador: Disparador): boolean;
  accion(accion: AccionPedal): void;
  fijarCifrado(cifrado: Cifrado): Promise<void>;
  seleccionar(clips: string[], pistaId: string | null): void;
  fijarRango(rango: { inicio: number; fin: number } | null): void;
  alternarBucle(): void;

  ajustarProyecto(parcial: Partial<Proyecto>): void;
  ajustarPista(id: string, parcial: Partial<Pista>): void;
  ajustarEq(id: string, banda: keyof Ecualizador, parcial: Partial<Ecualizador["bajos"]>): void;
  restablecerEq(id: string): void;

  /** Guarda el montaje actual en el historial (llamar una vez al empezar un gesto de arrastre). */
  marcarHistorial(): void;
  /** Sustituye los clips de una pista. Con `historial`, la operación se puede deshacer. */
  editarClips(pistaId: string, transformar: (clips: Clip[]) => Clip[], historial?: boolean): void;
  deshacer(): void;
  rehacer(): void;
  copiar(): void;
  cortar(): void;
  pegar(): void;
  duplicar(): void;
  dividirEnCursor(): void;
  eliminarSeleccion(): void;

  alternarReproduccion(): void;
  detener(): void;
  saltar(segundos: number): void;
}

let temporizadorGuardado: ReturnType<typeof setTimeout> | undefined;

const montajeDe = (p: Proyecto): Montaje => Object.fromEntries(p.pistas.map((pista) => [pista.id, pista.clips]));

export const usarApp = create<EstadoApp>((set, get) => {
  /** Aplica un cambio al proyecto, lo envía al motor de audio y programa el autoguardado. */
  const aplicar = (transformar: (p: Proyecto) => Proyecto): void => {
    const actual = get().proyecto;
    if (!actual) return;
    const proyecto = transformar(actual);
    set({ proyecto, guardado: "pendiente" });
    motorAudio.actualizar(proyecto);
    clearTimeout(temporizadorGuardado);
    temporizadorGuardado = setTimeout(guardarAhora, 1200);
  };

  const guardarAhora = async (): Promise<void> => {
    clearTimeout(temporizadorGuardado);
    const proyecto = get().proyecto;
    if (!proyecto || get().guardado === "guardado") return;
    set({ guardado: "guardando" });
    try {
      await motor.guardar(proyecto);
      if (get().proyecto === proyecto) set({ guardado: "guardado" });
    } catch (error) {
      set({ guardado: "error", aviso: { texto: `No se pudo guardar: ${(error as Error).message}`, tipo: "error" } });
    }
  };

  const cargarAnalisis = async (): Promise<void> => {
    const { proyecto, cifrado } = get();
    if (!proyecto) return;
    const analisis = await motor.analisis(proyecto.id, cifrado, proyecto.tono);
    if (get().proyecto?.id !== proyecto.id) return;
    set({ analisis });
    motorAudio.fijarPulsos(analisis.mapaTempo.pulsos);
  };

  /** Detiene la toma en curso y la deja como clip en su pista (y como toma de video, si hay cámara). */
  let grabadora: Grabadora | null = null;
  const terminarGrabacion = async (): Promise<void> => {
    const activa = grabadora;
    const { proyecto, grabacion } = get();
    if (!activa || !proyecto || !grabacion || grabacion.estado === "guardando") return;
    grabadora = null;
    motorAudio.pausar();
    motorAudio.alArrancar = () => {};
    set({ grabacion: { estado: "guardando", vistaPrevia: null } });
    const pista = proyecto.pistas.find((p) => p.id === get().pistaActiva);
    const tomas = proyecto.pistas.filter((p) => p.instrumento === "extra").length;
    try {
      const resultado = await activa.terminar(pista?.instrumento === "extra" ? pista.id : undefined, `Grabación ${tomas + 1}`,
        grabacion.estado !== "grabando");
      await recargar();
      if (resultado.pista) set({ pistaActiva: resultado.pista });
      if (resultado.video) set({ ventanaVideo: resultado.video });
    } catch (error) {
      set({ aviso: { texto: `No se pudo guardar la grabación: ${(error as Error).message}`, tipo: "error" } });
    }
    set({ grabacion: null });
  };
  motorAudio.alTerminar = () => void terminarGrabacion(); // la canción llegó al final mientras se grababa

  /** Vuelve a leer el proyecto abierto cuando el motor lo ha modificado (guías, tempo…). */
  const recargar = async (): Promise<void> => {
    const actual = get().proyecto;
    if (!actual) return;
    const proyecto = await motor.proyecto(actual.id);
    set({ proyecto, guardado: "guardado" });
    motorAudio.actualizar(proyecto);
    await cargarAnalisis();
  };

  /** Show continuo: deja cargada la canción que sigue a la actual en la lista. */
  let preparada: { proyecto: Proyecto; analisis: Analisis } | null = null;
  const prepararSiguiente = async (): Promise<void> => {
    const { proyecto, showContinuo, cifrado } = get();
    preparada = null;
    if (!proyecto || !showContinuo) {
      motorAudio.encolar(null, []);
      return;
    }
    const cola = get().cola();
    const destino = cola[cola.findIndex((p) => p.id === proyecto.id) + 1];
    if (!destino) {
      motorAudio.encolar(null, []);
      return;
    }
    try {
      const siguiente = await motor.proyecto(destino.id);
      const analisis = await motor.analisis(destino.id, cifrado, siguiente.tono);
      // Mientras se cargaba, el usuario pudo cambiar de canción o apagar el show.
      if (get().proyecto?.id !== proyecto.id || !get().showContinuo) return;
      preparada = { proyecto: siguiente, analisis };
      motorAudio.encolar(siguiente, analisis.mapaTempo.pulsos);
    } catch {
      motorAudio.encolar(null, []);
    }
  };

  // El procesador de audio avisa cuando la canción encolada empieza a sonar.
  motorAudio.alCambiarDeCancion = (proyecto) => {
    void guardarAhora(); // lo pendiente de la canción que acaba de terminar
    const analisis = preparada?.proyecto.id === proyecto.id ? preparada.analisis : null;
    set({
      proyecto, analisis, clipsSeleccionados: [], pistaActiva: proyecto.pistas[0]?.id ?? null, rango: null,
      pasado: [], futuro: [], bucle: false, guardado: "guardado",
    });
    if (!analisis) void cargarAnalisis();
    void prepararSiguiente();
  };

  /** Escucha el pedal MIDI: una petición que espera hasta que llega un mensaje, en bucle. */
  let escuchando = false;
  const escucharMidi = async (): Promise<void> => {
    if (escuchando) return;
    escuchando = true;
    let ultimo = 0;
    let exploradoEn = 0;
    for (;;) {
      try {
        if (Date.now() - exploradoEn > 15000) {
          const estado = await motor.midi.estado(); // abre los pedales recién conectados
          exploradoEn = Date.now();
          if (!estado.disponible) return void (escuchando = false);
          ultimo = Math.max(ultimo, estado.ultimo);
        }
        const { eventos } = await motor.midi.eventos(ultimo);
        for (const evento of eventos) {
          ultimo = Math.max(ultimo, evento.n);
          const disparador = disparadorMidi(evento);
          if (disparador) get().disparar(disparador);
        }
      } catch {
        await new Promise((resolver) => setTimeout(resolver, 3000));
      }
    }
  };

  /** Guarda las playlists en el motor; si falla, se recupera el estado real. */
  const fijarPlaylists = async (playlists: Playlist[]): Promise<void> => {
    set({ playlists }); // optimista: la lista responde al instante
    try {
      set({ playlists: (await motor.guardarPlaylists(playlists)).playlists });
      void prepararSiguiente(); // reordenar la lista cambia cuál es «la siguiente»
    } catch (error) {
      set({ playlists: (await motor.biblioteca()).playlists,
        aviso: { texto: `No se pudo guardar la playlist: ${(error as Error).message}`, tipo: "error" } });
    }
  };

  const pistaDeTrabajo = (): Pista | undefined => {
    const { proyecto, pistaActiva, clipsSeleccionados } = get();
    if (!proyecto) return undefined;
    return (
      proyecto.pistas.find((p) => p.id === pistaActiva) ??
      proyecto.pistas.find((p) => p.clips.some((c) => clipsSeleccionados.includes(c.id))) ??
      proyecto.pistas[0]
    );
  };

  return {
    salud: null,
    errorMotor: null,
    proyectos: [],
    playlists: [],
    playlistActiva: null,
    ordenGeneral: "manual",
    panelLateral: false,
    grabacion: null,
    opcionesDeGrabacion: leerOpcionesDeGrabacion(),
    ventanaVideo: null,
    panelTablatura: false,
    driveAutomatico: false,
    showContinuo: false,
    pedal: {},
    aprendiendo: null,
    proyecto: null,
    analisis: null,
    cifrado: "estandar",
    vista: "editor",
    dialogo: null,
    clipsSeleccionados: [],
    pistaActiva: null,
    rango: null,
    portapapeles: null,
    pasado: [],
    futuro: [],
    zoom: 40,
    iman: true,
    bucle: false,
    guardado: "guardado",
    trabajo: null,
    aviso: null,

    async conectar() {
      // El motor tarda unos segundos en arrancar: se reintenta antes de dar el error por bueno.
      for (let intento = 0; intento < 40; intento++) {
        try {
          const salud = await motor.salud();
          const biblioteca = await motor.biblioteca();
          set({
            salud, errorMotor: null, proyectos: await motor.proyectos(),
            playlists: biblioteca.playlists, driveAutomatico: biblioteca.ajustes.driveAutomatico,
            pedal: biblioteca.ajustes.pedal ?? {},
          });
          void escucharMidi();
          return;
        } catch (error) {
          if (intento === 39) set({ errorMotor: (error as Error).message || String(error) });
          await new Promise((resolver) => setTimeout(resolver, 500));
        }
      }
    },

    async refrescarProyectos() {
      const [proyectos, biblioteca] = await Promise.all([motor.proyectos(), motor.biblioteca()]);
      set({ proyectos, playlists: biblioteca.playlists });
    },

    async abrir(id) {
      try {
        // Antes de cambiar de canción se guarda lo pendiente de la actual.
        motorAudio.pausar();
        await guardarAhora();
        const proyecto = await motor.proyecto(id);
        set({
          proyecto, analisis: null, vista: "editor", clipsSeleccionados: [], pistaActiva: proyecto.pistas[0]?.id ?? null,
          rango: null, pasado: [], futuro: [], bucle: false, guardado: "guardado",
        });
        motorAudio.actualizar(proyecto);
        motorAudio.fijarBucle(null);
        motorAudio.saltar(0);
        void get().refrescarProyectos(); // el panel lateral debe incluir lo recién importado
        await cargarAnalisis();
        void prepararSiguiente();
      } catch (error) {
        set({ aviso: { texto: `No se pudo abrir el proyecto: ${(error as Error).message}`, tipo: "error" } });
      }
    },

    async cerrar() {
      motorAudio.pausar();
      await guardarAhora();
      set({ proyecto: null, analisis: null, dialogo: null });
      await get().refrescarProyectos();
    },

    async eliminarProyecto(id) {
      await motor.eliminar(id);
      await get().refrescarProyectos();
    },

    async ejecutar(titulo, lanzar) {
      try {
        const final = await seguirTrabajo(await lanzar(), (t) => set({ trabajo: { ...t, titulo } }));
        set({ trabajo: null });
        return final.estado === "completado" ? final : null;
      } catch (error) {
        set({ trabajo: null, aviso: { texto: `${titulo}: ${(error as Error).message}`, tipo: "error" } });
        return null;
      }
    },

    cancelarTrabajo() {
      const trabajo = get().trabajo;
      if (trabajo) void motor.cancelar(trabajo.id);
    },

    async importar(origen, opciones) {
      const nombre = typeof origen === "string" ? origen : origen.name;
      if (nombre.toLowerCase().endsWith(".falab")) {
        if (typeof origen === "string") return get().importarPaquete(origen);
        const paquete = await get().ejecutar("Importando el proyecto", () => motor.importarArchivo(origen, opciones));
        if (paquete) await get().refrescarProyectos();
        return;
      }
      const final = await get().ejecutar("Analizando la canción", () =>
        typeof origen === "string" ? motor.importarRuta(origen, opciones) : motor.importarArchivo(origen, opciones),
      );
      if (!final) return;
      await get().abrir(final.resultado.id);
      const avisos: string[] = final.resultado.avisos ?? [];
      if (avisos.length) set({ aviso: { texto: avisos.join("\n"), tipo: "info" } });
    },

    async crearDemo() {
      const final = await get().ejecutar("Creando la demostración", () => motor.demo());
      if (final) await get().abrir(final.resultado.id);
    },

    async exportar(peticion) {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      await guardarAhora(); // el motor exporta lo que hay guardado en disco
      const final = await get().ejecutar("Exportando", () => motor.exportar(proyecto.id, peticion));
      if (final) {
        const archivos: string[] = final.resultado.archivos;
        set({ dialogo: null, aviso: { texto: "Exportación terminada", tipo: "info", archivos } });
      }
    },

    fijar(parcial) {
      set(parcial);
      // Cambiar de lista o de orden cambia cuál es «la siguiente».
      if ("playlistActiva" in parcial || "ordenGeneral" in parcial) void prepararSiguiente();
    },

    anadirPista() {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      if (proyecto.pistas.length >= MAX_PISTAS) {
        set({ aviso: { texto: `Un proyecto admite como máximo ${MAX_PISTAS} pistas.`, tipo: "info" } });
        return;
      }
      const extras = proyecto.pistas.filter((p) => p.instrumento === "extra").length;
      const id = `pista_${Math.random().toString(36).slice(2, 10)}`;
      aplicar((p) => ({
        ...p,
        pistas: [...p.pistas, {
          id, nombre: `Pista ${extras + 1}`, instrumento: "extra", color: COLORES_DE_PISTA[extras % COLORES_DE_PISTA.length],
          volumen: 0, paneo: 0, silencio: false, solo: false, tono: 0, reverb: 0, clips: [],
          eq: { bajos: { frecuencia: 120, ganancia: 0 }, medios: { frecuencia: 1000, ganancia: 0, q: 1 }, agudos: { frecuencia: 8000, ganancia: 0 } },
        }],
      }));
      set({ pistaActiva: id, clipsSeleccionados: [] });
    },

    eliminarPista(id) {
      get().marcarHistorial();
      aplicar((p) => ({ ...p, pistas: p.pistas.filter((pista) => pista.id !== id) }));
      if (get().pistaActiva === id) set({ pistaActiva: get().proyecto?.pistas[0]?.id ?? null });
    },

    async importarEnPista(origen) {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      await guardarAhora(); // el motor añade la pista sobre lo que hay guardado
      const activa = proyecto.pistas.find((p) => p.id === get().pistaActiva);
      // Sobre una pista propia se añade el clip; sobre un stem original se crea una pista nueva.
      const destino = activa?.instrumento === "extra" ? activa.id : undefined;
      const cursor = usarReproduccion.getState().posicion;
      const final = await get().ejecutar("Importando el audio", () =>
        typeof origen === "string"
          ? motor.importarEnPista(proyecto.id, origen, cursor, destino)
          : motor.subirAPista(proyecto.id, origen, cursor, destino));
      if (!final) return;
      await recargar();
      set({ pistaActiva: final.resultado.pista });
      const avisos: string[] = final.resultado.avisos ?? [];
      if (avisos.length) set({ aviso: { texto: avisos.join("\n"), tipo: "info" } });
    },

    fijarOpcionesDeGrabacion(parcial) {
      const opciones = { ...get().opcionesDeGrabacion, ...parcial };
      set({ opcionesDeGrabacion: opciones });
      try {
        localStorage.setItem(CLAVE_GRABACION, JSON.stringify(opciones));
      } catch {
        /* sin almacenamiento local: las opciones valen solo para esta sesión */
      }
    },

    async alternarGrabacion() {
      const { proyecto, grabacion } = get();
      if (!proyecto) return;
      if (grabacion) return terminarGrabacion();
      if (proyecto.velocidad !== 1 || proyecto.tono !== 0) {
        set({ aviso: { texto: "Para grabar, pon la velocidad al 100 % y el tono en 0: así la toma queda sincronizada.", tipo: "info" } });
        return;
      }
      motorAudio.pausar();
      await guardarAhora();
      const nueva = new Grabadora();
      grabadora = nueva;
      set({ grabacion: { estado: "preparando", vistaPrevia: null } });
      try {
        await nueva.preparar(proyecto.id, get().opcionesDeGrabacion);
      } catch (error) {
        grabadora = null;
        const nombre = (error as DOMException).name;
        const texto = nombre === "NotAllowedError"
          ? "falab no tiene permiso para usar el micrófono o la cámara. Actívalo en Ajustes del Sistema → Privacidad y seguridad."
          : nombre === "NotFoundError" || nombre === "OverconstrainedError"
            ? "No se encontró el micrófono o la cámara elegidos. Revisa los dispositivos en las opciones de grabación."
            : `No se pudo empezar a grabar: ${(error as Error).message}`;
        set({ grabacion: null, aviso: { texto, tipo: "error" } });
        return;
      }
      set({ grabacion: { estado: "esperando", vistaPrevia: nueva.vistaPrevia } });
      motorAudio.alArrancar = (cuadro, posicion) => {
        nueva.marcarArranque(cuadro, posicion);
        if (get().grabacion) set({ grabacion: { estado: "grabando", vistaPrevia: nueva.vistaPrevia } });
      };
      await motorAudio.reproducir();
    },

    eliminarToma(id) {
      aplicar((p) => ({ ...p, videos: (p.videos ?? []).filter((v) => v.id !== id) }));
      if (get().ventanaVideo === id) set({ ventanaVideo: null });
    },

    alternarShow() {
      set({ showContinuo: !get().showContinuo });
      void prepararSiguiente();
    },

    fijarBpm(bpm) {
      const base = get().proyecto?.bpm;
      if (!base || !Number.isFinite(bpm) || bpm <= 0) return;
      get().ajustarProyecto({ velocidad: Math.min(2, Math.max(0.25, Math.round((bpm / base) * 10000) / 10000)) });
    },

    async guardarEstructura(secciones) {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      try {
        await motor.guardarEstructura(proyecto.id, secciones);
        await cargarAnalisis();
      } catch (error) {
        set({ aviso: { texto: `No se pudo guardar la estructura: ${(error as Error).message}`, tipo: "error" } });
      }
    },

    async detectarEstructura() {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      const final = await get().ejecutar("Detectando la estructura", () => motor.detectarEstructura(proyecto.id));
      if (final) await cargarAnalisis();
    },

    async corregirMapa(operacion) {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      try {
        await guardarAhora();
        await motor.corregirMapa(proyecto.id, operacion);
        await recargar();
      } catch (error) {
        set({ aviso: { texto: `No se pudo corregir el tempo: ${(error as Error).message}`, tipo: "error" } });
      }
    },

    async generarGuias() {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      await guardarAhora(); // el motor añade la pista sobre lo que hay guardado
      const final = await get().ejecutar("Generando las guías de voz", () => motor.generarGuias(proyecto.id));
      if (final) {
        await recargar();
        set({ aviso: { texto: `Pista «Guías» creada con ${final.resultado.avisos} avisos. Tiene su propio volumen y silencio en el mezclador.`, tipo: "info" } });
      }
    },

    async fijarPedal(pedal) {
      set({ pedal });
      try {
        await motor.guardarAjustes({ pedal });
      } catch (error) {
        set({ aviso: { texto: `No se pudo guardar el pedal: ${(error as Error).message}`, tipo: "error" } });
      }
    },

    aprender: (receptor) => set({ aprendiendo: receptor }),

    disparar(disparador) {
      const { aprendiendo, pedal } = get();
      if (aprendiendo) {
        set({ aprendiendo: null });
        aprendiendo(disparador);
        return true;
      }
      for (const accion of ["reproducir", "siguiente", "anterior"] as AccionPedal[]) {
        if ((pedal[accion] ?? []).some((d) => mismoDisparador(d, disparador))) {
          get().accion(accion);
          return true;
        }
      }
      return false;
    },

    accion(accion) {
      if (!get().proyecto || get().trabajo) return;
      if (accion === "reproducir") get().alternarReproduccion();
      else void get().irA(accion === "siguiente" ? 1 : -1);
    },

    async crearPlaylist(nombre) {
      await fijarPlaylists([...get().playlists, { id: "", nombre, orden: "manual", proyectos: [] }]);
      const creada = get().playlists[get().playlists.length - 1];
      if (creada) set({ playlistActiva: creada.id });
    },

    cambiarPlaylist: (id, parcial) =>
      fijarPlaylists(get().playlists.map((l) => (l.id === id ? { ...l, ...parcial } : l))),

    async eliminarPlaylist(id) {
      if (get().playlistActiva === id) set({ playlistActiva: null });
      await fijarPlaylists(get().playlists.filter((l) => l.id !== id));
    },

    alternarEnPlaylist: (idPlaylist, idProyecto) =>
      fijarPlaylists(get().playlists.map((l) => l.id !== idPlaylist ? l : {
        ...l,
        proyectos: l.proyectos.includes(idProyecto) ? l.proyectos.filter((p) => p !== idProyecto) : [...l.proyectos, idProyecto],
      })),

    moverEnPlaylist: (idPlaylist, idProyecto, delta) =>
      fijarPlaylists(get().playlists.map((l) =>
        l.id === idPlaylist ? { ...l, proyectos: desplazar(l.proyectos, idProyecto, delta) } : l)),

    cola() {
      const { proyectos, playlists, playlistActiva, ordenGeneral } = get();
      return ordenar(proyectos, playlists.find((l) => l.id === playlistActiva) ?? null, ordenGeneral);
    },

    async irA(delta) {
      const actual = get().proyecto;
      const cola = get().cola();
      if (!actual || cola.length === 0) return;
      const destino = cola[cola.findIndex((p) => p.id === actual.id) + delta];
      if (!destino) return;
      // En directo, cambiar de canción mientras suena no detiene el show.
      const sonaba = usarReproduccion.getState().estado !== "detenido";
      await get().abrir(destino.id);
      if (sonaba && get().proyecto?.id === destino.id) void motorAudio.reproducir();
    },

    async exportarPaquete(id, destino) {
      if (get().proyecto?.id === id) await guardarAhora();
      const final = await get().ejecutar("Exportando el proyecto", () => motor.empaquetar(id, destino));
      if (final) {
        set({ aviso: { texto: "Proyecto exportado. Se puede importar en otro equipo con falab.", tipo: "info",
          archivos: final.resultado.archivos, idProyecto: id } });
      }
    },

    async importarPaquete(ruta) {
      const final = await get().ejecutar("Importando el proyecto", () => motor.importarPaquete(ruta));
      if (final) await get().refrescarProyectos();
    },

    async fijarDriveAutomatico(activo) {
      await motor.guardarAjustes({ driveAutomatico: activo });
      set({ driveAutomatico: activo });
    },

    async guardarLetras(lineas) {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      try {
        await motor.editarLetras(proyecto.id, lineas);
        await cargarAnalisis();
      } catch (error) {
        set({ aviso: { texto: `No se pudo guardar la letra: ${(error as Error).message}`, tipo: "error" } });
      }
    },

    async recalcularAcordes(detalle) {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      const final = await get().ejecutar("Cifrando acordes", () => motor.recalcularAcordes(proyecto.id, detalle));
      if (final) await cargarAnalisis();
    },

    async fijarCifrado(cifrado) {
      set({ cifrado });
      await cargarAnalisis();
    },

    seleccionar: (clips, pistaId) => set({ clipsSeleccionados: clips, pistaActiva: pistaId ?? get().pistaActiva }),

    fijarRango(rango) {
      const valido = rango && rango.fin - rango.inicio > 0.05 ? rango : null;
      set({ rango: valido, bucle: valido ? get().bucle : false });
      motorAudio.fijarBucle(valido && get().bucle ? valido : null);
    },

    alternarBucle() {
      const { rango, bucle } = get();
      if (!rango) {
        set({ aviso: { texto: "Arrastra sobre la regla para marcar el tramo que quieres repetir.", tipo: "info" } });
        return;
      }
      set({ bucle: !bucle });
      motorAudio.fijarBucle(!bucle ? rango : null);
    },

    ajustarProyecto(parcial) {
      const cambiaTono = parcial.tono !== undefined && parcial.tono !== get().proyecto?.tono;
      aplicar((p) => ({ ...p, ...parcial }));
      if (cambiaTono) void cargarAnalisis(); // los acordes se muestran ya transpuestos
    },

    ajustarPista(id, parcial) {
      aplicar((p) => ({ ...p, pistas: p.pistas.map((pista) => (pista.id === id ? { ...pista, ...parcial } : pista)) }));
    },

    ajustarEq(id, banda, parcial) {
      aplicar((p) => ({
        ...p,
        pistas: p.pistas.map((pista) =>
          pista.id === id ? { ...pista, eq: { ...pista.eq, [banda]: { ...pista.eq[banda], ...parcial } } } : pista,
        ),
      }));
    },

    restablecerEq(id) {
      get().ajustarPista(id, {
        eq: {
          bajos: { frecuencia: 120, ganancia: 0 },
          medios: { frecuencia: 1000, ganancia: 0, q: 1 },
          agudos: { frecuencia: 8000, ganancia: 0 },
        },
      });
    },

    marcarHistorial() {
      const proyecto = get().proyecto;
      if (!proyecto) return;
      set({ pasado: [...get().pasado.slice(-MAX_HISTORIAL + 1), montajeDe(proyecto)], futuro: [] });
    },

    editarClips(pistaId, transformar, historial = true) {
      if (historial) get().marcarHistorial();
      aplicar((p) => ({
        ...p,
        pistas: p.pistas.map((pista) => (pista.id === pistaId ? { ...pista, clips: transformar(pista.clips) } : pista)),
      }));
    },

    deshacer() {
      const { pasado, futuro, proyecto } = get();
      if (!proyecto || pasado.length === 0) return;
      const montaje = pasado[pasado.length - 1];
      set({ pasado: pasado.slice(0, -1), futuro: [...futuro, montajeDe(proyecto)], clipsSeleccionados: [] });
      aplicar((p) => ({ ...p, pistas: p.pistas.map((x) => ({ ...x, clips: montaje[x.id] ?? x.clips })) }));
    },

    rehacer() {
      const { pasado, futuro, proyecto } = get();
      if (!proyecto || futuro.length === 0) return;
      const montaje = futuro[futuro.length - 1];
      set({ futuro: futuro.slice(0, -1), pasado: [...pasado, montajeDe(proyecto)], clipsSeleccionados: [] });
      aplicar((p) => ({ ...p, pistas: p.pistas.map((x) => ({ ...x, clips: montaje[x.id] ?? x.clips })) }));
    },

    copiar() {
      const pista = pistaDeTrabajo();
      const { rango, clipsSeleccionados } = get();
      if (!pista) return;
      // Con un tramo marcado en la regla se copia ese tramo; si no, los clips seleccionados.
      const copia = clipsSeleccionados.length
        ? copiarClips(pista.clips, clipsSeleccionados)
        : rango
          ? copiarRango(pista.clips, rango.inicio, rango.fin)
          : null;
      if (copia && copia.fragmentos.length) set({ portapapeles: copia });
    },

    cortar() {
      const pista = pistaDeTrabajo();
      const { rango, clipsSeleccionados } = get();
      if (!pista) return;
      get().copiar();
      if (clipsSeleccionados.length) {
        get().editarClips(pista.id, (clips) => eliminar(clips, clipsSeleccionados));
        set({ clipsSeleccionados: [] });
      } else if (rango) {
        get().editarClips(pista.id, (clips) => quitarRango(clips, rango.inicio, rango.fin));
      }
    },

    pegar() {
      const pista = pistaDeTrabajo();
      const { portapapeles } = get();
      if (!pista || !portapapeles) return;
      const cursor = usarReproduccion.getState().posicion;
      const resultado = pegar(pista.clips, portapapeles, cursor);
      get().editarClips(pista.id, () => resultado.clips);
      set({ clipsSeleccionados: resultado.nuevos, pistaActiva: pista.id });
    },

    duplicar() {
      const pista = pistaDeTrabajo();
      const { clipsSeleccionados } = get();
      if (!pista || clipsSeleccionados.length === 0) return;
      const elegidos = pista.clips.filter((c) => clipsSeleccionados.includes(c.id));
      const resultado = pegar(pista.clips, copiarClips(pista.clips, clipsSeleccionados), Math.max(...elegidos.map(finDe)));
      get().editarClips(pista.id, () => resultado.clips);
      set({ clipsSeleccionados: resultado.nuevos });
    },

    dividirEnCursor() {
      const { proyecto, clipsSeleccionados, pistaActiva } = get();
      if (!proyecto) return;
      const cursor = usarReproduccion.getState().posicion;
      // Se divide la pista activa; sin pista activa ni selección, todas las pistas a la vez.
      const objetivo = clipsSeleccionados.length || pistaActiva ? [pistaDeTrabajo()!.id] : proyecto.pistas.map((p) => p.id);
      get().marcarHistorial();
      for (const id of objetivo) get().editarClips(id, (clips) => dividir(clips, cursor), false);
    },

    eliminarSeleccion() {
      const pista = pistaDeTrabajo();
      const { clipsSeleccionados, rango } = get();
      if (!pista) return;
      if (clipsSeleccionados.length) {
        get().editarClips(pista.id, (clips) => eliminar(clips, clipsSeleccionados));
        set({ clipsSeleccionados: [] });
      } else if (rango) {
        get().editarClips(pista.id, (clips) => quitarRango(clips, rango.inicio, rango.fin));
      }
    },

    alternarReproduccion() {
      if (!get().proyecto) return;
      if (get().grabacion) return void terminarGrabacion(); // pausar durante una toma la da por terminada
      if (usarReproduccion.getState().estado === "detenido") void motorAudio.reproducir();
      else motorAudio.pausar();
    },

    detener() {
      motorAudio.pausar();
      motorAudio.saltar(get().bucle && get().rango ? get().rango!.inicio : 0);
    },

    saltar(segundos) {
      const duracion = duracionDe(get().proyecto);
      motorAudio.saltar(Math.min(Math.max(0, segundos), duracion));
    },
  };
});

/** Duración del montaje: el final del último clip. */
export function duracionDe(proyecto: Proyecto | null): number {
  if (!proyecto) return 0;
  return Math.max(0, ...proyecto.pistas.flatMap((p) => p.clips.map(finDe)));
}



/** Solo cuentan las pulsaciones: nota pulsada, controlador a fondo o cambio de programa. */
export function disparadorMidi(evento: Pick<EventoMidi, "estado" | "dato1" | "dato2">): Disparador | null {
  if (evento.estado === 0x90 && evento.dato2 > 0) return { tipo: "midi", estado: 0x90, dato1: evento.dato1 };
  if (evento.estado === 0xb0 && evento.dato2 >= 64) return { tipo: "midi", estado: 0xb0, dato1: evento.dato1 };
  if (evento.estado === 0xc0) return { tipo: "midi", estado: 0xc0, dato1: evento.dato1 };
  return null;
}

export function mismoDisparador(a: Disparador, b: Disparador): boolean {
  if (a.tipo === "tecla" && b.tipo === "tecla") return a.codigo === b.codigo;
  if (a.tipo === "midi" && b.tipo === "midi") return a.estado === b.estado && a.dato1 === b.dato1;
  return false;
}

export function nombreDeDisparador(d: Disparador): string {
  if (d.tipo === "tecla") return `Tecla ${d.codigo.replace(/^Key|^Digit/, "")}`;
  const clase = d.estado === 0x90 ? "Nota" : d.estado === 0xb0 ? "Controlador" : "Programa";
  return `MIDI · ${clase} ${d.dato1}`;
}
