import { useEffect, useState } from "react";
import { motorAudio } from "../audio/MotorAudio";
import { FRECUENCIA } from "../audio/protocolo";
import { colocar, finDe, mover, recortarFin, recortarInicio, vecinos } from "../edicion/operaciones";
import { usarApp, usarReproduccion } from "../estado/almacen";
import type { Clip } from "../tipos";
import { formatearTiempo, leerTiempo } from "../util/formato";

/** Campo de tiempo exacto: acepta «1:23.456» o segundos; se aplica con Intro o al salir. */
function CampoTiempo({ id, etiqueta, valor, alCambiar }: { id: string; etiqueta: string; valor: number; alCambiar: (t: number) => void }) {
  const [texto, fijarTexto] = useState(formatearTiempo(valor));
  useEffect(() => fijarTexto(formatearTiempo(valor)), [valor]);
  const aplicar = () => {
    const t = leerTiempo(texto);
    if (t === null || Math.abs(t - valor) < 0.0005) fijarTexto(formatearTiempo(valor));
    else alCambiar(t);
  };
  return (
    <div className="campo">
      <label htmlFor={id}>{etiqueta}</label>
      <input id={id} type="text" value={texto} onChange={(e) => fijarTexto(e.target.value)} onBlur={aplicar}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }} />
    </div>
  );
}

function CampoNumero({ id, etiqueta, valor, min, max, paso, unidad, alCambiar }: {
  id: string; etiqueta: string; valor: number; min: number; max: number; paso: number; unidad: string; alCambiar: (v: number) => void;
}) {
  return (
    <div className="campo">
      <label htmlFor={id}>{etiqueta}</label>
      <input id={id} type="number" value={valor} min={min} max={max} step={paso} style={{ width: 68 }}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => alCambiar(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />
      <span className="tenue">{unidad}</span>
    </div>
  );
}

function Memoria() {
  usarReproduccion((s) => Math.floor(s.posicion)); // refresca una vez por segundo
  return <span className="tenue mono" title="Audio que el reproductor mantiene cargado ahora mismo">RAM de audio: {motorAudio.memoriaMB.toFixed(0)} MB</span>;
}

/** Barra inferior: recorte y posición del clip seleccionado con valores exactos. */
export function Inspector() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const seleccion = usarApp((s) => s.clipsSeleccionados);
  const rango = usarApp((s) => s.rango);
  const portapapeles = usarApp((s) => s.portapapeles);
  const pista = proyecto.pistas.find((p) => p.clips.some((c) => c.id === seleccion[0]));
  const clip = seleccion.length === 1 ? pista?.clips.find((c) => c.id === seleccion[0]) : undefined;

  if (!clip || !pista) {
    return (
      <div className="inspector">
        <div className="atajos">
          <kbd>Espacio</kbd><span>reproducir</span>
          <kbd>S</kbd><span>dividir en el cursor</span>
          <kbd>⌘C</kbd><kbd>⌘X</kbd><kbd>⌘V</kbd><span>copiar, cortar y pegar</span>
          <kbd>⌘D</kbd><span>duplicar</span>
          <kbd>Supr</kbd><span>eliminar</span>
          <kbd>⌘Z</kbd><span>deshacer</span>
        </div>
        <span className="crecer" />
        {seleccion.length > 1 && <span>{seleccion.length} clips seleccionados</span>}
        {rango && <span className="mono">Tramo: {formatearTiempo(rango.inicio)} – {formatearTiempo(rango.fin)}</span>}
        {portapapeles && <span className="tenue">Portapapeles: {formatearTiempo(portapapeles.duracion, 2)}</span>}
        <Memoria />
      </div>
    );
  }

  const { editarClips } = usarApp.getState();
  const topes = vecinos(pista.clips, clip.id);
  const duracionFuente = (proyecto.fuentes.find((f) => f.id === clip.fuenteId)?.frames ?? 0) / FRECUENCIA;
  const cambiar = (nuevo: Clip, recolocar = false) =>
    editarClips(pista.id, (clips) => (recolocar ? colocar(clips, [nuevo]) : clips.map((c) => (c.id === clip.id ? nuevo : c))));

  return (
    <div className="inspector">
      <strong style={{ color: pista.color }}>{pista.nombre}</strong>
      <CampoTiempo id="clip-posicion" etiqueta="Posición" valor={clip.inicio} alCambiar={(t) => cambiar(mover(clip, t), true)} />
      <CampoTiempo id="clip-recorte-inicio" etiqueta="Recortar inicio en" valor={clip.inicio}
        alCambiar={(t) => cambiar(recortarInicio(clip, t, topes.anterior))} />
      <CampoTiempo id="clip-recorte-fin" etiqueta="Recortar fin en" valor={finDe(clip)}
        alCambiar={(t) => cambiar(recortarFin(clip, t, duracionFuente, topes.siguiente))} />
      <div className="campo"><label>Duración</label><span className="mono">{formatearTiempo(clip.duracion)}</span></div>
      <div className="campo"><label>Origen</label><span className="mono">{formatearTiempo(clip.desplazamiento)}</span></div>
      <CampoNumero id="clip-ganancia" etiqueta="Ganancia" valor={clip.ganancia} min={-24} max={12} paso={0.5} unidad="dB"
        alCambiar={(v) => cambiar({ ...clip, ganancia: v })} />
      <CampoNumero id="clip-fundido-entrada" etiqueta="Fundido entrada" valor={clip.fundidoEntrada} min={0} max={clip.duracion / 2} paso={0.05} unidad="s"
        alCambiar={(v) => cambiar({ ...clip, fundidoEntrada: v })} />
      <CampoNumero id="clip-fundido-salida" etiqueta="Fundido salida" valor={clip.fundidoSalida} min={0} max={clip.duracion / 2} paso={0.05} unidad="s"
        alCambiar={(v) => cambiar({ ...clip, fundidoSalida: v })} />
    </div>
  );
}
