import { useEffect, useState } from "react";
import { usarApp, usarReproduccion } from "../estado/almacen";
import { formatearSemitonos, formatearTiempo } from "../util/formato";
import { IconoBucle, IconoDetener, IconoIman, IconoMetronomo, IconoPausa, IconoReproducir } from "../util/iconos";

/** Reloj: tiempo, compás:pulso y BPM local según el mapa de pulsos. Se actualiza ~30 veces/s. */
function Reloj() {
  const posicion = usarReproduccion((s) => s.posicion);
  const pulsos = usarApp((s) => s.analisis?.mapaTempo.pulsos);
  const proyecto = usarApp((s) => s.proyecto)!;
  let compas = "–.–";
  let bpm = proyecto.bpm;
  if (pulsos?.length) {
    let actual = pulsos[0];
    for (const pulso of pulsos) {
      if (pulso.t > posicion + 0.02) break;
      actual = pulso;
    }
    compas = `${actual.compas}.${actual.pulso}`;
    bpm = actual.bpm;
  }
  return (
    <div className="reloj" title="Tiempo · compás.pulso · tempo">
      <span className="tiempo">{formatearTiempo(posicion)}</span>
      <span className="compas">{compas}</span>
      <span className="compas">{(bpm * proyecto.velocidad).toFixed(1)} BPM</span>
    </div>
  );
}

/** Tempo de reproducción editable (un decimal). Cambiarlo ajusta la velocidad sin alterar el tono. */
function CampoBpm() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const actual = (proyecto.bpm * proyecto.velocidad).toFixed(1);
  const [texto, fijarTexto] = useState(actual);
  useEffect(() => fijarTexto(actual), [actual]);
  const aplicar = () => {
    const valor = Number(texto.replace(",", "."));
    if (Number.isFinite(valor) && valor > 0) usarApp.getState().fijarBpm(Math.round(valor * 10) / 10);
    fijarTexto((usarApp.getState().proyecto!.bpm * usarApp.getState().proyecto!.velocidad).toFixed(1));
  };
  return (
    <input type="text" inputMode="decimal" className="mono" value={texto} aria-label="Tempo en BPM" style={{ width: 62, textAlign: "right" }}
      title={`Tempo de reproducción. El original es ${proyecto.bpm.toFixed(1)} BPM.`}
      onChange={(e) => fijarTexto(e.target.value)} onBlur={aplicar}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }} />
  );
}

