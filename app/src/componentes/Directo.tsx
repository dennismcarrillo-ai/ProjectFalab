/** Diálogos del directo: estructura de la canción (marcadores, compás, guías) y pedal. */
import { useEffect, useState } from "react";
import { nombreDeDisparador, usarApp, usarReproduccion } from "../estado/almacen";
import { motor } from "../servicios/motor";
import type { AccionPedal, Seccion } from "../tipos";
import { formatearTiempo } from "../util/formato";

export const NOMBRES_DE_SECCION = ["Intro", "Verso", "Pre-coro", "Coro", "Puente", "Solo", "Instrumental", "Final"];

export const COLORES_DE_SECCION: Record<string, string> = {
  Intro: "#64748b", Verso: "#38bdf8", "Pre-coro": "#a78bfa", Coro: "#f472b6", Puente: "#facc15",
  Solo: "#fb923c", Instrumental: "#5eead4", Final: "#64748b",
};
export const colorDeSeccion = (nombre: string): string => COLORES_DE_SECCION[nombre] ?? "#94a3b8";

export function DialogoEstructura() {
  const secciones = usarApp((s) => s.analisis?.secciones) ?? [];
  const compas = usarApp((s) => s.proyecto?.compas) ?? 4;
  const bpm = usarApp((s) => s.proyecto?.bpm) ?? 120;
  const tieneGuias = usarApp((s) => s.proyecto?.pistas.some((p) => p.instrumento === "guias"));
  const { fijar, guardarEstructura, detectarEstructura, corregirMapa, generarGuias, saltar } = usarApp.getState();

  const cambiar = (indice: number, parcial: Partial<Seccion>) =>
    void guardarEstructura(secciones.map((s, i) => (i === indice ? { ...s, ...parcial } : s)));
  const anadir = () => {
    const cursor = usarReproduccion.getState().posicion;
    void guardarEstructura([...secciones, { inicio: cursor, fin: cursor, nombre: "Verso" }]);
  };

  return (
    <div className="velo" onPointerDown={(e) => e.target === e.currentTarget && fijar({ dialogo: null })}>
      <div className="dialogo vidrio" role="dialog" aria-label="Estructura de la canción" style={{ width: 620 }}>
        <h2>Estructura de la canción</h2>
        <p className="tenue">
          Marcadores de ensayo. La detección automática acierta mejor dónde cambia la música que cómo se llama
          cada parte: corrige los nombres que haga falta.
        </p>
        <datalist id="nombres-de-seccion">{NOMBRES_DE_SECCION.map((n) => <option key={n} value={n} />)}</datalist>
        {secciones.length === 0 && <p className="tenue">Aún no hay marcadores.</p>}
        {secciones.map((seccion, i) => (
          <div className="fila-opcion" key={`${seccion.inicio}-${seccion.nombre}-${seccion.compas ?? ""}`}>
            <span style={{ width: 8, height: 22, borderRadius: 3, background: colorDeSeccion(seccion.nombre) }} />
            <button className="plano mono" title="Ir a este punto" onClick={() => saltar(seccion.inicio)}>
              {formatearTiempo(seccion.inicio, 1)}
            </button>
            <input type="text" list="nombres-de-seccion" defaultValue={seccion.nombre} aria-label={`Nombre de la sección ${i + 1}`}
              style={{ flex: 1, userSelect: "text" }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== seccion.nombre && cambiar(i, { nombre: e.target.value.trim() })} />
            <select value={seccion.compas ?? ""} aria-label={`Compás desde la sección ${i + 1}`}
              title="Compás desde esta sección en adelante (como en una partitura)"
              onChange={(e) => cambiar(i, { compas: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Compás: igual</option>
              {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}/4</option>)}
            </select>
            <button className="plano" aria-label={`Eliminar la sección ${i + 1}`} disabled={i === 0}
              title={i === 0 ? "La primera sección no se puede eliminar" : "Eliminar el marcador (se une a la sección anterior)"}
              onClick={() => void guardarEstructura(secciones.filter((_, j) => j !== i))}>Eliminar</button>
          </div>
        ))}
        <div className="pie" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <button onClick={anadir}>Añadir marcador en el cursor</button>
          <button onClick={() => void detectarEstructura()}>Detectar automáticamente</button>
        </div>

        <h3>Guías de voz</h3>
        <div className="fila-opcion">
          <span className="descripcion">
            Pista que anuncia cada sección y cuenta el compás de entrada
            <div className="tenue" style={{ fontSize: 11.5 }}>
              Por ejemplo «Coro, dos, tres, cuatro», a tempo. Se genera con la voz de este equipo y aparece como
              una pista más, con su volumen y su silencio.
            </div>
          </span>
          <button className="primario" disabled={secciones.length === 0} onClick={() => void generarGuias()}>
            {tieneGuias ? "Regenerar" : "Generar"}
          </button>
        </div>

        <h3>Corregir el tempo detectado ({bpm.toFixed(1)} BPM · {compas}/4)</h3>
        <div className="pie" style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 0 }}>
          <button onClick={() => void corregirMapa("doble")} title="Si el metrónomo marca la mitad de los pulsos">Marcar el doble de pulsos</button>
          <button onClick={() => void corregirMapa("mitad")} title="Si el metrónomo marca el doble de pulsos">Marcar la mitad</button>
          <button onClick={() => void corregirMapa("desplazar")} title="Si el acento del metrónomo no cae en el primer tiempo">Mover el tiempo «1» un pulso</button>
        </div>
        <div className="pie"><button onClick={() => fijar({ dialogo: null })}>Cerrar</button></div>
      </div>
    </div>
  );
}

