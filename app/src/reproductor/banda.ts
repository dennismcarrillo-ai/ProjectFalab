/**
 * Conexión del reproductor con el servidor de banda (la Mac de quien analiza las canciones).
 *
 * Con sesión iniciada, la biblioteca de esa Mac aparece en el reproductor y cada canción se
 * reproduce en streaming: el .falab se lee por tramos con peticiones de rango, igual que si fuera
 * un archivo local. También se pueden subir canciones para que la Mac las analice.
 */
import type { ResumenProyecto } from "../tipos";
import type { Lector } from "./lector";

export interface SesionDeBanda {
  /** Dirección del servidor («» = la misma página, cuando la web la sirve la propia Mac). */
  url: string;
  testigo: string;
  usuario: { id: string; nombre: string };
}

export interface EnCola {
  id: string;
  nombre: string;
  usuario: string;
  estado: "pendiente" | "ejecutando" | "error";
  progreso: number;
  etapa: string;
  error: string | null;
}

export interface CancionDeBanda extends ResumenProyecto {
  subidoPor: string | null;
}

const CLAVE = "falab.banda";

/** ¿Esta página la está sirviendo el servidor de banda de una Mac? */
export const servidaPorLaBanda = typeof window !== "undefined" && (window as { __FALAB_BANDA__?: boolean }).__FALAB_BANDA__ === true;

export function sesionGuardada(): SesionDeBanda | null {
  try {
    const sesion = JSON.parse(localStorage.getItem(CLAVE) ?? "null");
    return sesion && typeof sesion.testigo === "string" ? sesion : null;
  } catch {
    return null;
  }
}

function recordar(sesion: SesionDeBanda | null): void {
  try {
    if (sesion) localStorage.setItem(CLAVE, JSON.stringify(sesion));
    else localStorage.removeItem(CLAVE);
  } catch {
    /* sin almacenamiento: la sesión vale solo mientras la página esté abierta */
  }
}

/** Deja la dirección en la forma https://servidor (sin barra final). */
export function normalizarUrl(texto: string): string {
  const limpio = texto.trim().replace(/\/+$/, "");
  if (!limpio) return "";
  return /^https?:\/\//i.test(limpio) ? limpio : `https://${limpio}`;
}

export async function pedir<T>(sesion: Pick<SesionDeBanda, "url"> & { testigo?: string }, metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  let respuesta: Response;
  try {
    respuesta = await fetch(sesion.url + ruta, {
      method: metodo,
      headers: {
        ...(sesion.testigo ? { Authorization: `Bearer ${sesion.testigo}` } : {}),
        ...(cuerpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  } catch {
    throw new Error("No se pudo conectar con la Mac de la banda. Comprueba la dirección y que esté encendida.");
  }
  if (!respuesta.ok) {
    let detalle = `Error ${respuesta.status}`;
    try {
      detalle = (await respuesta.json()).detail ?? detalle;
    } catch {
      /* la respuesta no era JSON */
    }
    throw Object.assign(new Error(detalle), { estado: respuesta.status });
  }
  return respuesta.json() as Promise<T>;
}

export async function entrar(url: string, nombre: string, clave: string): Promise<SesionDeBanda> {
  const destino = normalizarUrl(url);
  await pedir<{ falab: boolean }>({ url: destino }, "GET", "/banda/info").catch(() => {
    throw new Error("En esa dirección no hay un servidor de falab. Revisa que esté bien escrita.");
  });
  const { testigo, usuario } = await pedir<{ testigo: string; usuario: SesionDeBanda["usuario"] }>(
    { url: destino }, "POST", "/banda/sesion", { nombre, clave });
  const sesion = { url: destino, testigo, usuario };
  recordar(sesion);
  return sesion;
}

export async function salir(sesion: SesionDeBanda): Promise<void> {
  recordar(null);
  await pedir(sesion, "DELETE", "/banda/sesion").catch(() => undefined);
}

/** Biblioteca y cola de la banda. Si la sesión caducó, se olvida y se lanza un error con `estado` 401. */
export async function canciones(sesion: SesionDeBanda): Promise<{ canciones: CancionDeBanda[]; cola: EnCola[] }> {
  try {
    return await pedir(sesion, "GET", "/banda/canciones");
  } catch (error) {
    if ((error as { estado?: number }).estado === 401) recordar(null);
    throw error;
  }
}

export const urlDelPaquete = (sesion: SesionDeBanda, id: string): string => `${sesion.url}/banda/canciones/${id}/paquete`;

/** Enlace de descarga normal (válido dos minutos) para guardar el .falab en el dispositivo. */
export async function enlaceDeDescarga(sesion: SesionDeBanda, id: string): Promise<string> {
  const { pase } = await pedir<{ pase: string }>(sesion, "POST", `/banda/canciones/${id}/pase`);
  return `${urlDelPaquete(sesion, id)}?pase=${encodeURIComponent(pase)}`;
}

/** Sube una canción para que la Mac la analice. Informa del avance de la subida (0–1). */
export function subir(sesion: SesionDeBanda, archivo: File, separarCoros: boolean, alAvanzar: (fraccion: number) => void): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const formulario = new FormData();
    formulario.append("archivo", archivo);
    formulario.append("separarCoros", separarCoros ? "1" : "");
    // XMLHttpRequest y no fetch: es la forma de conocer el avance de una subida.
    const peticion = new XMLHttpRequest();
    peticion.open("POST", `${sesion.url}/banda/canciones`);
    peticion.setRequestHeader("Authorization", `Bearer ${sesion.testigo}`);
    peticion.upload.onprogress = (e) => e.lengthComputable && alAvanzar(e.loaded / e.total);
    peticion.onerror = () => rechazar(new Error("Se cortó la conexión durante la subida."));
    peticion.onload = () => {
      if (peticion.status >= 200 && peticion.status < 300) return resolver();
      let detalle = `Error ${peticion.status}`;
      try {
        detalle = JSON.parse(peticion.responseText).detail ?? detalle;
      } catch {
        /* sin detalle */
      }
      rechazar(new Error(detalle));
    };
    peticion.send(formulario);
  });
}

/** Lee por tramos un .falab que está en la Mac de la banda. */
export class LectorDeBanda implements Lector {
  constructor(private url: string, readonly tamano: number, private testigo: string) {}

  async leer(desde: number, cuantos: number): Promise<Uint8Array> {
    const hasta = Math.min(this.tamano, desde + cuantos) - 1;
    if (hasta < desde) return new Uint8Array(0);
    const respuesta = await fetch(this.url, { headers: { Authorization: `Bearer ${this.testigo}`, Range: `bytes=${desde}-${hasta}` } });
    if (respuesta.status !== 206 && respuesta.status !== 200) {
      throw new Error(respuesta.status === 401 ? "La sesión de la banda ha caducado." : "No se pudo leer la canción desde la Mac de la banda.");
    }
    const bytes = new Uint8Array(await respuesta.arrayBuffer());
    // Si el servidor ignorase el rango y enviara todo, se recorta aquí.
    return respuesta.status === 200 ? bytes.subarray(desde, hasta + 1) : bytes;
  }
}
