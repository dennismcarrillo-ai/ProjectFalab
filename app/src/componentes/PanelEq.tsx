import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { respuestaEq } from "../audio/respuestaEq";
import { usarApp } from "../estado/almacen";
import type { Ecualizador, Pista } from "../tipos";
import { formatearSemitonos } from "../util/formato";

const F_MIN = 20;
const F_MAX = 20000;
const DB_MAX = 18;

/** Curva de respuesta del EQ, en escala logarítmica de frecuencia. */
function Curva({ eq, color }: { eq: Ecualizador; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const lienzo = ref.current!;
    const escala = window.devicePixelRatio || 1;
    const ancho = lienzo.clientWidth, alto = lienzo.clientHeight;
    lienzo.width = ancho * escala;
    lienzo.height = alto * escala;
    const c = lienzo.getContext("2d")!;
    c.scale(escala, escala);
    c.clearRect(0, 0, ancho, alto);
    const x = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * ancho;
    const y = (db: number) => alto / 2 - (db / DB_MAX) * (alto / 2 - 4);
    c.strokeStyle = "#262b30";
    c.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      c.beginPath(); c.moveTo(x(f), 0); c.lineTo(x(f), alto); c.stroke();
    }
    c.strokeStyle = "#3a4148";
    c.beginPath(); c.moveTo(0, y(0)); c.lineTo(ancho, y(0)); c.stroke();
    const frecuencias = Array.from({ length: ancho }, (_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / (ancho - 1)));
    const curva = respuestaEq(eq, frecuencias);
    c.beginPath();
    curva.forEach((db, i) => (i ? c.lineTo(i, y(db)) : c.moveTo(i, y(db))));
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.stroke();
    c.lineTo(ancho, y(0)); c.lineTo(0, y(0)); c.closePath();
    c.fillStyle = color + "33";
    c.fill();
  }, [eq, color]);
  return <canvas ref={ref} />;
}

const aPosicion = (f: number, min: number, max: number) => Math.log(f / min) / Math.log(max / min);
const aFrecuencia = (p: number, min: number, max: number) => Math.round(min * Math.pow(max / min, p));
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);

const BANDAS: { clave: keyof Ecualizador; titulo: string; min: number; max: number }[] = [
  { clave: "bajos", titulo: "Graves", min: 40, max: 500 },
  { clave: "medios", titulo: "Medios", min: 200, max: 6000 },
  { clave: "agudos", titulo: "Agudos", min: 2000, max: 16000 },
];

/** Panel flotante con el EQ paramétrico de 3 bandas y el tono propio de la pista. */
export function PanelEq({ pista, ancla, alCerrar }: { pista: Pista; ancla: DOMRect; alCerrar: () => void }) {
  const { ajustarEq, restablecerEq, ajustarPista } = usarApp.getState();
  const ref = useRef<HTMLDivElement>(null);
  const [arriba, fijarArriba] = useState(ancla.bottom + 6);

  useLayoutEffect(() => {
    const alto = ref.current?.offsetHeight ?? 0;
    fijarArriba(Math.max(8, Math.min(ancla.bottom + 6, window.innerHeight - alto - 8)));
  }, [ancla]);

  useEffect(() => {
    const fuera = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) alCerrar();
    };
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && alCerrar();
    window.addEventListener("pointerdown", fuera, true);
    window.addEventListener("keydown", tecla);
    return () => {
      window.removeEventListener("pointerdown", fuera, true);
      window.removeEventListener("keydown", tecla);
    };
  }, [alCerrar]);

  // Se dibuja en <body> para quedar por encima de las cabeceras fijas de las demás pistas.
  return createPortal(
    <div className="panel-eq" ref={ref} style={{ left: ancla.left, top: arriba }} onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Ecualizador de ${pista.nombre}`}>
      <h4>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: pista.color }} />
        Ecualizador · {pista.nombre}
        <span className="crecer" />
        <button className="plano" onClick={() => restablecerEq(pista.id)}>Restablecer</button>
      </h4>
      <Curva eq={pista.eq} color={pista.color} />
      {BANDAS.map(({ clave, titulo, min, max }) => {
        const banda = pista.eq[clave];
        return (
          <div className={`banda ${clave === "medios" ? "con-q" : ""}`} key={clave}>
            <span className="titulo">{titulo}</span>
            <input
              type="range" min={-15} max={15} step={0.5} value={banda.ganancia} aria-label={`Ganancia de ${titulo}`}
              onChange={(e) => ajustarEq(pista.id, clave, { ganancia: Number(e.target.value) })}
              onDoubleClick={() => ajustarEq(pista.id, clave, { ganancia: 0 })}
            />
            <span className="valor">{banda.ganancia > 0 ? "+" : ""}{banda.ganancia.toFixed(1)} dB</span>
            <input
              type="range" min={0} max={1} step={0.005} value={aPosicion(banda.frecuencia, min, max)}
              aria-label={`Frecuencia de ${titulo}`}
              onChange={(e) => ajustarEq(pista.id, clave, { frecuencia: aFrecuencia(Number(e.target.value), min, max) })}
            />
            <span className="valor">{hz(banda.frecuencia)}</span>
            {clave === "medios" && (
              <>
                <input
                  type="range" min={0.3} max={8} step={0.1} value={banda.q ?? 1} aria-label="Ancho de banda (Q)"
                  onChange={(e) => ajustarEq(pista.id, clave, { q: Number(e.target.value) })}
                />
                <span className="valor">Q {(banda.q ?? 1).toFixed(1)}</span>
              </>
            )}
          </div>
        );
      })}
      <div className="banda" style={{ marginTop: 10, gridTemplateColumns: "1fr auto" }}>
        <span>Tono de esta pista <span className="tenue">(se suma al global)</span></span>
        <span>
          <button className="paso" aria-label="Bajar el tono de la pista"
            onClick={() => ajustarPista(pista.id, { tono: Math.max(-12, pista.tono - 1) })}>−</button>
          <span className="valor" style={{ display: "inline-block" }}>{formatearSemitonos(pista.tono)} st</span>
          <button className="paso" aria-label="Subir el tono de la pista"
            onClick={() => ajustarPista(pista.id, { tono: Math.min(12, pista.tono + 1) })}>+</button>
        </span>
      </div>
    </div>,
    document.body,
  );
}
