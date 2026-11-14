import { colorDeSeccion } from "../componentes/Directo";
import { useEffect, useRef, useState } from "react";
import { usarApp, usarReproduccion } from "../estado/almacen";
import { motor } from "../servicios/motor";
import type { Acorde, Nota, Pulso } from "../tipos";

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

const SEGUNDOS_ANTES = 1.5;
const SEGUNDOS_DESPUES = 6;

/**
 * Carril de notas de la voz (como en los juegos de karaoke): las notas vienen desde la derecha,
 * de modo que se ven varias por adelantado; al cruzar la línea del «ahora» se van rellenando de
 * color. La altura de cada barra es la altura de la nota.
 */
function CarrilDeNotas({ idProyecto }: { idProyecto: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [notas, fijarNotas] = useState<Nota[]>([]);
  useEffect(() => {
    let vigente = true;
    motor.notas(idProyecto, "voz").then((r) => vigente && fijarNotas(r.notas)).catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [idProyecto]);

  useEffect(() => {
    const lienzo = ref.current;
    if (!lienzo || notas.length === 0) return;
    // Rango de alturas de toda la canción, con margen, para que el carril no «salte».
    const tonos = notas.map((n) => n.tono).sort((a, b) => a - b);
    const grave = tonos[Math.floor(tonos.length * 0.02)] - 2;
    const agudo = tonos[Math.ceil(tonos.length * 0.98) - 1] + 2;
    const pintar = ({ posicion }: { posicion: number }) => {
      const escala = window.devicePixelRatio || 1;
      const ancho = lienzo.clientWidth, alto = lienzo.clientHeight;
      if (lienzo.width !== Math.round(ancho * escala)) {
        lienzo.width = Math.round(ancho * escala);
        lienzo.height = Math.round(alto * escala);
      }
      const c = lienzo.getContext("2d")!;
      c.setTransform(escala, 0, 0, escala, 0, 0);
      c.clearRect(0, 0, ancho, alto);
      const desde = posicion - SEGUNDOS_ANTES, hasta = posicion + SEGUNDOS_DESPUES;
      const x = (t: number) => ((t - desde) / (hasta - desde)) * ancho;
      const grosor = Math.max(5, Math.min(14, (alto - 16) / (agudo - grave + 1)));
      const y = (tono: number) => 8 + (1 - (Math.min(agudo, Math.max(grave, tono)) - grave) / (agudo - grave)) * (alto - 16 - grosor);
      const ahora = x(posicion);
      for (const nota of notas) {
        if (nota.fin < desde) continue;
        if (nota.inicio > hasta) break;
        const x0 = x(nota.inicio), x1 = Math.max(x0 + 3, x(nota.fin));
        c.fillStyle = "rgba(255,255,255,.26)";
        c.beginPath(); c.roundRect(x0, y(nota.tono), x1 - x0, grosor, grosor / 2); c.fill();
        if (x0 < ahora) {  // parte ya cantada (o cantándose): barrido de color
          c.save();
          c.beginPath(); c.rect(x0, 0, Math.min(x1, ahora) - x0, alto); c.clip();
          c.fillStyle = nota.fin > posicion ? "#5eead4" : "rgba(94,234,212,.45)";
          c.beginPath(); c.roundRect(x0, y(nota.tono), x1 - x0, grosor, grosor / 2); c.fill();
          c.restore();
        }
      }
      c.fillStyle = "#fff";
      c.fillRect(ahora - 1, 4, 2, alto - 8);
    };
    pintar(usarReproduccion.getState());
    return usarReproduccion.subscribe(pintar);  // se redibuja sin re-renderizar React
  }, [notas]);

  if (notas.length === 0) return null;
  return <canvas ref={ref} className="carril-notas" aria-label="Notas de la voz" />;
}

/** Vista Karaoke: acordes por adelantado y la letra con resaltado palabra a palabra. */
export function Karaoke() {
  const posicion = usarReproduccion((s) => s.posicion);
  const analisis = usarApp((s) => s.analisis);
  const idProyecto = usarApp((s) => s.proyecto!.id);
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
      <CarrilDeNotas idProyecto={idProyecto} />
      <div className="linea" aria-live="off">
        {palabras.map((p, i) => {
          const sonando = posicion >= p.inicio && posicion < p.fin;
          // La palabra que suena se rellena de color de izquierda a derecha (barrido).
          const barrido = sonando ? `${Math.round(((posicion - p.inicio) / Math.max(p.fin - p.inicio, 0.05)) * 100)}%` : undefined;
          return (
            <span key={i} className={`palabra ${posicion >= p.fin ? "cantada" : sonando ? "sonando" : ""}`}
              style={barrido ? ({ "--barrido": barrido } as React.CSSProperties) : undefined}>
              {p.texto}{" "}
            </span>
          );
        })}
      </div>
      <div className="siguiente">{segmentos[indice + 1]?.texto ?? ""}</div>
    </div>
  );
}
