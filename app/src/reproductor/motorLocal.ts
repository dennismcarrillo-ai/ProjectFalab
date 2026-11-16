/**
 * Motor local del reproductor (iPad): atiende, sin Python, las mismas peticiones que la interfaz
 * hace al motor de escritorio, leyendo directamente los proyectos .falab.
 *
 * Así el resto de la app (reproductor de audio, karaoke, cancionero, partitura…) es el mismo
 * código en el escritorio y en el iPad; solo cambia quién responde.
 *
 * Lo que NO hace: analizar canciones, editar clips ni exportar. Eso sigue siendo del escritorio.
 */
import type { Analisis, Cifrado, Nota, Playlist, Proyecto, ResumenProyecto } from "../tipos";
import { DecodificadorFlac } from "./flac";
import { borrarProyecto, copiarAlAlmacen, listarProyectos, sistemaDeArchivos } from "./almacen";
import { LectorDeBlob, type Lector } from "./lector";
import { ponerNombres, type AnalisisSinNombres } from "./nombres";
import { Paquete } from "./zip";

interface DatosDelReproductor extends AnalisisSinNombres {
  version: number;
  mapaTempo: Analisis["mapaTempo"];
  secciones: Analisis["secciones"];
  detalleAcordes: Analisis["detalleAcordes"];
  letras: Analisis["letras"];
  notasVoz: Nota[];
  pistasConNotas: string[];
  partituras: Record<string, Record<string, { tex: string; modo: string; conTrastes: boolean; compases: { inicio: number; fin: number }[] }>>;
}

interface Abierto {
  paquete: Paquete;
  proyecto: Proyecto;
  datos: DatosDelReproductor;
  audio: Map<string, Promise<DecodificadorFlac>>;
}

interface Origen {
  archivo: string;
  lector: Lector;
  /** Dónde está guardado en el dispositivo (null = elegido solo para esta sesión, en un navegador). */
  base: "datos" | "documentos" | null;
}

const enTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const CLAVE_RESUMENES = "falab.reproductor.resumenes";
const CLAVE_BIBLIOTECA = "falab.reproductor.biblioteca";
const claveDeMezcla = (id: string) => `falab.reproductor.mezcla.${id}`;
/** Lo único que se puede cambiar en el reproductor: la mezcla y cómo se reproduce. */
const CAMPOS_DE_MEZCLA = ["velocidad", "tono", "volumenMaestro", "metronomo"] as const;
const CAMPOS_DE_PISTA = ["volumen", "paneo", "silencio", "solo", "tono", "reverb", "eq"] as const;

function leerAlmacen<T>(clave: string, porDefecto: T): T {
  try {
    return { ...porDefecto, ...JSON.parse(localStorage.getItem(clave) ?? "{}") };
  } catch {
    return porDefecto;
  }
}
function escribirAlmacen(clave: string, valor: unknown): void {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    /* sin almacenamiento: los cambios valen solo para esta sesión */
  }
}

const json = (valor: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(valor)).buffer as ArrayBuffer;

export class MotorLocal {
  /** Proyectos disponibles, por identificador. */
  private origenes = new Map<string, Origen>();
  private resumenes = new Map<string, ResumenProyecto>();
  private abiertos = new Map<string, Promise<Abierto>>();
  /** Problemas encontrados al leer archivos (se muestran una vez en la biblioteca). */
  avisos: string[] = [];

  // ------------------------------------------------------------------ biblioteca del dispositivo

  /** Registra un .falab: lee su ficha (o la recupera de la caché) y lo deja listo para abrir. */
  private async registrar(archivo: string, lector: Lector, base: Origen["base"]): Promise<string> {
    const cache = leerAlmacen<Record<string, ResumenProyecto>>(CLAVE_RESUMENES, {});
    const clave = `${archivo}:${lector.tamano}`;
    let resumen = cache[clave];
    if (!resumen) {
      const paquete = await Paquete.abrir(lector);
      if (!paquete.tiene("reproductor.json")) {
        throw new Error(`«${archivo}» se exportó con una versión antigua de falab. Vuelve a exportarlo desde la Mac.`);
      }
      const proyecto = await paquete.json<Proyecto>("proyecto.json");
      const datos = await paquete.json<DatosDelReproductor>("reproductor.json");
      const tonalidad = datos.acordes.length ? ponerNombres({ ...datos, cancionero: [] }, "estandar", 0).tonalidad : null;
      resumen = {
        id: proyecto.id, nombre: proyecto.nombre, modificado: proyecto.modificado, duracion: proyecto.duracion, bpm: proyecto.bpm,
        pistas: proyecto.pistas.length, peso: lector.tamano, archivos: paquete.nombres().length, tieneVideo: false,
        tonalidad, tonalidadInicial: null,
      };
      cache[clave] = resumen;
      escribirAlmacen(CLAVE_RESUMENES, cache);
    }
    this.origenes.set(resumen.id, { archivo, lector, base });
    this.resumenes.set(resumen.id, resumen);
    this.abiertos.delete(resumen.id); // por si es una versión nueva del mismo proyecto
    return resumen.id;
  }

