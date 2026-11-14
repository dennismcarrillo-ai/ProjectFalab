import { useEffect, useState } from "react";
import { Aviso, DialogoDrive, DialogoExportar, Progreso } from "./componentes/Dialogos";
import { DialogoEstructura, DialogoPedal } from "./componentes/Directo";
import { Biblioteca } from "./componentes/Biblioteca";
import { Editor } from "./componentes/Editor";
import { Inicio } from "./componentes/Inicio";
import { PanelTablatura } from "./componentes/PanelTablatura";
import { Transporte } from "./componentes/Transporte";
import { DialogoGrabacion, VentanaVideo, VistaPreviaDeCamara } from "./componentes/Video";
import { usarApp, usarReproduccion, type Vista } from "./estado/almacen";
import { IconoExportar, IconoNube } from "./util/iconos";
import { Cancionero } from "./vistas/Cancionero";
import { Karaoke } from "./vistas/Karaoke";
import { Partitura } from "./vistas/Partitura";

const VISTAS: { id: Vista; nombre: string }[] = [
  { id: "editor", nombre: "Editor" },
  { id: "karaoke", nombre: "Karaoke" },
  { id: "cancionero", nombre: "Cancionero" },
  { id: "partitura", nombre: "Partitura" },
];
const TEXTO_GUARDADO = { guardado: "Guardado", pendiente: "Sin guardar…", guardando: "Guardando…", error: "Error al guardar" };

