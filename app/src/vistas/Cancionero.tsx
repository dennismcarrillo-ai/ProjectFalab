import { useEffect, useRef } from "react";
import { usarApp, usarReproduccion } from "../estado/almacen";
import type { Cifrado, LineaCancionero } from "../tipos";

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
        <SelectorCifrado />
      </div>
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
    </div>
  );
}
