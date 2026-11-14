/**
 * Cliente del motor local (Python).
 *
 * - Dentro de la app de escritorio, las peticiones pasan por Rust (`peticion_motor`): el testigo
 *   de sesión nunca llega a JavaScript y no hay problemas de CORS ni de contenido mixto.
 * - En un navegador (desarrollo con `npm run dev`) se llama al motor directamente por HTTP.
 */
import type {
  Analisis, AsignacionPedal, Cifrado, DetalleAcordes, Nota, Playlist, Proyecto, ResumenProyecto, Salud, Seccion, Trabajo,
} from "../tipos";

export interface EventoMidi {
  n: number;
  puerto: string;
  estado: number;
  canal: number;
  dato1: number;
  dato2: number;
}

export interface EstadoDrive {
  configurado: boolean;
  conectado: boolean;
  rutaCredenciales: string;
  automatico: boolean;
  pendientes: string[];
  ultimoError: string | null;
  ultimaSincronizacion: string | null;
}

export const enEscritorio = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const URL_NAVEGADOR: string = import.meta.env?.VITE_MOTOR_URL ?? "http://127.0.0.1:8765";

async function crudo(metodo: string, ruta: string, cuerpo?: unknown): Promise<ArrayBuffer> {
  if (enEscritorio) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ArrayBuffer>("peticion_motor", {
      metodo,
      ruta,
      cuerpo: cuerpo === undefined ? null : JSON.stringify(cuerpo),
    });
  }
  const respuesta = await fetch(URL_NAVEGADOR + ruta, {
    method: metodo,
    headers: cuerpo === undefined ? undefined : { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (!respuesta.ok) {
    let detalle = `Error ${respuesta.status}`;
    try {
      detalle = (await respuesta.json()).detail ?? detalle;
    } catch {
      /* la respuesta no era JSON */
    }
    throw new Error(detalle);
  }
  return respuesta.arrayBuffer();
}

async function json<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await crudo(metodo, ruta, cuerpo))) as T;
}

const q = (parametros: Record<string, string | number | undefined>): string => {
  const pares = Object.entries(parametros).filter(([, v]) => v !== undefined && v !== "");
  return pares.length ? "?" + pares.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&") : "";
};

export interface OpcionesImportar {
  separar: boolean;
  antiBleed: boolean;
  extraerNotas: boolean;
  transcribirLetras: boolean;
  calidadLetras: "rapido" | "equilibrado" | "preciso";
  idioma: string | null;
}

export interface PeticionExportar {
  tipo: "mezcla" | "pistas" | "video" | "cancionero" | "partitura" | "midi" | "tablatura";
  formato?: string;
  destino?: string;
  cifrado?: Cifrado;
  instrumento?: string;
}

