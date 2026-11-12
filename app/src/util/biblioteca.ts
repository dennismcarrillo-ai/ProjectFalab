/** Ordenación de playlists y formato de tamaños. */
import type { OrdenPlaylist, Playlist, ResumenProyecto, Tonalidad } from "../tipos";

export const NOMBRES_ORDEN: Record<OrdenPlaylist, string> = {
  manual: "Orden manual",
  alfabetico: "Alfabético",
  duracion: "Duración",
  bpm: "Tempo (BPM)",
  tonalidad: "Tonalidad (Do, Do♯, Re…)",
  quintas: "Tonalidad (círculo de quintas)",
};

/** Para ordenar cuenta la tonalidad con la que ARRANCA la canción (importante en popurrís). */
const tonalidadDe = (p: ResumenProyecto): Tonalidad | null => p.tonalidadInicial ?? p.tonalidad;

/** Posición cromática: Do mayor, Do menor, Do♯ mayor… */
function cromatica(t: Tonalidad | null): number {
  return t ? t.tonica * 2 + (t.modo === "menor" ? 1 : 0) : 999;
}

/**
 * Posición en el círculo de quintas (Do, Sol, Re, La…), con cada tonalidad menor junto a su
 * relativa mayor. Canciones vecinas en este orden comparten casi todas sus notas, así que los
 * cambios entre ellas suenan naturales.
 */
function quintas(t: Tonalidad | null): number {
  if (!t) return 999;
  const mayorEquivalente = t.modo === "menor" ? (t.tonica + 3) % 12 : t.tonica;
  return ((mayorEquivalente * 7) % 12) * 2 + (t.modo === "menor" ? 1 : 0);
}

/** Proyectos de una playlist (o todos, si es null) en el orden elegido. */
export function ordenar(proyectos: ResumenProyecto[], playlist: Playlist | null, ordenLibre: OrdenPlaylist = "manual"): ResumenProyecto[] {
  const porId = new Map(proyectos.map((p) => [p.id, p]));
  const lista = playlist
    ? playlist.proyectos.map((id) => porId.get(id)).filter((p): p is ResumenProyecto => !!p)
    : [...proyectos];
  const orden = playlist ? playlist.orden : ordenLibre;
  const por = (clave: (p: ResumenProyecto) => number) => lista.sort((a, b) => clave(a) - clave(b) || a.nombre.localeCompare(b.nombre, "es"));
  switch (orden) {
    case "alfabetico":
      return lista.sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
    case "duracion":
      return por((p) => p.duracion);
    case "bpm":
      return por((p) => p.bpm ?? 0);
    case "tonalidad":
      return por((p) => cromatica(tonalidadDe(p)));
    case "quintas":
      return por((p) => quintas(tonalidadDe(p)));
    default:
      return lista; // manual: el orden guardado (o por fecha, en «Todos los proyectos»)
  }
}

export function formatearPeso(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Mueve un elemento una posición arriba (-1) o abajo (+1). */
export function desplazar<T>(lista: T[], elemento: T, delta: number): T[] {
  const i = lista.indexOf(elemento);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= lista.length) return lista;
  const copia = [...lista];
  [copia[i], copia[j]] = [copia[j], copia[i]];
  return copia;
}
