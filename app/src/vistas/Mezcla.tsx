/**
 * Vista «Mezcla» del reproductor (iPad): recorrido de la canción con sus secciones y un
 * mezclador de pistas grande, pensado para el dedo. Sustituye al editor de escritorio.
 */
import { useRef } from "react";
import { colorDeSeccion } from "../componentes/Directo";
import { duracionDe, usarApp, usarReproduccion } from "../estado/almacen";
import { formatearDb, formatearTiempo } from "../util/formato";

/** Barra de recorrido: se toca o se arrastra para moverse; las secciones se ven y se pueden tocar. */
function Recorrido() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const secciones = usarApp((s) => s.analisis?.secciones) ?? [];
  const posicion = usarReproduccion((s) => s.posicion);
  const ref = useRef<HTMLDivElement>(null);
  const duracion = Math.max(duracionDe(proyecto), 1);
  const ir = (clienteX: number) => {
    const caja = ref.current!.getBoundingClientRect();
    usarApp.getState().saltar(Math.min(1, Math.max(0, (clienteX - caja.left) / caja.width)) * duracion);
  };
  const alPulsar = (e: React.PointerEvent) => {
    ir(e.clientX);
    const mover = (ev: PointerEvent) => ir(ev.clientX);
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
  };
  return (
    <div className="recorrido-caja">
      <div className="recorrido" ref={ref} onPointerDown={alPulsar} role="slider" aria-label="Posición en la canción"
        aria-valuemin={0} aria-valuemax={Math.round(duracion)} aria-valuenow={Math.round(posicion)} tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") usarApp.getState().saltar(posicion + 5);
          if (e.key === "ArrowLeft") usarApp.getState().saltar(posicion - 5);
        }}>
        {secciones.map((s) => (
          <span key={s.inicio} className="tramo" title={s.nombre}
            style={{ left: `${(s.inicio / duracion) * 100}%`, width: `${((s.fin - s.inicio) / duracion) * 100}%`, background: colorDeSeccion(s.nombre) }}>
            {s.nombre}
          </span>
        ))}
        <span className="hecho" style={{ width: `${(posicion / duracion) * 100}%` }} />
        <span className="aguja" style={{ left: `${(posicion / duracion) * 100}%` }} />
      </div>
      <div className="tiempos mono tenue"><span>{formatearTiempo(posicion, 0)}</span><span>{formatearTiempo(duracion, 0)}</span></div>
    </div>
  );
}

export function Mezcla() {
  const pistas = usarApp((s) => s.proyecto!.pistas);
  const { ajustarPista } = usarApp.getState();
  return (
    <div className="vista-mezcla">
      <Recorrido />
      <div className="canales">
        {pistas.map((pista) => (
          <div className="canal" key={pista.id} style={{ borderTopColor: pista.color }}>
            <strong className="nombre">{pista.nombre}</strong>
            <div className="botones">
              <button className={`silencio ${pista.silencio ? "activo" : ""}`} aria-pressed={pista.silencio}
                aria-label={`Silenciar ${pista.nombre}`} onClick={() => ajustarPista(pista.id, { silencio: !pista.silencio })}>M</button>
              <button className={`solo ${pista.solo ? "activo" : ""}`} aria-pressed={pista.solo}
                aria-label={`Solo de ${pista.nombre}`} onClick={() => ajustarPista(pista.id, { solo: !pista.solo })}>S</button>
            </div>
            <label>Volumen <span className="mono tenue">{pista.volumen <= -48 ? "−∞" : formatearDb(pista.volumen)}</span>
              <input type="range" min={-48} max={6} step={0.5} value={pista.volumen}
                onChange={(e) => ajustarPista(pista.id, { volumen: Number(e.target.value) })}
                onDoubleClick={() => ajustarPista(pista.id, { volumen: 0 })} />
            </label>
            <label>Paneo
              <input type="range" min={-1} max={1} step={0.02} value={pista.paneo}
                onChange={(e) => ajustarPista(pista.id, { paneo: Number(e.target.value) })}
                onDoubleClick={() => ajustarPista(pista.id, { paneo: 0 })} />
            </label>
            <label>Reverb <span className="mono tenue">{Math.round((pista.reverb ?? 0) * 100)}%</span>
              <input type="range" min={0} max={1} step={0.01} value={pista.reverb ?? 0}
                onChange={(e) => ajustarPista(pista.id, { reverb: Number(e.target.value) })} />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