export const motor = {
  salud: () => json<Salud>("GET", "/salud"),
  proyectos: () => json<ResumenProyecto[]>("GET", "/proyectos"),
  proyecto: (id: string) => json<Proyecto>("GET", `/proyectos/${id}`),
  guardar: (p: Proyecto) => json<{ modificado: string }>("PUT", `/proyectos/${p.id}`, p),
  eliminar: (id: string) => json("DELETE", `/proyectos/${id}`),
  demo: () => json<Trabajo>("POST", "/proyectos/demo"),
  biblioteca: () =>
    json<{ playlists: Playlist[]; ajustes: { driveAutomatico: boolean; pedal?: AsignacionPedal } }>("GET", "/biblioteca"),
  guardarEstructura: (id: string, secciones: Seccion[]) =>
    json<{ secciones: Seccion[] }>("PUT", `/proyectos/${id}/estructura`, { secciones }),
  detectarEstructura: (id: string) => json<Trabajo>("POST", `/proyectos/${id}/estructura/detectar`),
  corregirMapa: (id: string, operacion: "doble" | "mitad" | "desplazar") =>
    json<{ bpm: number }>("POST", `/proyectos/${id}/mapa-tempo`, { operacion }),
  generarGuias: (id: string) => json<Trabajo>("POST", `/proyectos/${id}/guias`),
  midi: {
    estado: () => json<{ disponible: boolean; puertos: string[]; ultimo: number; error: string | null }>("GET", "/midi/estado"),
    eventos: (desde: number) =>
      json<{ eventos: EventoMidi[] }>("GET", `/midi/eventos${q({ desde, espera: 20 })}`),
  },
  guardarPlaylists: (playlists: Playlist[]) =>
    json<{ playlists: Playlist[] }>("PUT", "/biblioteca/playlists", { playlists }),
  guardarAjustes: (ajustes: { driveAutomatico?: boolean; pedal?: AsignacionPedal }) =>
    json("PUT", "/biblioteca/ajustes", ajustes),
  empaquetar: (id: string, destino?: string) => json<Trabajo>("POST", `/proyectos/${id}/empaquetar`, { destino }),
  importarPaquete: (ruta: string) => json<Trabajo>("POST", "/proyectos/importar-paquete", { ruta }),
  editarLetras: (id: string, lineas: { inicio: number; texto: string }[]) =>
    json("PUT", `/proyectos/${id}/letras`, { lineas }),
  recalcularAcordes: (id: string, detalle: DetalleAcordes) =>
    json<Trabajo>("POST", `/proyectos/${id}/acordes`, { detalle }),
  importarRuta: (ruta: string, opciones: OpcionesImportar) =>
    json<Trabajo>("POST", "/proyectos/importar", { ruta, opciones }),
  /** Solo en navegador: sube el archivo porque la página no conoce su ruta en disco. */
  async importarArchivo(archivo: File, opciones: OpcionesImportar): Promise<Trabajo> {
    const formulario = new FormData();
    formulario.append("archivo", archivo);
    formulario.append("opciones", JSON.stringify(opciones));
    const respuesta = await fetch(URL_NAVEGADOR + "/proyectos/subir", { method: "POST", body: formulario });
    if (!respuesta.ok) throw new Error((await respuesta.json()).detail ?? "No se pudo subir el archivo.");
    return respuesta.json();
  },
  analisis: (id: string, cifrado: Cifrado, transponer: number) =>
    json<Analisis>("GET", `/proyectos/${id}/analisis${q({ cifrado, transponer })}`),
  notas: (id: string, instrumento: string) => json<{ notas: Nota[] }>("GET", `/proyectos/${id}/notas${q({ instrumento })}`),
  alphatex: (id: string, instrumento: string, modo: string) =>
    json<{ tex: string; modo: string; conTrastes: boolean; compases: { inicio: number; fin: number }[] }>(
      "GET", `/proyectos/${id}/alphatex${q({ instrumento, modo })}`),
  pcm: async (id: string, fuente: string, inicio: number, frames: number) =>
    new Int16Array(await crudo("GET", `/proyectos/${id}/fuentes/${fuente}/pcm${q({ inicio, frames })}`)),
  picos: async (id: string, fuente: string) =>
    new Int8Array(await crudo("GET", `/proyectos/${id}/fuentes/${fuente}/picos`)),
  exportar: (id: string, peticion: PeticionExportar) => json<Trabajo>("POST", `/proyectos/${id}/exportar`, peticion),
  urlExportacion: (id: string, ruta: string) =>
    `${URL_NAVEGADOR}/proyectos/${id}/exportaciones/${encodeURIComponent(ruta.split(/[\\/]/).pop() ?? "")}`,
  trabajo: (id: string) => json<Trabajo>("GET", `/trabajos/${id}`),
  cancelar: (id: string) => json("POST", `/trabajos/${id}/cancelar`),
  drive: {
    estado: () => json<EstadoDrive>("GET", "/drive/estado"),
    conectar: () => json<{ configurado: boolean; conectado: boolean }>("POST", "/drive/conectar"),
    desconectar: () => json("POST", "/drive/desconectar"),
    proyectos: () =>
      json<{ id: string; nombre: string; modificado: string; enLocal: boolean }[]>("GET", "/drive/proyectos"),
    subir: (id: string) => json<Trabajo>("POST", `/drive/subir/${id}`),
    descargar: (id: string) => json<Trabajo>("POST", `/drive/descargar/${id}`),
  },
};

/** Sondea un trabajo hasta que termina, informando del avance. Lanza si acaba en error. */
export async function seguirTrabajo(inicial: Trabajo, alAvanzar: (t: Trabajo) => void): Promise<Trabajo> {
  let trabajo = inicial;
  alAvanzar(trabajo);
  while (trabajo.estado === "pendiente" || trabajo.estado === "ejecutando") {
    await new Promise((resolver) => setTimeout(resolver, 400));
    trabajo = await motor.trabajo(trabajo.id);
    alAvanzar(trabajo);
  }
  if (trabajo.estado === "error") throw new Error(trabajo.error ?? "El trabajo falló.");
  return trabajo;
}