  /**
   * Añade proyectos elegidos por el usuario. En la app (Android, iPad) se copian al almacén del
   * dispositivo y quedan guardados; en un navegador valen solo para la sesión.
   */
  async anadirArchivos(archivos: File[], alAvanzar: (fraccion: number, nombre: string) => void = () => {}): Promise<void> {
    for (const [i, archivo] of archivos.entries()) {
      try {
        if (!archivo.name.toLowerCase().endsWith(".falab")) {
          throw new Error(`«${archivo.name}» no es un proyecto de falab (.falab).`);
        }
        if (!enTauri) {
          await this.registrar(archivo.name, new LectorDeBlob(archivo), null);
          continue;
        }
        // Antes de copiar cientos de MB se comprueba que el archivo sirve.
        const paquete = await Paquete.abrir(new LectorDeBlob(archivo));
        if (!paquete.tiene("reproductor.json")) {
          throw new Error(`«${archivo.name}» se exportó con una versión antigua de falab. Vuelve a exportarlo desde la Mac.`);
        }
        const fs = await sistemaDeArchivos();
        await copiarAlAlmacen(fs, archivo, (fraccion) => alAvanzar((i + fraccion) / archivos.length, archivo.name));
      } catch (error) {
        this.avisos.push((error as Error).message || `No se pudo añadir «${archivo.name}».`);
      }
    }
    await this.explorarDispositivo();
  }

  /** Vuelve a mirar qué proyectos hay guardados en el dispositivo. */
  async explorarDispositivo(): Promise<void> {
    if (!enTauri) return;
    const fs = await sistemaDeArchivos();
    const vistos = new Set<string>();
    for (const archivo of await listarProyectos(fs)) {
      try {
        vistos.add(await this.registrar(archivo.nombre, archivo.lector, archivo.base));
      } catch (error) {
        this.avisos.push((error as Error).message);
      }
    }
    // Lo que ya no está en el dispositivo desaparece de la biblioteca.
    for (const [id, origen] of this.origenes) {
      if (origen.base !== null && !vistos.has(id)) {
        this.origenes.delete(id);
        this.resumenes.delete(id);
        this.abiertos.delete(id);
      }
    }
  }

  private abrir(id: string): Promise<Abierto> {
    let abierto = this.abiertos.get(id);
    if (!abierto) {
      const origen = this.origenes.get(id);
      if (!origen) return Promise.reject(new Error("Ese proyecto ya no está en este dispositivo."));
      abierto = (async () => {
        const paquete = await Paquete.abrir(origen.lector);
        return {
          paquete,
          proyecto: await paquete.json<Proyecto>("proyecto.json"),
          datos: await paquete.json<DatosDelReproductor>("reproductor.json"),
          audio: new Map(),
        };
      })();
      this.abiertos.set(id, abierto);
      abierto.catch(() => this.abiertos.delete(id));
      // Solo se mantienen abiertos el proyecto actual y el siguiente del show.
      for (const otro of [...this.abiertos.keys()].slice(0, -2)) this.abiertos.delete(otro);
    }
    return abierto;
  }

  private async proyecto(id: string): Promise<Proyecto> {
    const { proyecto } = await this.abrir(id);
    // Encima del proyecto del archivo se aplica la mezcla que el usuario dejó en este dispositivo.
    const mezcla = leerAlmacen<Partial<Proyecto> & { pistas?: Record<string, Record<string, unknown>> }>(claveDeMezcla(id), {});
    const resultado: Proyecto = { ...proyecto, videos: [], medioOriginal: { ...proyecto.medioOriginal, tieneVideo: false } };
    for (const campo of CAMPOS_DE_MEZCLA) if (mezcla[campo] !== undefined) (resultado as any)[campo] = mezcla[campo];
    resultado.pistas = proyecto.pistas.map((pista) => ({ ...pista, ...(mezcla.pistas?.[pista.id] ?? {}) }));
    return resultado;
  }

  private guardarMezcla(id: string, recibido: Proyecto): void {
    const mezcla: Record<string, unknown> = {};
    for (const campo of CAMPOS_DE_MEZCLA) mezcla[campo] = recibido[campo];
    mezcla.pistas = Object.fromEntries(recibido.pistas.map((pista) => [
      pista.id, Object.fromEntries(CAMPOS_DE_PISTA.map((campo) => [campo, pista[campo]])),
    ]));
    escribirAlmacen(claveDeMezcla(id), mezcla);
  }

  private async pcm(id: string, fuente: string, inicio: number, frames: number): Promise<ArrayBuffer> {
    const abierto = await this.abrir(id);
    let decodificador = abierto.audio.get(fuente);
    if (!decodificador) {
      const datos = abierto.proyecto.fuentes.find((f) => f.id === fuente);
      if (!datos) throw new Error("Fuente desconocida.");
      decodificador = abierto.paquete.archivo(datos.archivo).then((lector) => DecodificadorFlac.abrir(lector));
      abierto.audio.set(fuente, decodificador);
    }
    const muestras = await (await decodificador).leer(inicio, frames);
    return muestras.buffer as ArrayBuffer;
  }

