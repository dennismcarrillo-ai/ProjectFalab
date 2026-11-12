/**
 * Biblioteca (Capa 1): proyectos con su ficha (peso, archivos, tempo, tonalidad) y playlists
 * con ordenación. Se usa a pantalla completa en el inicio y, compacta, en el panel lateral del
 * editor.
 */
import { useState } from "react";
import { usarApp } from "../estado/almacen";
import { enEscritorio } from "../servicios/motor";
import type { OrdenPlaylist, ResumenProyecto } from "../tipos";
import { formatearPeso, NOMBRES_ORDEN } from "../util/biblioteca";
import { formatearTiempo } from "../util/formato";

/** Columna de playlists: «Todos los proyectos», cada lista y el alta de una nueva. */
function ListaDePlaylists() {
  const playlists = usarApp((s) => s.playlists);
  const activa = usarApp((s) => s.playlistActiva);
  const total = usarApp((s) => s.proyectos.length);
  const { fijar, crearPlaylist } = usarApp.getState();
  const [nueva, fijarNueva] = useState("");
  const crear = () => {
    if (!nueva.trim()) return;
    void crearPlaylist(nueva.trim());
    fijarNueva("");
  };
  return (
    <div className="playlists">
      <h3>Playlists</h3>
      <button className={`playlist-fila ${activa === null ? "activo" : ""}`} onClick={() => fijar({ playlistActiva: null })}>
        <span className="crecer">Todos los proyectos</span><span className="tenue">{total}</span>
      </button>
      {playlists.map((lista) => (
        <button key={lista.id} className={`playlist-fila ${activa === lista.id ? "activo" : ""}`}
          onClick={() => fijar({ playlistActiva: lista.id })}>
          <span className="crecer">{lista.nombre}</span><span className="tenue">{lista.proyectos.length}</span>
        </button>
      ))}
      <div className="nueva-playlist">
        <input type="text" placeholder="Nueva playlist…" value={nueva} aria-label="Nombre de la nueva playlist"
          onChange={(e) => fijarNueva(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") crear(); }} />
        <button onClick={crear} disabled={!nueva.trim()} aria-label="Crear playlist">+</button>
      </div>
    </div>
  );
}

/** Cabecera de la lista: nombre editable de la playlist, orden y eliminar. */
function CabeceraDeLista({ compacta }: { compacta: boolean }) {
  const playlists = usarApp((s) => s.playlists);
  const activa = usarApp((s) => s.playlistActiva);
  const ordenGeneral = usarApp((s) => s.ordenGeneral);
  const { fijar, cambiarPlaylist, eliminarPlaylist } = usarApp.getState();
  const lista = playlists.find((l) => l.id === activa) ?? null;
  const [nombre, fijarNombre] = useState<string | null>(null);
  const orden = lista ? lista.orden : ordenGeneral;
  const cambiarOrden = (valor: OrdenPlaylist) => (lista ? void cambiarPlaylist(lista.id, { orden: valor }) : fijar({ ordenGeneral: valor }));
  return (
    <div className="cabecera-lista">
      {compacta ? (
        <select value={activa ?? ""} aria-label="Playlist" style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => fijar({ playlistActiva: e.target.value || null })}>
          <option value="">Todos los proyectos</option>
          {playlists.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
      ) : lista ? (
        <input className="nombre-proyecto" style={{ flex: 1 }} aria-label="Nombre de la playlist" value={nombre ?? lista.nombre}
          onChange={(e) => fijarNombre(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
          onBlur={() => {
            if (nombre?.trim() && nombre.trim() !== lista.nombre) void cambiarPlaylist(lista.id, { nombre: nombre.trim() });
            fijarNombre(null);
          }} />
      ) : (
        <strong className="crecer" style={{ padding: "4px 8px" }}>Todos los proyectos</strong>
      )}
      <select value={orden} aria-label="Orden" onChange={(e) => cambiarOrden(e.target.value as OrdenPlaylist)}
        style={compacta ? { width: 118 } : undefined}>
        {(Object.keys(NOMBRES_ORDEN) as OrdenPlaylist[]).map((clave) => (
          <option key={clave} value={clave}>{clave === "manual" && !lista ? "Más recientes" : NOMBRES_ORDEN[clave]}</option>
        ))}
      </select>
      {lista && !compacta && (
        <button className="plano" onClick={() => {
          if (window.confirm(`¿Eliminar la playlist «${lista.nombre}»? Los proyectos no se borran.`)) void eliminarPlaylist(lista.id);
        }}>Eliminar playlist</button>
      )}
    </div>
  );
}

function FilaDeProyecto({ p, posicion, compacta }: { p: ResumenProyecto; posicion: number; compacta: boolean }) {
  const playlists = usarApp((s) => s.playlists);
  const activa = usarApp((s) => s.playlistActiva);
  const abierto = usarApp((s) => s.proyecto?.id === p.id);
  const { abrir, eliminarProyecto, alternarEnPlaylist, moverEnPlaylist, exportarPaquete } = usarApp.getState();
  const lista = playlists.find((l) => l.id === activa) ?? null;
  const tonalidad = (p.tonalidadInicial ?? p.tonalidad)?.nombre ?? "—";

  const exportar = async () => {
    let destino: string | undefined;
    if (enEscritorio) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const carpeta = await open({ directory: true, title: "Carpeta donde guardar el proyecto" });
      if (typeof carpeta !== "string") return;
      destino = carpeta;
    }
    await exportarPaquete(p.id, destino);
  };

  if (compacta) {
    return (
      <button className={`proyecto-compacto ${abierto ? "activo" : ""}`} onClick={() => void abrir(p.id)}
        title={`${p.nombre} · ${tonalidad} · ${Math.round(p.bpm)} BPM`}>
        <span className="tenue mono">{posicion}</span>
        <span className="titulo">{p.nombre}</span>
        <span className="tenue mono">{tonalidad.replace(" mayor", "").replace(" menor", "m")}</span>
        <span className="tenue mono">{Math.round(p.bpm)}</span>
      </button>
    );
  }
  return (
    <div className={`proyecto-fila ${abierto ? "activo" : ""}`} onClick={() => void abrir(p.id)} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && void abrir(p.id)}>
      <span className="tenue mono" style={{ width: 22 }}>{posicion}</span>
      <span className="titulo">{p.nombre}{p.tieneVideo && <span className="etiqueta-video">video</span>}</span>
      <span className="dato mono" title="Tonalidad">{tonalidad}</span>
      <span className="dato mono" title="Tempo">{p.bpm.toFixed(1)} BPM</span>
      <span className="dato mono" title="Duración">{formatearTiempo(p.duracion, 0)}</span>
      <span className="dato mono tenue" title="Espacio en disco">{formatearPeso(p.peso)} · {p.archivos} archivos</span>
      <span className="acciones-fila" onClick={(e) => e.stopPropagation()}>
        {lista?.orden === "manual" && (
          <>
            <button className="plano paso" title="Subir" aria-label={`Subir ${p.nombre}`} onClick={() => void moverEnPlaylist(lista.id, p.id, -1)}>↑</button>
            <button className="plano paso" title="Bajar" aria-label={`Bajar ${p.nombre}`} onClick={() => void moverEnPlaylist(lista.id, p.id, 1)}>↓</button>
          </>
        )}
        {lista ? (
          <button className="plano" onClick={() => void alternarEnPlaylist(lista.id, p.id)}>Quitar</button>
        ) : playlists.length > 0 && (
          <select value="" aria-label={`Añadir ${p.nombre} a una playlist`} onChange={(e) => e.target.value && void alternarEnPlaylist(e.target.value, p.id)}>
            <option value="">Añadir a…</option>
            {playlists.map((l) => (
              <option key={l.id} value={l.id}>{l.proyectos.includes(p.id) ? "✓ " : ""}{l.nombre}</option>
            ))}
          </select>
        )}
        <button className="plano" title="Guardar el proyecto completo en un archivo .falab" onClick={() => void exportar()}>Exportar</button>
        <button className="plano" title="Eliminar el proyecto de este equipo" onClick={() => {
          if (window.confirm(`¿Eliminar «${p.nombre}» de este equipo? No se puede deshacer.`)) void eliminarProyecto(p.id);
        }}>Eliminar</button>
      </span>
    </div>
  );
}

export function Biblioteca({ compacta = false }: { compacta?: boolean }) {
  const proyectos = usarApp((s) => s.proyectos);
  // Se leen para que la cola se recalcule cuando cambian.
  usarApp((s) => s.playlists);
  usarApp((s) => s.playlistActiva);
  usarApp((s) => s.ordenGeneral);
  const cola = usarApp.getState().cola();
  const peso = cola.reduce((suma, p) => suma + p.peso, 0);
  const duracion = cola.reduce((suma, p) => suma + p.duracion, 0);

  if (proyectos.length === 0 && compacta) return <p className="tenue" style={{ padding: 12 }}>Aún no hay proyectos.</p>;
  if (proyectos.length === 0) return null;
  const contenido = (
    <div className="proyectos">
      <CabeceraDeLista compacta={compacta} />
      {cola.length === 0 && <p className="tenue" style={{ padding: "10px 12px" }}>
        Esta playlist está vacía. Ve a «Todos los proyectos» y usa «Añadir a…».
      </p>}
      {cola.map((p, i) => <FilaDeProyecto key={p.id} p={p} posicion={i + 1} compacta={compacta} />)}
      {cola.length > 0 && (
        <div className="pie-lista tenue">
          {cola.length} {cola.length === 1 ? "canción" : "canciones"} · {formatearTiempo(duracion, 0)} · {formatearPeso(peso)}
        </div>
      )}
    </div>
  );
  if (compacta) return contenido;
  return (
    <div className="biblioteca vidrio">
      <ListaDePlaylists />
      {contenido}
    </div>
  );
}
