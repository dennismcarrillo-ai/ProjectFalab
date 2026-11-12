import { colorDeSeccion } from "../componentes/Directo";
import { usarApp, usarReproduccion } from "../estado/almacen";
import type { Acorde, Pulso } from "../tipos";

const ACORDES_POR_ADELANTADO = 4;

/** Pulsos que faltan desde `desde` hasta `hasta`, según el mapa de pulsos de la canción. */
function pulsosHasta(pulsos: Pulso[], desde: number, hasta: number): number {
  let cuenta = 0;
  for (const pulso of pulsos) {
    if (pulso.t > hasta + 0.02) break;
    if (pulso.t > desde) cuenta++;
  }
  return cuenta;
}

/**
 * Tira de acordes: el que suena ahora (con una barra que se va llenando hasta el cambio) y los
 * siguientes ya a la vista, cada uno con los pulsos que faltan. Así el músico ve venir el
 * cambio en lugar de enterarse cuando ya tiene que tocarlo.
 */
function TiraDeAcordes({ acordes, pulsos, posicion }: { acordes: Acorde[]; pulsos: Pulso[]; posicion: number }) {
  let indice = -1;
  for (let i = 0; i < acordes.length; i++) {
    if (acordes[i].inicio > posicion) break;
    indice = i;
  }
  const actual = indice >= 0 && posicion < acordes[indice].fin ? acordes[indice] : null;
  const proximos = acordes.slice(indice + 1, indice + 1 + ACORDES_POR_ADELANTADO);
  if (!actual && proximos.length === 0) return <div className="tira-acordes" />;
  const avance = actual ? Math.min(1, (posicion - actual.inicio) / Math.max(actual.fin - actual.inicio, 0.05)) : 0;
  return (
    <div className="tira-acordes" aria-label="Acordes">
      <div className={`acorde-caja actual ${actual ? "" : "vacio"}`}>
        <span className="nombre">{actual?.nombre ?? "·"}</span>
        <span className="barra"><span style={{ width: `${avance * 100}%` }} /></span>
      </div>
      {proximos.map((acorde, i) => {
        const faltan = pulsosHasta(pulsos, posicion, acorde.inicio);
        const segundos = acorde.inicio - posicion;
        // Sin mapa de pulsos se cuenta en segundos.
        const etiqueta = pulsos.length ? `en ${faltan}` : `${segundos.toFixed(1)} s`;
        const inminente = i === 0 && (pulsos.length ? faltan <= 1 : segundos < 0.6);
        return (
          <div key={acorde.inicio} className={`acorde-caja ${i === 0 ? "siguiente" : "lejano"} ${inminente ? "inminente" : ""}`}>
            <span className="nombre">{acorde.nombre}</span>
            <span className="falta">{etiqueta}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Vista Karaoke: acordes por adelantado y la letra con resaltado palabra a palabra. */
export function Karaoke() {
  const posicion = usarReproduccion((s) => s.posicion);
  const analisis = usarApp((s) => s.analisis);
  const segmentos = analisis?.letras.segmentos ?? [];
  if (!analisis) return <div className="karaoke" />;
  const seccion = analisis.secciones.find((s) => posicion >= s.inicio && posicion < s.fin);
  const proxima = seccion && analisis.secciones[analisis.secciones.indexOf(seccion) + 1];
  const tira = (
    <>
      <div className="seccion-actual">
        {seccion && <strong style={{ color: colorDeSeccion(seccion.nombre) }}>{seccion.nombre}</strong>}
        {proxima && <span className="tenue"> → {proxima.nombre} en {Math.max(0, Math.ceil(proxima.inicio - posicion))} s</span>}
      </div>
      <TiraDeAcordes acordes={analisis.acordes} pulsos={analisis.mapaTempo.pulsos} posicion={posicion} />
    </>
  );
  if (segmentos.length === 0) {
    return (
      <div className="karaoke">
        {tira}
        <p className="tenue">Este proyecto no tiene letra transcrita.<br />Importa la canción con «Transcribir la letra» activado (requiere Whisper).</p>
      </div>
    );
  }
  // Línea actual: la última que ya empezó (se adelanta 0,4 s para poder leerla antes de cantarla).
  let indice = 0;
  for (let i = 0; i < segmentos.length; i++) if (segmentos[i].inicio <= posicion + 0.4) indice = i;
  const actual = segmentos[indice];
  const palabras = actual.palabras.length ? actual.palabras : [{ inicio: actual.inicio, fin: actual.fin, texto: actual.texto }];
  return (
    <div className="karaoke">
      {tira}
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