export function Transporte() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const estado = usarReproduccion((s) => s.estado);
  const esperando = usarReproduccion((s) => s.esperando);
  const { ajustarProyecto, alternarReproduccion, detener, alternarBucle, fijar, alternarShow } = usarApp.getState();
  const show = usarApp((s) => s.showContinuo);
  const bucle = usarApp((s) => s.bucle);
  const iman = usarApp((s) => s.iman);
  const zoom = usarApp((s) => s.zoom);
  const vista = usarApp((s) => s.vista);
  const metronomo = proyecto.metronomo;

  return (
    <div className="transporte">
      <div className="grupo">
        <button className="boton-redondo" onClick={detener} title="Detener y volver al inicio (Intro)">
          <IconoDetener />
        </button>
        <button
          className="boton-redondo reproducir"
          onClick={alternarReproduccion}
          title="Reproducir / Pausar (Espacio)"
          aria-label={estado === "detenido" ? "Reproducir" : "Pausar"}
        >
          {estado === "detenido" ? <IconoReproducir /> : <IconoPausa />}
        </button>
      </div>
      <Reloj />
      {esperando && <span className="tenue">Cargando audio…</span>}
      <div className="separador" />

      <div className="grupo" title="Cambia la velocidad sin alterar el tono">
        <label>Velocidad</label>
        <input
          type="range" min={0.5} max={1.5} step={0.05} value={proyecto.velocidad} style={{ width: 110 }}
          aria-label="Velocidad"
          onChange={(e) => ajustarProyecto({ velocidad: Number(e.target.value) })}
          onDoubleClick={() => ajustarProyecto({ velocidad: 1 })}
        />
        <span className="valor">{Math.round(proyecto.velocidad * 100)}%</span>
        <CampoBpm />
        <label>BPM</label>
      </div>
      <div className="grupo" title="Cambia el tono sin alterar la velocidad (semitonos)">
        <label>Tono</label>
        <button className="paso" aria-label="Bajar un semitono"
          onClick={() => ajustarProyecto({ tono: Math.max(-12, proyecto.tono - 1) })}>−</button>
        <span className="valor" onDoubleClick={() => ajustarProyecto({ tono: 0 })}>
          {formatearSemitonos(proyecto.tono)} st
        </span>
        <button className="paso" aria-label="Subir un semitono"
          onClick={() => ajustarProyecto({ tono: Math.min(12, proyecto.tono + 1) })}>+</button>
      </div>
      <div className="separador" />

      <div className="grupo">
        <button
          className={metronomo.activo ? "activo" : ""} title="Metrónomo dinámico: sigue el mapa de pulsos de la canción"
          onClick={() => ajustarProyecto({ metronomo: { ...metronomo, activo: !metronomo.activo } })}
        >
          <IconoMetronomo />
        </button>
        <input
          type="range" min={-30} max={6} step={1} value={metronomo.volumen} style={{ width: 60 }}
          aria-label="Volumen del metrónomo"
          onChange={(e) => ajustarProyecto({ metronomo: { ...metronomo, volumen: Number(e.target.value) } })}
        />
        <label htmlFor="cuenta">Cuenta</label>
        <select
          id="cuenta" value={metronomo.cuentaRegresiva} title="Cuenta regresiva al tempo de la canción antes de reproducir"
          onChange={(e) => ajustarProyecto({ metronomo: { ...metronomo, cuentaRegresiva: Number(e.target.value) } })}
        >
          <option value={0}>No</option>
          <option value={1}>1 compás</option>
          <option value={2}>2 compases</option>
          <option value={3}>3 compases</option>
          <option value={4}>4 compases</option>
        </select>
        {metronomo.cuentaRegresiva > 0 && (
          <>
            <select value={metronomo.cuentaTiempos ?? proyecto.compas} aria-label="Tiempos por compás de la cuenta"
              title="Tiempos por compás de la cuenta"
              onChange={(e) => ajustarProyecto({ metronomo: { ...metronomo, cuentaTiempos: Number(e.target.value) } })}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} {n === 1 ? "tiempo" : "tiempos"}</option>)}
            </select>
            <select value={metronomo.cuentaFigura ?? "negra"} aria-label="Figura de la cuenta" title="Contar a negras o a corcheas"
              onChange={(e) => ajustarProyecto({ metronomo: { ...metronomo, cuentaFigura: e.target.value as "negra" | "corchea" } })}>
              <option value="negra">♩ negras</option>
              <option value="corchea">♪ corcheas</option>
            </select>
          </>
        )}
      </div>
      <div className="separador" />

      <button className={bucle ? "activo" : ""} onClick={alternarBucle} title="Repetir el tramo marcado en la regla (L)">
        <IconoBucle />
      </button>
      <button className={show ? "activo" : ""} onClick={alternarShow} aria-pressed={show}
        title="Show continuo: al terminar, empieza la canción siguiente de la lista sin cortes">
        Show
      </button>
      <button onClick={() => fijar({ dialogo: "estructura" })} title="Marcadores de ensayo, compás por sección y guías de voz">
        Estructura
      </button>
      {vista === "editor" && (
        <>
          <button className={iman ? "activo" : ""} onClick={() => fijar({ iman: !iman })}
            title="Imán: ajustar a pulsos y bordes de clips (Alt lo desactiva al arrastrar)">
            <IconoIman />
          </button>
          <div className="crecer" />
          <div className="grupo">
            <label>Zoom</label>
            <button className="paso" aria-label="Alejar" onClick={() => fijar({ zoom: Math.max(4, zoom / 1.4) })}>−</button>
            <button className="paso" aria-label="Acercar" onClick={() => fijar({ zoom: Math.min(600, zoom * 1.4) })}>+</button>
          </div>
        </>
      )}
    </div>
  );
}
