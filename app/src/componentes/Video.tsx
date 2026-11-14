/** Ventana flotante de video sincronizada con la canción, y opciones de grabación. */
import { useEffect, useRef, useState } from "react";
import { usarApp, usarReproduccion } from "../estado/almacen";
import { motor } from "../servicios/motor";

/**
 * Video flotante. El audio lo pone siempre el mezclador de falab: el video va silenciado y se
 * limita a seguir al reloj de audio. Si se desvía poco, se corrige acelerándolo o frenándolo un
 * instante (no se nota); si se desvía mucho —un salto en la canción—, se recoloca de golpe.
 */
export function VentanaVideo() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const elegido = usarApp((s) => s.ventanaVideo)!;
  const { fijar } = usarApp.getState();
  const refVideo = useRef<HTMLVideoElement>(null);
  const refCaja = useRef<HTMLDivElement>(null);
  const [fuente, fijarFuente] = useState<{ url: string; inicio: number } | null>(null);
  const [error, fijarError] = useState("");
  // Empieza abajo a la derecha, donde no tapa las cabeceras de pista ni el transporte.
  const [lugar, fijarLugar] = useState(() => ({ x: Math.max(8, window.innerWidth - 410), y: Math.max(8, window.innerHeight - 330) }));
  const tomas = proyecto.videos ?? [];

  useEffect(() => {
    let vigente = true;
    fijarFuente(null);
    fijarError("");
    motor.video(proyecto.id, elegido)
      .then((datos) => vigente && fijarFuente(datos))
      .catch((e) => vigente && fijarError((e as Error).message));
    return () => {
      vigente = false;
    };
  }, [proyecto.id, elegido]);

  useEffect(() => {
    if (!fuente) return;
    const seguir = ({ posicion, estado }: { posicion: number; estado: string }) => {
      const video = refVideo.current;
      if (!video || !video.duration) return;
      const velocidad = usarApp.getState().proyecto?.velocidad ?? 1;
      const t = posicion - fuente.inicio;           // instante del video que corresponde a la canción
      const dentro = t >= 0 && t < video.duration;
      video.style.opacity = dentro ? "1" : "0.15";  // fuera de la toma: imagen atenuada
      if (estado !== "reproduciendo" || !dentro) {
        if (!video.paused) video.pause();
        const objetivo = Math.min(Math.max(t, 0), video.duration - 0.05);
        if (Math.abs(video.currentTime - objetivo) > 0.04) video.currentTime = objetivo;
        return;
      }
      const desvio = video.currentTime - t;
      if (Math.abs(desvio) > 0.25) video.currentTime = t;
      video.playbackRate = Math.min(4, Math.max(0.25, velocidad * (1 - Math.max(-0.08, Math.min(0.08, desvio * 0.6)))));
      if (video.paused) void video.play().catch(() => undefined);
    };
    seguir(usarReproduccion.getState());
    return usarReproduccion.subscribe(seguir);
  }, [fuente]);

  const arrastrar = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, select")) return;
    const origen = { x: e.clientX - lugar.x, y: e.clientY - lugar.y };
    const mover = (ev: PointerEvent) => fijarLugar({
      x: Math.min(window.innerWidth - 120, Math.max(0, ev.clientX - origen.x)),
      y: Math.min(window.innerHeight - 60, Math.max(0, ev.clientY - origen.y)),
    });
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
  };

  const pantallaCompleta = () => {
    const video = refVideo.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!video) return;
    if (video.requestFullscreen) void video.requestFullscreen();
    else video.webkitEnterFullscreen?.();
  };

  return (
    <div className="ventana-video vidrio" ref={refCaja} style={{ left: lugar.x, top: lugar.y }} role="dialog" aria-label="Video">
      <div className="barra-video" onPointerDown={arrastrar}>
        <select value={elegido} aria-label="Video que se muestra" onChange={(e) => fijar({ ventanaVideo: e.target.value })}>
          {proyecto.medioOriginal.tieneVideo && <option value="original">Video original</option>}
          {tomas.map((toma) => <option key={toma.id} value={toma.id}>{toma.nombre}</option>)}
        </select>
        <span className="crecer" />
        {elegido !== "original" && (
          <button className="plano" title="Eliminar esta toma de cámara" onClick={() => {
            if (window.confirm("¿Eliminar esta toma de video del proyecto?")) usarApp.getState().eliminarToma(elegido);
          }}>Eliminar</button>
        )}
        <button className="plano" onClick={pantallaCompleta} title="Pantalla completa" aria-label="Pantalla completa">⛶</button>
        <button className="plano" onClick={() => fijar({ ventanaVideo: null })} title="Cerrar" aria-label="Cerrar el video">✕</button>
      </div>
      {error && <p className="aviso-visor">{error}</p>}
      {!fuente && !error && <p className="aviso-visor">Preparando el video…</p>}
      {fuente && <video ref={refVideo} src={fuente.url} muted playsInline preload="auto" onError={() => fijarError("Este equipo no puede reproducir el video.")} />}
    </div>
  );
}

