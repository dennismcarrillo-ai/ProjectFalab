import { usarApp, usarReproduccion } from "../estado/almacen";

/** Vista Karaoke: la línea actual con resaltado palabra a palabra y el acorde que suena. */
export function Karaoke() {
  const posicion = usarReproduccion((s) => s.posicion);
  const analisis = usarApp((s) => s.analisis);
  const segmentos = analisis?.letras.segmentos ?? [];
  if (!analisis || segmentos.length === 0) {
    return (
      <div className="karaoke">
        <p className="tenue">Este proyecto no tiene letra transcrita.<br />Importa la canción con «Transcribir la letra» activado (requiere Whisper).</p>
      </div>
    );
  }
  // Línea actual: la última que ya empezó (se adelanta 0,4 s para poder leerla antes de cantarla).
  let indice = 0;
  for (let i = 0; i < segmentos.length; i++) if (segmentos[i].inicio <= posicion + 0.4) indice = i;
  const actual = segmentos[indice];
  const acorde = analisis.acordes.find((a) => posicion >= a.inicio && posicion < a.fin);
  const palabras = actual.palabras.length ? actual.palabras : [{ inicio: actual.inicio, fin: actual.fin, texto: actual.texto }];
  return (
    <div className="karaoke">
      <div className="acorde-actual">{acorde?.nombre ?? ""}</div>
      <div className="anterior">{segmentos[indice - 1]?.texto ?? ""}</div>
      <div className="linea" aria-live="off">
        {palabras.map((p, i) => (
          <span key={i} className={`palabra ${posicion >= p.fin ? "cantada" : posicion >= p.inicio ? "sonando" : ""}`}>
            {p.texto}{" "}
          </span>
        ))}
      </div>
      <div className="siguiente">{segmentos[indice + 1]?.texto ?? ""}</div>
    </div>
  );
}