function NombreProyecto() {
  const nombre = usarApp((s) => s.proyecto!.nombre);
  const [texto, fijarTexto] = useState(nombre);
  useEffect(() => fijarTexto(nombre), [nombre]);
  return (
    <input className="nombre-proyecto" value={texto} aria-label="Nombre del proyecto"
      onChange={(e) => fijarTexto(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => (texto.trim() ? usarApp.getState().ajustarProyecto({ nombre: texto.trim() }) : fijarTexto(nombre))} />
  );
}

function CuentaRegresiva() {
  const cuenta = usarReproduccion((s) => (s.estado === "cuenta" ? s.cuenta : 0));
  return cuenta > 0 ? <div className="cuenta-gigante" aria-live="assertive">{cuenta}</div> : null;
}

/** Atajos de teclado globales del editor. */
function usarAtajos() {
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      const app = usarApp.getState();
      // Un pedal que actúa como teclado: su tecla asignada manda sobre los atajos normales.
      const campo = (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "text";
      if (!campo && !e.metaKey && !e.ctrlKey && (app.aprendiendo || app.proyecto)) {
        if (app.aprendiendo && e.key === "Escape") { app.aprender(null); return; }
        if (app.disparar({ tipo: "tecla", codigo: e.code })) { e.preventDefault(); return; }
      }
      if (!app.proyecto || app.dialogo || app.trabajo) return;
      const objetivo = e.target as HTMLElement;
      if (objetivo.tagName === "INPUT" && (objetivo as HTMLInputElement).type !== "range" && (objetivo as HTMLInputElement).type !== "checkbox") return;
      if (objetivo.tagName === "SELECT") return;
      const orden = e.metaKey || e.ctrlKey;
      const tecla = e.key.toLowerCase();
      const hecho = () => e.preventDefault();
      if (e.code === "Space") { hecho(); app.alternarReproduccion(); }
      else if (e.key === "Enter" || e.key === "Home") { hecho(); app.detener(); }
      else if (orden && tecla === "z") { hecho(); e.shiftKey ? app.rehacer() : app.deshacer(); }
      else if (orden && tecla === "c") { hecho(); app.copiar(); }
      else if (orden && tecla === "x") { hecho(); app.cortar(); }
      else if (orden && tecla === "v") { hecho(); app.pegar(); }
      else if (orden && tecla === "d") { hecho(); app.duplicar(); }
      else if (!orden && tecla === "s") { hecho(); app.dividirEnCursor(); }
      else if (!orden && tecla === "l") { hecho(); app.alternarBucle(); }
      else if (!orden && tecla === "b") { hecho(); app.fijar({ panelLateral: !app.panelLateral }); }
      else if (!orden && tecla === "t") { hecho(); app.fijar({ panelTablatura: !app.panelTablatura }); }
      else if (!orden && tecla === "r") { hecho(); void app.alternarGrabacion(); }
      else if (e.key === "PageDown") { hecho(); void app.irA(1); }
      else if (e.key === "PageUp") { hecho(); void app.irA(-1); }
      else if (e.key === "Delete" || e.key === "Backspace") { hecho(); app.eliminarSeleccion(); }
      else if (e.key === "Escape") { app.seleccionar([], null); app.fijarRango(null); }
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, []);
}

export function App() {
  const proyecto = usarApp((s) => s.proyecto);
  const vista = usarApp((s) => s.vista);
  const dialogo = usarApp((s) => s.dialogo);
  const guardado = usarApp((s) => s.guardado);
  const salud = usarApp((s) => s.salud);
  const errorMotor = usarApp((s) => s.errorMotor);
  const panelLateral = usarApp((s) => s.panelLateral);
  const panelTablatura = usarApp((s) => s.panelTablatura);
  const ventanaVideo = usarApp((s) => s.ventanaVideo);
  const vistaPrevia = usarApp((s) => s.grabacion?.vistaPrevia ?? null);
  const hayVideo = !!proyecto && (proyecto.medioOriginal.tieneVideo || (proyecto.videos ?? []).length > 0);
  usarApp((s) => s.proyectos);
  usarApp((s) => s.playlists);
  usarApp((s) => s.playlistActiva);
  usarApp((s) => s.ordenGeneral);
  const { conectar, fijar, cerrar, irA } = usarApp.getState();
  const cola = usarApp.getState().cola();
  const indice = proyecto ? cola.findIndex((p) => p.id === proyecto.id) : -1;
  const anterior = indice > 0 ? cola[indice - 1] : undefined;
  const siguiente = indice >= 0 ? cola[indice + 1] : undefined;
  usarAtajos();
  useEffect(() => void conectar(), [conectar]);

  let contenido;
  if (errorMotor) {
    contenido = (
      <div className="inicio">
        <div className="portada vidrio" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <h2 style={{ margin: 0 }}>No se pudo arrancar el motor de falab</h2>
          <p>El motor es el programa local (Python) que hace el análisis de audio. Ejecuta <strong>scripts/instalar_mac.sh</strong> y vuelve a abrir la aplicación.</p>
          <div className="codigo">{errorMotor}</div>
          <button className="primario" onClick={() => { fijar({}); usarApp.setState({ errorMotor: null }); void conectar(); }}>Reintentar</button>
        </div>
      </div>
    );
  } else if (!salud) {
    contenido = <div className="inicio"><p className="tenue">Arrancando el motor de audio…</p></div>;
  } else if (!proyecto) {
    contenido = <Inicio />;
  } else {
    contenido = (
      <>
        <Transporte />
        <div className="zona-trabajo">
          {panelLateral && (
            <aside className="panel-lateral" aria-label="Playlists y proyectos">
              <Biblioteca compacta />
            </aside>
          )}
          <div className="zona-vista">
            {vista === "editor" && <Editor />}
            {vista === "karaoke" && <Karaoke />}
            {vista === "cancionero" && <Cancionero />}
            {vista === "partitura" && <Partitura />}
          </div>
          {panelTablatura && vista !== "partitura" && <PanelTablatura />}
        </div>
        <CuentaRegresiva />
      </>
    );
  }

  return (
    <div className="app">
      <header className="barra-superior">
        <div className="marca"><img src="/icono.svg" alt="" />falab</div>
        {proyecto && (
          <>
            <button className={panelLateral ? "activo" : ""} onClick={() => fijar({ panelLateral: !panelLateral })}
              title="Mostrar u ocultar playlists y proyectos (B)" aria-label="Panel de playlists" aria-pressed={panelLateral}>☰</button>
            <button disabled={!anterior} onClick={() => void irA(-1)} aria-label="Canción anterior"
              title={anterior ? `Anterior: ${anterior.nombre}` : "No hay canción anterior en esta lista"}>⏮</button>
            <NombreProyecto />
            <button disabled={!siguiente} onClick={() => void irA(1)} aria-label="Canción siguiente"
              title={siguiente ? `Siguiente: ${siguiente.nombre}` : "No hay canción siguiente en esta lista"}>⏭</button>
            <nav className="pestanas" aria-label="Vistas">
              {VISTAS.map((v) => (
                <button key={v.id} className={vista === v.id ? "activo" : ""} onClick={() => fijar({ vista: v.id })}>{v.nombre}</button>
              ))}
            </nav>
            <span className="crecer" />
            <span className="estado-guardado">{TEXTO_GUARDADO[guardado]}</span>
            {hayVideo && (
              <button className={ventanaVideo ? "activo" : ""} aria-pressed={!!ventanaVideo} title="Ventana de video sincronizada (V)"
                onClick={() => fijar({ ventanaVideo: ventanaVideo ? null : proyecto!.medioOriginal.tieneVideo ? "original" : proyecto!.videos![0].id })}>
                Video
              </button>
            )}
            <button className={panelTablatura ? "activo" : ""} aria-pressed={panelTablatura} disabled={vista === "partitura"}
              onClick={() => fijar({ panelTablatura: !panelTablatura })} title="Tablatura sincronizada en un panel lateral (T)">Tablatura</button>
            <button onClick={() => fijar({ dialogo: "pedal" })} title="Asignar un pedal MIDI o de teclado">Pedal</button>
            <button onClick={() => fijar({ dialogo: "drive" })} title="Sincronizar con Google Drive"><IconoNube /> Drive</button>
            <button className="primario" onClick={() => fijar({ dialogo: "exportar" })}><IconoExportar /> Exportar</button>
            <button className="plano" onClick={() => void cerrar()}>Cerrar proyecto</button>
          </>
        )}
      </header>
      {contenido}
      {dialogo === "exportar" && proyecto && <DialogoExportar />}
      {dialogo === "drive" && <DialogoDrive />}
      {dialogo === "estructura" && proyecto && <DialogoEstructura />}
      {dialogo === "pedal" && <DialogoPedal />}
      {dialogo === "grabacion" && <DialogoGrabacion />}
      {proyecto && ventanaVideo && !vistaPrevia && <VentanaVideo />}
      {vistaPrevia && <VistaPreviaDeCamara flujo={vistaPrevia} />}
      <Progreso />
      <Aviso />
    </div>
  );
}