/** Vista previa de la cámara mientras se graba. */
export function VistaPreviaDeCamara({ flujo }: { flujo: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = flujo;
  }, [flujo]);
  return <video ref={ref} className="vista-previa-camara" autoPlay muted playsInline aria-label="Vista previa de la cámara" />;
}

export function DialogoGrabacion() {
  const opciones = usarApp((s) => s.opcionesDeGrabacion);
  const { fijar, fijarOpcionesDeGrabacion } = usarApp.getState();
  const [dispositivos, fijarDispositivos] = useState<MediaDeviceInfo[]>([]);
  const [permiso, fijarPermiso] = useState("");

  const listar = async (pedirPermiso: boolean) => {
    try {
      if (pedirPermiso) {
        // Los nombres de los dispositivos solo se revelan tras conceder el permiso.
        const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
        flujo.getTracks().forEach((pista) => pista.stop());
      }
      fijarDispositivos(await navigator.mediaDevices.enumerateDevices());
      fijarPermiso("");
    } catch {
      fijarPermiso("falab no tiene permiso para usar el micrófono. Actívalo en Ajustes del Sistema → Privacidad y seguridad.");
    }
  };
  useEffect(() => void listar(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const microfonos = dispositivos.filter((d) => d.kind === "audioinput");
  const camaras = dispositivos.filter((d) => d.kind === "videoinput");
  const sinNombres = dispositivos.length > 0 && dispositivos.every((d) => !d.label);
  return (
    <div className="velo" onPointerDown={(e) => e.target === e.currentTarget && fijar({ dialogo: null })}>
      <div className="dialogo vidrio" role="dialog" aria-label="Opciones de grabación">
        <h2>Opciones de grabación</h2>
        <p className="tenue">
          La toma se graba en la pista seleccionada si es una pista tuya; si no, en una pista nueva. Usa
          auriculares: con altavoces, el micrófono volvería a grabar la canción.
        </p>
        <div className="fila-opcion">
          <span className="descripcion">Micrófono o interfaz de audio</span>
          <select value={opciones.microfono} aria-label="Micrófono" onChange={(e) => fijarOpcionesDeGrabacion({ microfono: e.target.value })}>
            <option value="">Predeterminado del sistema</option>
            {microfonos.filter((d) => d.deviceId && d.label).map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
        </div>
        <label className="fila-opcion" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={opciones.conCamara} onChange={(e) => fijarOpcionesDeGrabacion({ conCamara: e.target.checked })} />
          <span className="descripcion">
            Grabar también video con la cámara
            <div className="tenue" style={{ fontSize: 11.5 }}>Queda como una toma de video del proyecto, sincronizada con la canción.</div>
          </span>
          {opciones.conCamara && (
            <select value={opciones.camara} aria-label="Cámara" onChange={(e) => fijarOpcionesDeGrabacion({ camara: e.target.value })}>
              <option value="">Predeterminada</option>
              {camaras.filter((d) => d.deviceId && d.label).map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
          )}
        </label>
        <div className="fila-opcion">
          <span className="descripcion">
            Ajuste de latencia
            <div className="tenue" style={{ fontSize: 11.5 }}>
              falab ya compensa la latencia que declara el sistema. Si tus tomas suenan retrasadas, sube este
              valor; si suenan adelantadas, bájalo.
            </div>
          </span>
          <input type="number" value={opciones.ajusteLatencia} min={-200} max={400} step={5} style={{ width: 76 }}
            aria-label="Ajuste de latencia en milisegundos" onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => fijarOpcionesDeGrabacion({ ajusteLatencia: Math.max(-200, Math.min(400, Number(e.target.value) || 0)) })} />
          <span className="tenue">ms</span>
        </div>
        {permiso && <p style={{ color: "var(--ambar)" }}>{permiso}</p>}
        <div className="pie">
          {(sinNombres || dispositivos.length === 0) && <button onClick={() => void listar(true)}>Ver mis dispositivos</button>}
          <button onClick={() => fijar({ dialogo: null })}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
