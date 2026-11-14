import { useState } from "react";
import { CON_TRASTES, NOMBRES_INSTRUMENTO, VisorPartitura, type ModoPartitura } from "../componentes/VisorPartitura";
import { usarApp } from "../estado/almacen";

/** Vista Partitura: pentagrama y/o tablatura del instrumento elegido, siguiendo la reproducción. */
export function Partitura() {
  const disponibles = usarApp((s) => s.analisis?.pistasConNotas) ?? [];
  const [instrumento, fijarInstrumento] = useState("");
  const [modo, fijarModo] = useState<ModoPartitura>("ambas");
  const elegido = instrumento || disponibles.find((d) => CON_TRASTES.includes(d)) || disponibles[0] || "";
  const conTrastes = CON_TRASTES.includes(elegido);

  return (
    <div className="vista-lectura vista-partitura">
      <div className="barra-vista" style={{ maxWidth: 1100 }}>
        <strong style={{ fontSize: 18 }}>Partitura</strong>
        <span className="tenue">Transcripción automática: sirve para ensayar; revísala antes de darla por buena. Haz clic en un compás para ir a él.</span>
        <span className="crecer" />
        {disponibles.length > 0 && (
          <>
            <select value={conTrastes ? modo : "partitura"} disabled={!conTrastes} aria-label="Qué mostrar"
              onChange={(e) => fijarModo(e.target.value as ModoPartitura)}>
              <option value="ambas">Partitura y tablatura</option>
              <option value="partitura">Solo partitura</option>
              <option value="tablatura">Solo tablatura</option>
            </select>
            <select value={elegido} aria-label="Instrumento" onChange={(e) => fijarInstrumento(e.target.value)}>
              {disponibles.map((id) => <option key={id} value={id}>{NOMBRES_INSTRUMENTO[id] ?? id}</option>)}
            </select>
          </>
        )}
      </div>
      {elegido
        ? <VisorPartitura instrumento={elegido} modo={conTrastes ? modo : "partitura"} />
        : <p className="tenue" style={{ textAlign: "center" }}>No hay notas detectadas. Importa la canción con «Extraer notas» activado (requiere BasicPitch).</p>}
    </div>
  );
}
