/**
 * Diálogo previo al procesado: falab ya escuchó tres extractos de la canción y propone qué
 * pistas crear. El usuario confirma o cambia la propuesta antes de lanzar el análisis completo.
 */
import { useState } from "react";
import { usarApp } from "../estado/almacen";
import { formatearTiempo } from "../util/formato";

const INSTRUMENTOS: { id: string; nombre: string }[] = [
  { id: "voz", nombre: "Voz" }, { id: "bajo", nombre: "Bajo" }, { id: "bateria", nombre: "Batería" },
  { id: "guitarra", nombre: "Guitarra" }, { id: "piano", nombre: "Piano" },
];

export function DialogoPreanalisis() {
  const importacion = usarApp((s) => s.importacion)!;
  const { previo, opciones, ruta, nombre } = importacion;
  const presentes = previo.instrumentos ?? {};
  // Propuesta inicial: una pista por cada instrumento que realmente suena.
  const [elegidas, fijarElegidas] = useState<string[]>(() => INSTRUMENTOS.map((i) => i.id).filter((id) => presentes[id]?.presente ?? true));
  const [coros, fijarCoros] = useState(previo.coros?.sugerido ?? false);
  const [guitarras, fijarGuitarras] = useState(false); // experimental: nunca se marca sola
  const alternar = (id: string) => fijarElegidas(elegidas.includes(id) ? elegidas.filter((x) => x !== id) : [...elegidas, id]);

  const cerrar = () => usarApp.setState({ importacion: null, dialogo: null });
  const procesar = () => {
    cerrar();
    void usarApp.getState().importar(ruta, {
      ...opciones,
      pistas: [...elegidas, "otros"],
      separarCoros: coros && elegidas.includes("voz"),
      separarGuitarras: guitarras && elegidas.includes("guitarra"),
    });
  };

  const etiqueta = (sugerido: boolean | undefined, medible: boolean) =>
    !medible ? null : sugerido
      ? <span className="insignia sugerido">Sugerido</span>
      : <span className="insignia">No detectado</span>;

  return (
    <div className="velo">
      <div className="dialogo vidrio" role="dialog" aria-label="Qué separar" style={{ width: 600 }}>
        <h2>¿Qué quieres separar?</h2>
        <p className="tenue">
          «{nombre}» · {formatearTiempo(previo.duracion, 0)}{previo.tieneVideo ? " · con video" : ""}. falab ha escuchado
          tres fragmentos de la canción y propone esto; cámbialo si quieres.
        </p>

        <h3>Pistas</h3>
        {INSTRUMENTOS.map(({ id, nombre: instrumento }) => {
          const hay = presentes[id]?.presente ?? true;
          return (
            <label className="fila-opcion" key={id} style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={elegidas.includes(id)} onChange={() => alternar(id)} />
              <span className="descripcion">{instrumento}</span>
              {hay ? <span className="insignia sugerido">Detectado</span> : <span className="insignia">Apenas suena</span>}
            </label>
          );
        })}
        <div className="fila-opcion">
          <input type="checkbox" checked disabled aria-label="Otros" />
          <span className="descripcion">
            Otros
            <div className="tenue" style={{ fontSize: 11.5 }}>Todo lo demás, más lo que no marques arriba: no se pierde audio.</div>
          </span>
        </div>

        <h3>Divisiones adicionales</h3>
        <label className="fila-opcion" style={{ cursor: "pointer", opacity: elegidas.includes("voz") ? 1 : 0.5 }}>
          <input type="checkbox" checked={coros && elegidas.includes("voz")} disabled={!elegidas.includes("voz")}
            onChange={(e) => fijarCoros(e.target.checked)} />
          <span className="descripcion">
            Separar coros de la voz principal
            <div className="tenue" style={{ fontSize: 11.5 }}>
              {previo.corosNeuronal
                ? "Con el modelo neuronal de coros (tarda más)."
                : "Por posición en la mezcla: funciona cuando los coros están abiertos a los lados."}
            </div>
          </span>
          {etiqueta(previo.coros?.sugerido, previo.coros?.anchuraDb != null)}
        </label>
        <label className="fila-opcion" style={{ cursor: "pointer", opacity: elegidas.includes("guitarra") ? 1 : 0.5 }}>
          <input type="checkbox" checked={guitarras && elegidas.includes("guitarra")} disabled={!elegidas.includes("guitarra")}
            onChange={(e) => fijarGuitarras(e.target.checked)} />
          <span className="descripcion">
            Separar guitarra rítmica y solista <span className="insignia experimental">Experimental</span>
            <div className="tenue" style={{ fontSize: 11.5 }}>
              Por posición en la mezcla: la solista suele ir al centro y la rítmica a los lados. El resultado es
              irregular; si no convence, vuelve a importar sin esta opción.
            </div>
          </span>
          {etiqueta(previo.guitarras?.sugerido, previo.guitarras?.anchuraDb != null)}
        </label>

        <div className="pie">
          <button onClick={cerrar}>Cancelar</button>
          <button className="primario" onClick={procesar}>Procesar la canción</button>
        </div>
      </div>
    </div>
  );
}