const ACCIONES: { clave: AccionPedal; nombre: string; fija: string }[] = [
  { clave: "reproducir", nombre: "Reproducir / Pausar", fija: "Espacio" },
  { clave: "siguiente", nombre: "Canción siguiente", fija: "AvPág" },
  { clave: "anterior", nombre: "Canción anterior", fija: "RePág" },
];

export function DialogoPedal() {
  const pedal = usarApp((s) => s.pedal);
  const { fijar, fijarPedal, aprender } = usarApp.getState();
  const [esperando, fijarEsperando] = useState<AccionPedal | null>(null);
  const [midi, fijarMidi] = useState<{ disponible: boolean; puertos: string[]; error: string | null } | null>(null);

  const explorar = () => motor.midi.estado().then(fijarMidi).catch(() => fijarMidi({ disponible: false, puertos: [], error: "No se pudo consultar el MIDI." }));
  useEffect(() => {
    void explorar();
    return () => aprender(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const asignar = (accion: AccionPedal) => {
    fijarEsperando(accion);
    aprender((disparador) => {
      fijarEsperando(null);
      // Un mismo pedal no puede hacer dos cosas: se quita de las demás acciones.
      const limpio = Object.fromEntries(ACCIONES.map(({ clave }) => [
        clave, (pedal[clave] ?? []).filter((d) => JSON.stringify(d) !== JSON.stringify(disparador)),
      ]));
      void fijarPedal({ ...limpio, [accion]: [...(limpio[accion] ?? []), disparador] });
    });
  };

  return (
    <div className="velo" onPointerDown={(e) => e.target === e.currentTarget && fijar({ dialogo: null })}>
      <div className="dialogo vidrio" role="dialog" aria-label="Pedal">
        <h2>Pedal y controles del directo</h2>
        <p className="tenue">
          Pulsa «Asignar» y después pisa el pedal. Sirven los pedales MIDI (USB o Bluetooth) y los que
          funcionan como teclado (pasapáginas).
        </p>
        {ACCIONES.map(({ clave, nombre, fija }) => (
          <div className="fila-opcion" key={clave}>
            <span className="descripcion">
              {nombre}
              <div className="tenue" style={{ fontSize: 11.5 }}>
                {[fija, ...(pedal[clave] ?? []).map(nombreDeDisparador)].join(" · ")}
              </div>
            </span>
            {(pedal[clave] ?? []).length > 0 && (
              <button className="plano" onClick={() => void fijarPedal({ ...pedal, [clave]: [] })}>Quitar</button>
            )}
            <button className={esperando === clave ? "activo" : ""} onClick={() => asignar(clave)}>
              {esperando === clave ? "Pisa el pedal…" : "Asignar"}
            </button>
          </div>
        ))}
        <h3>Dispositivos MIDI</h3>
        {!midi && <p className="tenue">Buscando…</p>}
        {midi && !midi.disponible && <p className="tenue">{midi.error ?? "MIDI no disponible."}</p>}
        {midi?.disponible && (
          <p className="tenue">
            {midi.puertos.length ? midi.puertos.join(" · ") : "No se detecta ningún dispositivo MIDI."}
            {midi.error && ` (${midi.error})`}
          </p>
        )}
        <p className="tenue" style={{ fontSize: 11.5 }}>
          Un pedal Bluetooth debe emparejarse antes en «Configuración de Audio MIDI» de macOS. Si lo conectas
          con falab ya abierto y no aparece, cierra y vuelve a abrir la aplicación.
        </p>
        <div className="pie">
          <button onClick={() => void explorar()}>Buscar dispositivos</button>
          <button onClick={() => fijar({ dialogo: null })}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
