import { useEffect, useRef, useState } from "react";
import { usarApp } from "../estado/almacen";
import { motor } from "../servicios/motor";

const NOMBRES: Record<string, string> = { voz: "Voz", bajo: "Bajo", guitarra: "Guitarra", piano: "Piano", otros: "Otros" };

/** Vista Partitura: dibuja el MusicXML que genera el motor a partir de las notas de BasicPitch. */
export function Partitura() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const disponibles = usarApp((s) => s.analisis?.pistasConNotas) ?? [];
  const [instrumento, fijarInstrumento] = useState("");
  const [estado, fijarEstado] = useState<"cargando" | "lista" | "vacia" | "error">("cargando");
  const ref = useRef<HTMLDivElement>(null);
  const elegido = instrumento || disponibles[0] || "";

  useEffect(() => {
    let vigente = true;
    if (!elegido) {
      fijarEstado("vacia");
      return;
    }
    fijarEstado("cargando");
    (async () => {
      try {
        const xml = await motor.partitura(proyecto.id, elegido);
        // La biblioteca de grabado musical pesa más de 1 MB: solo se carga al abrir esta vista.
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (!vigente || !ref.current) return;
        ref.current.innerHTML = "";
        const visor = new OpenSheetMusicDisplay(ref.current, { autoResize: true, backend: "svg", drawTitle: true });
        await visor.load(xml);
        visor.render();
        if (vigente) fijarEstado("lista");
      } catch (error) {
        console.error(error);
        if (vigente) fijarEstado("error");
      }
    })();
    return () => {
      vigente = false;
    };
  }, [proyecto.id, elegido]);

  return (
    <div className="vista-lectura">
      <div className="barra-vista" style={{ maxWidth: 1100 }}>
        <strong style={{ fontSize: 18 }}>Partitura</strong>
        <span className="tenue">Transcripción automática: revísala antes de darla por buena.</span>
        <span className="crecer" />
        {disponibles.length > 0 && (
          <select value={elegido} aria-label="Instrumento" onChange={(e) => fijarInstrumento(e.target.value)}>
            {disponibles.map((id) => <option key={id} value={id}>{NOMBRES[id] ?? id}</option>)}
          </select>
        )}
      </div>
      {estado === "vacia" && <p className="tenue" style={{ textAlign: "center" }}>No hay notas detectadas. Importa la canción con «Extraer notas» activado (requiere BasicPitch).</p>}
      {estado === "error" && <p className="tenue" style={{ textAlign: "center" }}>No se pudo generar la partitura de este instrumento.</p>}
      {estado === "cargando" && <p className="tenue" style={{ textAlign: "center" }}>Preparando la partitura…</p>}
      <div className="partitura-papel" ref={ref} style={{ display: estado === "vacia" || estado === "error" ? "none" : "block" }} />
    </div>
  );
}