  private async analisis(id: string, cifrado: Cifrado, transponer: number): Promise<Analisis> {
    const { datos } = await this.abrir(id);
    return {
      ...ponerNombres(datos, cifrado, transponer),
      mapaTempo: datos.mapaTempo,
      secciones: datos.secciones,
      letras: datos.letras,
      pistasConNotas: datos.pistasConNotas,
      detalleAcordes: datos.detalleAcordes,
      letraEditada: false,
    };
  }

  // ------------------------------------------------------------------ peticiones

  /** Atiende una petición con la misma forma (método, ruta, cuerpo) que la API del motor de escritorio. */
  async atender(metodo: string, rutaCompleta: string, cuerpo?: unknown): Promise<ArrayBuffer> {
    const [ruta, consulta = ""] = rutaCompleta.split("?");
    const q = new URLSearchParams(consulta);
    const partes = ruta.split("/").filter(Boolean);
    const es = (...patron: (string | null)[]) =>
      partes.length === patron.length && patron.every((p, i) => p === null || p === partes[i]);

    if (es("salud")) {
      return json({ estado: "ok", version: "reproductor", carpetaDatos: "", reproductor: true,
        componentes: { ffmpeg: false, rubberband: false, demucs: false, basicPitch: false, whisper: false } });
    }
    if (es("proyectos") && metodo === "GET") {
      await this.explorarDispositivo();
      return json([...this.resumenes.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")));
    }
    if (es("biblioteca")) return json(leerAlmacen(CLAVE_BIBLIOTECA, { playlists: [] as Playlist[], ajustes: { driveAutomatico: false } }));
    if (es("biblioteca", "playlists") && metodo === "PUT") {
      const actual = leerAlmacen(CLAVE_BIBLIOTECA, { playlists: [] as Playlist[], ajustes: { driveAutomatico: false } });
      const playlists = ((cuerpo as { playlists: Playlist[] }).playlists ?? []).map((lista) => ({
        ...lista, id: lista.id || Math.random().toString(36).slice(2, 12),
      }));
      escribirAlmacen(CLAVE_BIBLIOTECA, { ...actual, playlists });
      return json({ playlists });
    }
    if (es("biblioteca", "ajustes") && metodo === "PUT") {
      const actual = leerAlmacen(CLAVE_BIBLIOTECA, { playlists: [] as Playlist[], ajustes: { driveAutomatico: false } });
      const ajustes = { ...actual.ajustes, ...(cuerpo as object), driveAutomatico: false };
      escribirAlmacen(CLAVE_BIBLIOTECA, { ...actual, ajustes });
      return json({ ajustes });
    }
    if (es("reverb", "ir")) return (await fetch("/reverb-ir.f32")).arrayBuffer();
    if (es("midi", "estado")) return json({ disponible: false, puertos: [], ultimo: 0, error: null });
    if (es("drive", "estado")) return json({ configurado: false, conectado: false, rutaCredenciales: "", automatico: false, pendientes: [], ultimoError: null, ultimaSincronizacion: null });

    if (partes[0] === "proyectos" && partes[1]) {
      const id = partes[1];
      if (partes.length === 2 && metodo === "GET") return json(await this.proyecto(id));
      if (partes.length === 2 && metodo === "PUT") {
        this.guardarMezcla(id, cuerpo as Proyecto);
        return json({ modificado: new Date().toISOString() });
      }
      if (partes.length === 2 && metodo === "DELETE") {
        const origen = this.origenes.get(id);
        if (origen?.base) await borrarProyecto(await sistemaDeArchivos(), { nombre: origen.archivo, base: origen.base });
        this.origenes.delete(id);
        this.resumenes.delete(id);
        this.abiertos.delete(id);
        return json({ eliminado: true });
      }
      if (es("proyectos", null, "analisis")) {
        return json(await this.analisis(id, (q.get("cifrado") ?? "estandar") as Cifrado, Number(q.get("transponer") ?? 0)));
      }
      if (es("proyectos", null, "fuentes", null, "pcm")) {
        return this.pcm(id, partes[3], Number(q.get("inicio") ?? 0), Number(q.get("frames") ?? 0));
      }
      if (es("proyectos", null, "fuentes", null, "picos")) return new ArrayBuffer(0); // el reproductor no dibuja ondas
      if (es("proyectos", null, "notas")) {
        const { datos } = await this.abrir(id);
        return json({ notas: q.get("instrumento") === "voz" ? datos.notasVoz : [] });
      }
      if (es("proyectos", null, "alphatex")) {
        const { datos } = await this.abrir(id);
        const partitura = datos.partituras[q.get("instrumento") ?? ""]?.[q.get("modo") ?? "ambas"]
          ?? datos.partituras[q.get("instrumento") ?? ""]?.partitura;
        if (!partitura) throw new Error("No hay notas detectadas para este instrumento.");
        return json(partitura);
      }
    }
    throw new Error("Esta función solo está disponible en falab para Mac.");
  }
}

export const motorLocal = new MotorLocal();
