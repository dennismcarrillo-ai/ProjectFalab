import { useEffect, useRef, useState } from "react";
import { usarApp, usarReproduccion } from "../estado/almacen";
import type { Cifrado, DetalleAcordes, LineaCancionero, SegmentoLetra } from "../tipos";
import { formatearTiempo } from "../util/formato";

/** Fila de acordes alineada por columnas con la letra (misma regla que la exportación TXT/PDF). */
function filaDeAcordes(linea: LineaCancionero): string {
  let fila = "";
  for (const marca of linea.acordes) {
    const columna = Math.max(marca.columna, fila.length + (fila ? 1 : 0));
    fila = fila.padEnd(columna) + marca.nombre;
  }
  return fila;
}

export function SelectorCifrado() {
  const cifrado = usarApp((s) => s.cifrado);
  return (
    <select value={cifrado} aria-label="Cifrado de acordes" onChange={(e) => void usarApp.getState().fijarCifrado(e.target.value as Cifrado)}>
      <option value="estandar">Cifrado estándar (Cm7)</option>
      <option value="jazz">Cifrado de jazz (C-7, CΔ7)</option>
      <option value="latino">Cifrado latino (Dom7)</option>
    </select>
  );
}

/** Cuántos acordes se muestran: con más detalle aparecen los acordes de paso. */
export function SelectorDetalle() {
  const detalle = usarApp((s) => s.analisis?.detalleAcordes) ?? "normal";
  return (
    <select value={detalle} aria-label="Detalle de los acordes" title="Con más detalle aparecen los acordes de paso"
      onChange={(e) => void usarApp.getState().recalcularAcordes(e.target.value as DetalleAcordes)}>
      <option value="normal">Acordes: esenciales</option>
      <option value="alto">Acordes: con acordes de paso</option>
      <option value="maximo">Acordes: máximo detalle</option>
    </select>
  );
}

/** Corrección manual de la letra: una caja de texto por línea. Vaciar una línea la elimina. */
function EditorDeLetra({ segmentos, alTerminar }: { segmentos: SegmentoLetra[]; alTerminar: () => void }) {
  const [textos, fijarTextos] = useState(() => segmentos.map((s) => s.texto));
  const [guardando, fijarGuardando] = useState(false);
  const guardar = async () => {
    fijarGuardando(true);
    await usarApp.getState().guardarLetras(segmentos.map((s, i) => ({ inicio: s.inicio, texto: textos[i] })));
    alTerminar();
  };
  return (
    <div className="cancionero">
      <p className="tenue" style={{ fontFamily: "inherit" }}>
        Corrige las palabras mal entendidas. La sincronía con la música se conserva; deja una línea vacía para eliminarla.
      </p>
      {segmentos.map((segmento, i) => (
        <div className="linea-editable" key={segmento.inicio}>
          <button className="plano mono tenue" title="Escuchar desde aquí"
            onClick={() => usarApp.getState().saltar(segmento.inicio)}>{formatearTiempo(segmento.inicio, 1)}</button>
          <input type="text" value={textos[i]} aria-label={`Línea ${i + 1} de la letra`}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => fijarTextos(textos.map((t, j) => (j === i ? e.target.value : t)))} />
        </div>
      ))}
      <div className="barra-vista" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button onClick={alTerminar} disabled={guardando}>Cancelar</button>
        <button className="primario" onClick={() => void guardar()} disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar la letra"}
        </button>
      </div>
    </div>
  );
}

/** Vista Cancionero: letra con acordes encima; la línea que suena se resalta y se sigue sola. */
export function Cancionero() {
  const analisis = usarApp((s) => s.analisis);
  const proyecto = usarApp((s) => s.proyecto)!;
  const lineas = analisis?.cancionero ?? [];
  const actual = usarReproduccion((s) => {
    let indice = -1;
    for (let i = 0; i < lineas.length; i++) if (lineas[i].inicio <= s.posicion) indice = i;
    return indice;
  });
  const reproduciendo = usarReproduccion((s) => s.estado === "reproduciendo");
  const [editando, fijarEditando] = useState(false);
  const segmentos = analisis?.letras.segmentos ?? [];
  const refActual = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reproduciendo) refActual.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [actual, reproduciendo]);

  return (
    <div className="vista-lectura">
      <div className="barra-vista">
        <strong style={{ fontSize: 18 }}>{proyecto.nombre}</strong>
        <span className="tenue">Tonalidad: {analisis?.tonalidad.nombre ?? "—"} · {Math.round(proyecto.bpm)} BPM</span>
        <span className="crecer" />
        {!editando && segmentos.length > 0 && <button onClick={() => fijarEditando(true)}>Editar letra</button>}
        <SelectorDetalle />
        <SelectorCifrado />
      </div>
      {!editando && (analisis?.ostinatos.length ?? 0) > 0 && (
        <p className="tenue" style={{ maxWidth: 900, margin: "0 auto 14px" }}>
          Ostinato de bajo: {analisis!.ostinatos.map((o) => `${o.nombre} (×${o.repeticiones})`).join(" · ")}
        </p>
      )}
      {editando ? <EditorDeLetra segmentos={segmentos} alTerminar={() => fijarEditando(false)} /> : (
      <div className="cancionero">
        {lineas.length === 0 && <p className="tenue">No se detectaron letra ni acordes en este proyecto.</p>}
        {lineas.map((linea, i) => (
          <div key={i} ref={i === actual ? refActual : undefined}
            className={`linea ${i === actual ? "actual" : ""} ${linea.tipo === "instrumental" ? "instrumental" : ""}`}
            onClick={() => usarApp.getState().saltar(linea.inicio)}>
            {linea.tipo === "letra" && <div className="fila-acordes">{filaDeAcordes(linea) || " "}</div>}
            <div>{linea.texto}</div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
