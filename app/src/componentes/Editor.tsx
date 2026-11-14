/**
 * Editor: línea de tiempo multipista con regla de compases, carril de acordes, clips
 * arrastrables/recortables y cabeceras de mezcla.
 *
 * Rendimiento: las ondas se dibujan en un <canvas> por pista del tamaño de la ventana visible
 * (no del proyecto entero) a partir de picos precalculados; hacer zoom o desplazarse nunca
 * decodifica audio ni crea lienzos gigantes.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FRECUENCIA } from "../audio/protocolo";
import { colocar, finDe, imantar, mover, recortarFin, recortarInicio, vecinos } from "../edicion/operaciones";
import { duracionDe, usarApp, usarReproduccion } from "../estado/almacen";
import type { Clip, Pista, Proyecto, Pulso } from "../tipos";
import { formatearDb, formatearTiempo } from "../util/formato";
import { FRAMES_POR_PICO, usarPicos } from "../util/picos";
import { colorDeSeccion } from "./Directo";
import { Inspector } from "./Inspector";
import { PanelEq } from "./PanelEq";

const ANCHO_CABECERA = 264;
const ALTO_PISTA = 92;

interface Ventana {
  izquierda: number; // scroll horizontal en píxeles
  ancho: number;     // ancho visible del carril
}

function prepararLienzo(lienzo: HTMLCanvasElement, ancho: number, alto: number): CanvasRenderingContext2D {
  const escala = window.devicePixelRatio || 1;
  if (lienzo.width !== Math.round(ancho * escala) || lienzo.height !== Math.round(alto * escala)) {
    lienzo.width = Math.round(ancho * escala);
    lienzo.height = Math.round(alto * escala);
    lienzo.style.width = `${ancho}px`;
    lienzo.style.height = `${alto}px`;
  }
  const c = lienzo.getContext("2d")!;
  c.setTransform(escala, 0, 0, escala, 0, 0);
  c.clearRect(0, 0, ancho, alto);
  return c;
}

// ------------------------------------------------------------------ regla

function Regla({ ventana, zoom, pulsos, anchoTotal }: { ventana: Ventana; zoom: number; pulsos: Pulso[]; anchoTotal: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const acordes = usarApp((s) => s.analisis?.acordes) ?? [];
  const secciones = usarApp((s) => s.analisis?.secciones) ?? [];
  const lineaBajo = usarApp((s) => s.analisis?.lineaBajo) ?? [];
  const ostinatos = usarApp((s) => s.analisis?.ostinatos) ?? [];
  const { saltar, fijarRango } = usarApp.getState();

  useEffect(() => {
    const c = prepararLienzo(ref.current!, ventana.ancho, 26);
    const t0 = ventana.izquierda / zoom;
    const t1 = (ventana.izquierda + ventana.ancho) / zoom;
    c.font = "10.5px ui-monospace, Menlo, monospace";
    c.textBaseline = "top";
    if (pulsos.length >= 4) {
      // Regla musical: las líneas siguen el mapa de pulsos real (no son equidistantes).
      const pxPorPulso = (60 / (pulsos[0].bpm || 120)) * zoom;
      const cadaCompases = Math.max(1, Math.pow(2, Math.ceil(Math.log2(56 / (pxPorPulso * 4)))));
      for (const pulso of pulsos) {
        if (pulso.t < t0 - 1 || pulso.t > t1) continue;
        const x = Math.round(pulso.t * zoom - ventana.izquierda) + 0.5;
        if (pulso.pulso === 1) {
          const etiquetar = (pulso.compas - 1) % cadaCompases === 0;
          c.strokeStyle = etiquetar ? "#6b7480" : "#3a4047";
          c.beginPath(); c.moveTo(x, etiquetar ? 0 : 14); c.lineTo(x, 26); c.stroke();
          if (etiquetar) {
            c.fillStyle = "#aab2bb";
            c.fillText(String(pulso.compas), x + 4, 3);
          }
        } else if (pxPorPulso > 9) {
          c.strokeStyle = "#2c3136";
          c.beginPath(); c.moveTo(x, 19); c.lineTo(x, 26); c.stroke();
        }
      }
    } else {
      const pasos = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
      const paso = pasos.find((p) => p * zoom >= 70) ?? 300;
      for (let t = Math.floor(t0 / paso) * paso; t <= t1; t += paso) {
        const x = Math.round(t * zoom - ventana.izquierda) + 0.5;
        c.strokeStyle = "#6b7480";
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 26); c.stroke();
        c.fillStyle = "#aab2bb";
        c.fillText(formatearTiempo(t, 0), x + 4, 3);
      }
    }
  }, [ventana, zoom, pulsos]);

  /** Clic = mover el cursor. Arrastrar = marcar un tramo (para copiar, repetir en bucle…). */
  const alPulsar = (e: React.PointerEvent<HTMLDivElement>) => {
    const caja = e.currentTarget.getBoundingClientRect();
    const tiempo = (x: number) => Math.max(0, (x - caja.left) / zoom);
    const origen = tiempo(e.clientX);
    const { iman } = usarApp.getState();
    const puntos = pulsos.map((p) => p.t);
    const ajustar = (t: number, ev: { altKey: boolean }) => (iman && !ev.altKey ? imantar(t, puntos, 8 / zoom) : t);
    let arrastrado = false;
    const alMover = (ev: PointerEvent) => {
      if (!arrastrado && Math.abs(ev.clientX - e.clientX) < 4) return;
      arrastrado = true;
      const a = ajustar(origen, ev), b = ajustar(tiempo(ev.clientX), ev);
      fijarRango({ inicio: Math.min(a, b), fin: Math.max(a, b) });
    };
    const alSoltar = () => {
      window.removeEventListener("pointermove", alMover);
      window.removeEventListener("pointerup", alSoltar);
      if (!arrastrado) saltar(origen);
    };
    window.addEventListener("pointermove", alMover);
    window.addEventListener("pointerup", alSoltar);
  };

  const t0 = ventana.izquierda / zoom, t1 = (ventana.izquierda + ventana.ancho) / zoom;
  return (
    <div className="carril regla" style={{ width: anchoTotal }} onPointerDown={alPulsar}
      onDoubleClick={() => fijarRango(null)} title="Clic: mover el cursor · Arrastrar: marcar un tramo · Doble clic: quitar el tramo">
      <canvas ref={ref} />
      <div className="secciones-carril">
        {secciones.filter((s) => s.fin >= t0 && s.inicio <= t1).map((s) => (
          <span key={s.inicio} className="seccion-marca" title={`${s.nombre}${s.compas ? ` · ${s.compas}/4` : ""}`}
            style={{ left: s.inicio * zoom, width: Math.max(0, (s.fin - s.inicio) * zoom - 2), background: colorDeSeccion(s.nombre) }}>
            {s.nombre}{s.compas ? ` · ${s.compas}/4` : ""}
          </span>
        ))}
      </div>
      <div className="acordes-carril">
        {acordes.filter((a) => a.fin >= t0 && a.inicio <= t1).map((a) => (
          <span key={a.inicio} className={`acorde-marca ${a.pedal ? "pedal" : ""}`}
            title={a.pedal ? `${a.nombre} · nota pedal en el bajo` : a.nombre}
            style={{ left: a.inicio * zoom, maxWidth: Math.max(0, (a.fin - a.inicio) * zoom - 1) }}>
            {a.nombre}
          </span>
        ))}
      </div>
      <div className="bajo-carril" title="Línea de bajo: la nota que toca el bajo, con independencia del acorde">
        {ostinatos.filter((o) => o.fin >= t0 && o.inicio <= t1).map((o) => (
          <span key={`o${o.inicio}`} className="ostinato-marca" title={`Ostinato de bajo: ${o.nombre} (×${o.repeticiones})`}
            style={{ left: o.inicio * zoom, width: (o.fin - o.inicio) * zoom }} />
        ))}
        {lineaBajo.filter((b) => b.fin >= t0 && b.inicio <= t1).map((b) => (
          <span key={b.inicio} className="bajo-marca" style={{ left: b.inicio * zoom, maxWidth: Math.max(0, (b.fin - b.inicio) * zoom - 1) }}>
            {(b.fin - b.inicio) * zoom > 13 ? b.nombre : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pista

function CabeceraPista({ pista }: { pista: Pista }) {
  const { ajustarPista, fijar } = usarApp.getState();
  const [ancla, fijarAncla] = useState<DOMRect | null>(null);
  const cerrar = useCallback(() => fijarAncla(null), []);
  const eqModificado = pista.tono !== 0 || Object.values(pista.eq).some((b) => b.ganancia !== 0);
  return (
    <div className="cabecera-pista" onPointerDown={() => fijar({ pistaActiva: pista.id })}>
      <span className="color" style={{ background: pista.color }} />
      <div className="linea">
        <span className="nombre">{pista.nombre}</span>
        <button className={`boton-mini silencio ${pista.silencio ? "activo" : ""}`} title="Silenciar" aria-pressed={pista.silencio}
          onClick={() => ajustarPista(pista.id, { silencio: !pista.silencio })}>M</button>
        <button className={`boton-mini solo ${pista.solo ? "activo" : ""}`} title="Solo" aria-pressed={pista.solo}
          onClick={() => ajustarPista(pista.id, { solo: !pista.solo })}>S</button>
        <button className={`boton-mini eq ${eqModificado ? "modificado" : ""}`} title="Ecualizador de 3 bandas y tono de la pista"
          onClick={(e) => fijarAncla(ancla ? null : e.currentTarget.getBoundingClientRect())}>EQ</button>
      </div>
      <div className="linea" title="Volumen (doble clic: 0 dB)">
        <input type="range" min={-48} max={6} step={0.5} value={pista.volumen} aria-label={`Volumen de ${pista.nombre}`}
          onChange={(e) => ajustarPista(pista.id, { volumen: Number(e.target.value) })}
          onDoubleClick={() => ajustarPista(pista.id, { volumen: 0 })} />
        <span className="valor">{pista.volumen <= -48 ? "−∞" : formatearDb(pista.volumen)}</span>
      </div>
      <div className="linea" title="Paneo (doble clic: centro)">
        <input type="range" min={-1} max={1} step={0.02} value={pista.paneo} aria-label={`Paneo de ${pista.nombre}`}
          onChange={(e) => ajustarPista(pista.id, { paneo: Number(e.target.value) })}
          onDoubleClick={() => ajustarPista(pista.id, { paneo: 0 })} />
        <span className="valor">
          {Math.abs(pista.paneo) < 0.01 ? "Centro" : `${pista.paneo < 0 ? "I" : "D"} ${Math.round(Math.abs(pista.paneo) * 100)}`}
        </span>
      </div>
      {ancla && <PanelEq pista={pista} ancla={ancla} alCerrar={cerrar} />}
    </div>
  );
}

/** Dibuja la onda de un clip dentro de la ventana visible. */
function OndaDeClip({ c, clip, picos, ventana, zoom, color, atenuado }: {
  c: CanvasRenderingContext2D; clip: Clip; picos: Int8Array | null; ventana: Ventana; zoom: number; color: string; atenuado: boolean;
}) {
  const x0 = clip.inicio * zoom - ventana.izquierda;
  const x1 = finDe(clip) * zoom - ventana.izquierda;
  const desde = Math.max(0, Math.floor(x0)), hasta = Math.min(ventana.ancho, Math.ceil(x1));
  if (hasta <= desde) return;
  const alto = ALTO_PISTA - 12, medio = 6 + alto / 2;
  c.globalAlpha = atenuado ? 0.35 : 1;
  c.fillStyle = color + "38";
  c.fillRect(x0, 6, x1 - x0, alto);
  if (picos) {
    const ganancia = Math.pow(10, clip.ganancia / 20) * (alto / 2 - 2) / 127;
    const picosPorPx = FRECUENCIA / FRAMES_POR_PICO / zoom;
    c.fillStyle = color;
    for (let x = desde; x < hasta; x++) {
      const enFuente = clip.desplazamiento + (x + ventana.izquierda) / zoom - clip.inicio;
      const a = Math.floor((enFuente * FRECUENCIA) / FRAMES_POR_PICO);
      const b = Math.max(a + 1, Math.floor(a + picosPorPx));
      let minimo = 127, maximo = -127;
      for (let i = a; i < b; i++) {
        const j = i * 2;
        if (j < 0 || j + 1 >= picos.length) continue;
        if (picos[j] < minimo) minimo = picos[j];
        if (picos[j + 1] > maximo) maximo = picos[j + 1];
      }
      if (maximo < minimo) continue;
      const arriba = medio - Math.min(alto / 2, maximo * ganancia);
      const abajo = medio - Math.max(-alto / 2, minimo * ganancia);
      c.fillRect(x, arriba, 1, Math.max(1, abajo - arriba));
    }
  }
  c.globalAlpha = 1;
}

function FilaPista({ pista, proyecto, ventana, zoom, anchoTotal, pulsos }: {
  pista: Pista; proyecto: Proyecto; ventana: Ventana; zoom: number; anchoTotal: number; pulsos: Pulso[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const activa = usarApp((s) => s.pistaActiva === pista.id);
  const seleccionados = usarApp((s) => s.clipsSeleccionados);
  const fuentes = useMemo(() => [...new Set(pista.clips.map((c) => c.fuenteId))], [pista.clips]);
  // Una pista normalmente usa una sola fuente; se admiten hasta 2 distintas sin romper las reglas de hooks.
  const picosA = usarPicos(proyecto.id, fuentes[0] ?? pista.id);
  const picosB = usarPicos(proyecto.id, fuentes[1] ?? fuentes[0] ?? pista.id);
  const haySolo = proyecto.pistas.some((p) => p.solo);
  const atenuado = haySolo ? !pista.solo : pista.silencio;

  useEffect(() => {
    const c = prepararLienzo(ref.current!, ventana.ancho, ALTO_PISTA);
    for (const clip of pista.clips) {
      const picos = clip.fuenteId === fuentes[0] ? picosA : clip.fuenteId === fuentes[1] ? picosB : null;
      OndaDeClip({ c, clip, picos, ventana, zoom, color: pista.color, atenuado });
    }
  }, [pista.clips, pista.color, ventana, zoom, picosA, picosB, fuentes, atenuado]);

  const alPulsarClip = (e: React.PointerEvent, clip: Clip, modo: "mover" | "izquierda" | "derecha") => {
    e.stopPropagation();
    e.preventDefault();
    const app = usarApp.getState();
    const yaElegidos = app.clipsSeleccionados;
    app.seleccionar(
      e.shiftKey ? (yaElegidos.includes(clip.id) ? yaElegidos.filter((id) => id !== clip.id) : [...yaElegidos, clip.id]) : [clip.id],
      pista.id,
    );
    const x0 = e.clientX;
    const topes = vecinos(pista.clips, clip.id);
    const duracionFuente = (proyecto.fuentes.find((f) => f.id === clip.fuenteId)?.frames ?? 0) / FRECUENCIA;
    const puntos = [
      ...pulsos.map((p) => p.t),
      ...pista.clips.filter((c) => c.id !== clip.id).flatMap((c) => [c.inicio, finDe(c)]),
      usarReproduccion.getState().posicion,
    ];
    let movido = false;
    let ultimo = clip;
    const alMover = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!movido && Math.abs(dx) < 3) return;
      if (!movido) {
        movido = true;
        app.marcarHistorial(); // todo el arrastre es UNA sola operación deshacible
      }
      const dt = dx / zoom;
      const tolerancia = 8 / zoom;
      const ajustar = (t: number) => (usarApp.getState().iman && !ev.altKey ? imantar(t, puntos, tolerancia) : t);
      if (modo === "mover") {
        const libre = clip.inicio + dt;
        const porInicio = ajustar(libre);
        const porFin = ajustar(libre + clip.duracion) - clip.duracion;
        const inicio = porInicio !== libre ? porInicio : porFin;
        ultimo = mover(clip, inicio);
      } else if (modo === "izquierda") {
        ultimo = recortarInicio(clip, ajustar(clip.inicio + dt), topes.anterior);
      } else {
        ultimo = recortarFin(clip, ajustar(finDe(clip) + dt), duracionFuente, topes.siguiente);
      }
      app.editarClips(pista.id, (clips) => clips.map((c) => (c.id === clip.id ? ultimo : c)), false);
    };
    const alSoltar = () => {
      window.removeEventListener("pointermove", alMover);
      window.removeEventListener("pointerup", alSoltar);
      // Al soltar un clip movido encima de otros, sobrescribe lo que pisa.
      if (movido && modo === "mover") app.editarClips(pista.id, (clips) => colocar(clips, [ultimo]), false);
    };
    window.addEventListener("pointermove", alMover);
    window.addEventListener("pointerup", alSoltar);
  };

  const alPulsarCarril = (e: React.PointerEvent<HTMLDivElement>) => {
    const caja = e.currentTarget.getBoundingClientRect();
    const app = usarApp.getState();
    app.seleccionar([], pista.id);
    app.saltar((e.clientX - caja.left) / zoom);
  };

  const t0 = ventana.izquierda / zoom, t1 = (ventana.izquierda + ventana.ancho) / zoom;
  return (
    <div className={`fila fila-pista ${activa ? "activa" : ""}`}>
      <CabeceraPista pista={pista} />
      <div className="carril" style={{ width: anchoTotal }} onPointerDown={alPulsarCarril}>
        <canvas ref={ref} />
        {pista.clips.filter((c) => finDe(c) >= t0 && c.inicio <= t1).map((clip) => (
          <div
            key={clip.id}
            className={`clip ${seleccionados.includes(clip.id) ? "seleccionado" : ""}`}
            data-clip={clip.id}
            style={{ left: clip.inicio * zoom, width: Math.max(2, clip.duracion * zoom), top: 5, height: ALTO_PISTA - 11 }}
            onPointerDown={(e) => alPulsarClip(e, clip, "mover")}
            title={`${formatearTiempo(clip.inicio)} – ${formatearTiempo(finDe(clip))}`}
          >
            {clip.duracion * zoom > 60 && <span className="etiqueta">{pista.nombre}</span>}
            <span className="asa izquierda" onPointerDown={(e) => alPulsarClip(e, clip, "izquierda")} />
            <span className="asa derecha" onPointerDown={(e) => alPulsarClip(e, clip, "derecha")} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cursor

function Cursor({ zoom, contenedor }: { zoom: number; contenedor: React.RefObject<HTMLDivElement> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Se mueve escribiendo el estilo directamente: 30 actualizaciones/s sin re-renderizar React.
    const pintar = (estado: { posicion: number; estado: string }) => {
      const x = estado.posicion * zoom;
      if (ref.current) ref.current.style.transform = `translateX(${x}px)`;
      const caja = contenedor.current;
      if (caja && estado.estado === "reproduciendo") {
        const visible = caja.clientWidth - ANCHO_CABECERA;
        if (x > caja.scrollLeft + visible - 60 || x < caja.scrollLeft) caja.scrollLeft = Math.max(0, x - 80);
      }
    };
    pintar(usarReproduccion.getState());
    return usarReproduccion.subscribe(pintar);
  }, [zoom, contenedor]);
  return <div className="cursor" ref={ref} />;
}

// ------------------------------------------------------------------ editor

export function Editor() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const zoom = usarApp((s) => s.zoom);
  const rango = usarApp((s) => s.rango);
  const bucle = usarApp((s) => s.bucle);
  const tonalidad = usarApp((s) => s.analisis?.tonalidad.nombre);
  const pulsos = usarApp((s) => s.analisis?.mapaTempo.pulsos) ?? SIN_PULSOS;
  const refCaja = useRef<HTMLDivElement>(null);
  const [ventana, fijarVentana] = useState<Ventana>({ izquierda: 0, ancho: 800 });

  const duracion = Math.max(duracionDe(proyecto), proyecto.duracion) + 8;
  const anchoTotal = Math.ceil(duracion * zoom);

  useLayoutEffect(() => {
    const caja = refCaja.current!;
    let pendiente = 0;
    const medir = () => {
      cancelAnimationFrame(pendiente);
      pendiente = requestAnimationFrame(() =>
        fijarVentana({ izquierda: caja.scrollLeft, ancho: Math.max(100, caja.clientWidth - ANCHO_CABECERA) }),
      );
    };
    medir();
    caja.addEventListener("scroll", medir, { passive: true });
    const observador = new ResizeObserver(medir);
    observador.observe(caja);
    return () => {
      cancelAnimationFrame(pendiente);
      caja.removeEventListener("scroll", medir);
      observador.disconnect();
    };
  }, []);

  /** Ctrl/⌘ + rueda: zoom centrado en el puntero. */
  const alRodar = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const caja = refCaja.current!;
    const x = e.clientX - caja.getBoundingClientRect().left - ANCHO_CABECERA;
    const tiempo = (caja.scrollLeft + x) / zoom;
    const nuevo = Math.min(600, Math.max(4, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    usarApp.getState().fijar({ zoom: nuevo });
    requestAnimationFrame(() => (caja.scrollLeft = Math.max(0, tiempo * nuevo - x)));
  };

  return (
    <div className="editor-contenedor">
      <div className="editor" ref={refCaja} onWheel={alRodar}>
        <div className="lienzo" style={{ width: ANCHO_CABECERA + anchoTotal }}>
          <div className="fila fila-regla">
            <div className="esquina">
              <div className="leyenda-regla">
                <span><span className="tenue">Tonalidad</span> <strong>{tonalidad ?? "—"}</strong></span>
                <span className="tenue">Secciones</span>
                <span className="tenue">Acordes</span>
                <span className="tenue">Bajo</span>
              </div>
              <span className="crecer" />
              <span className="tenue mono">{proyecto.compas}/4</span>
            </div>
            <Regla ventana={ventana} zoom={zoom} pulsos={pulsos} anchoTotal={anchoTotal} />
          </div>
          {proyecto.pistas.map((pista) => (
            <FilaPista key={pista.id} pista={pista} proyecto={proyecto} ventana={ventana} zoom={zoom}
              anchoTotal={anchoTotal} pulsos={pulsos} />
          ))}
          {rango && (
            <div className={`rango ${bucle ? "bucle" : ""}`}
              style={{ left: ANCHO_CABECERA + rango.inicio * zoom, width: (rango.fin - rango.inicio) * zoom }} />
          )}
          <Cursor zoom={zoom} contenedor={refCaja} />
        </div>
      </div>
      <Inspector />
    </div>
  );
}

const SIN_PULSOS: Pulso[] = [];
