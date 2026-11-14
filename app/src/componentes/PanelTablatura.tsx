import { useState } from "react";
import { usarApp } from "../estado/almacen";
import { CON_TRASTES, NOMBRES_INSTRUMENTO, VisorPartitura } from "./VisorPartitura";

/** Panel derecho: tablatura del instrumento elegido, visible junto al editor o al karaoke. */
export function PanelTablatura() {
  const disponibles = usarApp((s) => s.analisis?.pistasConNotas) ?? [];
  const [instrumento, fijarInstrumento] = useState("");
  const elegido = instrumento || disponibles.find((d) => d === "bajo") || disponibles.find((d) => CON_TRASTES.includes(d)) || disponibles[0] || "";
  return (
    <aside className="panel-tablatura" aria-label="Tablatura">
      <div className="cabecera-lista">
        <strong className="crecer">Tablatura</strong>
        <select value={elegido} aria-label="Instrumento de la tablatura" onChange={(e) => fijarInstrumento(e.target.value)}>
          {disponibles.map((id) => <option key={id} value={id}>{NOMBRES_INSTRUMENTO[id] ?? id}</option>)}
        </select>
        <button className="plano" aria-label="Cerrar la tablatura" onClick={() => usarApp.getState().fijar({ panelTablatura: false })}>✕</button>
      </div>
      {elegido
        ? <VisorPartitura instrumento={elegido} modo={CON_TRASTES.includes(elegido) ? "tablatura" : "partitura"} escala={0.8} />
        : <p className="tenue" style={{ padding: 12 }}>No hay notas detectadas en este proyecto.</p>}
    </aside>
  );
}
