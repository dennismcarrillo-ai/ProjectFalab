/** Estado global de la aplicación (Zustand). */
import { create } from "zustand";
import { motorAudio, type EstadoReproduccion } from "../audio/MotorAudio";
import {
  copiarClips, copiarRango, dividir, eliminar, finDe, pegar, quitarRango,
} from "../edicion/operaciones";
import { motor, seguirTrabajo, type OpcionesImportar, type PeticionExportar } from "../servicios/motor";
import type {
  Analisis, Cifrado, Clip, Ecualizador, Pista, Portapapeles, Proyecto, ResumenProyecto, Salud, Trabajo,
} from "../tipos";

export type Vista = "editor" | "karaoke" | "cancionero" | "partitura";
export type Dialogo = null | "exportar" | "drive";
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
  aviso: { texto: string; tipo: "info" | "error"; archivos?: string[] } | null;

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

  fijar(parcial: Partial<Pick<EstadoApp, "vista" | "dialogo" | "zoom" | "iman" | "aviso" | "pistaActiva">>): void;
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
          set({ salud, errorMotor: null, proyectos: await motor.proyectos() });
          return;
        } catch (error) {
          if (intento === 39) set({ errorMotor: (error as Error).message || String(error) });
          await new Promise((resolver) => setTimeout(resolver, 500));
        }
      }
    },

    async refrescarProyectos() {
      set({ proyectos: await motor.proyectos() });
    },

    async abrir(id) {
      try {
        const proyecto = await motor.proyecto(id);
        motorAudio.pausar();
        set({
          proyecto, analisis: null, vista: "editor", clipsSeleccionados: [], pistaActiva: proyecto.pistas[0]?.id ?? null,
          rango: null, pasado: [], futuro: [], bucle: false, guardado: "guardado",
        });
        motorAudio.actualizar(proyecto);
        motorAudio.fijarBucle(null);
        motorAudio.saltar(0);
        await cargarAnalisis();
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

    fijar: (parcial) => set(parcial),

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

