import { useEffect, useState } from "react";
import { usarApp } from "../estado/almacen";
import { enEscritorio, motor, type EstadoDrive, type PeticionExportar } from "../servicios/motor";
import { IconoCerrar } from "../util/iconos";
import { SelectorCifrado } from "../vistas/Cancionero";

// ---------------------------------------------------------------- exportar

export function DialogoExportar() {
  const proyecto = usarApp((s) => s.proyecto)!;
  const cifrado = usarApp((s) => s.cifrado);
  const conNotas = usarApp((s) => s.analisis?.pistasConNotas) ?? [];
  const { exportar, fijar } = usarApp.getState();
  const [formato, fijarFormato] = useState("wav");

  const lanzar = async (peticion: PeticionExportar) => {
    let destino: string | undefined;
    if (enEscritorio) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const carpeta = await open({ directory: true, title: "Carpeta donde guardar la exportación" });
      if (typeof carpeta !== "string") return;
      destino = carpeta;
    }
    await exportar({ ...peticion, destino });
  };
  const fila = (descripcion: string, detalle: string, peticion: PeticionExportar, disponible = true) => (
    <div className="fila-opcion">
      <div className="descripcion">
        <div>{descripcion}</div>
        <div className="tenue" style={{ fontSize: 11.5 }}>{detalle}</div>
      </div>
      <button disabled={!disponible} onClick={() => void lanzar(peticion)}>Exportar</button>
    </div>
  );

  return (
    <div className="velo" onPointerDown={(e) => e.target === e.currentTarget && fijar({ dialogo: null })}>
      <div className="dialogo vidrio" role="dialog" aria-label="Exportar">
        <h2>Exportar «{proyecto.nombre}»</h2>
        <h3>Audio</h3>
        <div className="fila-opcion">
          <span className="descripcion">Formato</span>
          <select value={formato} onChange={(e) => fijarFormato(e.target.value)} aria-label="Formato de audio">
            <option value="wav">WAV 24 bits (Hi-Fi)</option>
            <option value="flac">FLAC 24 bits (Hi-Fi)</option>
            <option value="mp3">MP3 320 kbps</option>
          </select>
        </div>
        {fila("Mezcla editada", "Lo que estás oyendo: edición, EQ, volúmenes, velocidad y tono.", { tipo: "mezcla", formato })}
        {fila("Pistas separadas", "Un archivo por instrumento, con su edición y su mezcla.", { tipo: "pistas", formato })}
        <h3>Video</h3>
        {fila("Video original con la nueva mezcla", proyecto.medioOriginal.tieneVideo
          ? "MP4 con la imagen original. Los cortes y movimientos de clips no se aplican a la imagen."
          : "El archivo importado no tenía video.", { tipo: "video", video: "original" }, proyecto.medioOriginal.tieneVideo)}
        {(proyecto.videos ?? []).map((toma) => (
          <div key={toma.id}>
            {fila(`${toma.nombre} con la nueva mezcla`, "MP4 con tu grabación de cámara y la mezcla completa.", { tipo: "video", video: toma.id })}
          </div>
        ))}
        <h3>Letra y acordes</h3>
        <div className="fila-opcion"><span className="descripcion">Cifrado</span><SelectorCifrado /></div>
        {fila("Cancionero en PDF", "Letra con los acordes encima, lista para imprimir.", { tipo: "cancionero", formato: "pdf", cifrado })}
        {fila("Cancionero en texto", "Archivo .txt con el mismo contenido.", { tipo: "cancionero", formato: "txt", cifrado })}
        <h3>Partitura</h3>
        {fila("Partitura estándar (MusicXML)", "Se abre en MuseScore, Sibelius, Finale o Dorico.", { tipo: "partitura" }, conNotas.length > 0)}
        {fila("MIDI multipista", "Las notas detectadas, con los tiempos reales de la interpretación.", { tipo: "midi" }, conNotas.length > 0)}
        {fila("Tablatura de guitarra", "Texto con afinación estándar.", { tipo: "tablatura", instrumento: "guitarra" }, conNotas.includes("guitarra"))}
        {fila("Tablatura de bajo", "Texto con afinación estándar de 4 cuerdas.", { tipo: "tablatura", instrumento: "bajo" }, conNotas.includes("bajo"))}
        <div className="pie"><button onClick={() => fijar({ dialogo: null })}>Cerrar</button></div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Drive

type Remoto = { id: string; nombre: string; modificado: string; enLocal: boolean };

export function DialogoDrive() {
  const proyecto = usarApp((s) => s.proyecto);
  const { fijar, ejecutar, refrescarProyectos } = usarApp.getState();
  const [estado, fijarEstado] = useState<EstadoDrive | null>(null);
  const [remotos, fijarRemotos] = useState<Remoto[] | null>(null);
  const [ocupado, fijarOcupado] = useState(false);
  const automatico = usarApp((s) => s.driveAutomatico);
  const error = (e: unknown) => fijar({ aviso: { texto: `Google Drive: ${(e as Error).message}`, tipo: "error" } });

  const refrescar = async () => {
    try {
      const actual = await motor.drive.estado();
      fijarEstado(actual);
      fijarRemotos(actual.conectado ? await motor.drive.proyectos() : null);
    } catch (e) {
      error(e);
    }
  };
  useEffect(() => void refrescar(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const conectar = async () => {
    fijarOcupado(true);
    try {
      await motor.drive.conectar(); // abre el navegador y espera a que el usuario autorice
      await refrescar();
    } catch (e) {
      error(e);
    }
    fijarOcupado(false);
  };

  return (
    <div className="velo" onPointerDown={(e) => e.target === e.currentTarget && fijar({ dialogo: null })}>
      <div className="dialogo vidrio" role="dialog" aria-label="Google Drive">
        <h2>Google Drive</h2>
        <p className="tenue">Los proyectos se guardan en la carpeta <strong>falab_projects</strong> de tu Drive. falab solo puede ver los archivos que él mismo crea.</p>
        {!estado && <p className="tenue">Comprobando…</p>}
        {estado && !estado.configurado && (
          <>
            <p>Falta el archivo de credenciales OAuth de tu proyecto de Google Cloud. Sigue la guía <strong>docs/GOOGLE_DRIVE.md</strong> y guarda el archivo descargado en:</p>
            <div className="codigo">{estado.rutaCredenciales}</div>
            <div className="pie"><button onClick={() => void refrescar()}>Ya lo he guardado</button></div>
          </>
        )}
        {estado?.configurado && !estado.conectado && (
          <div className="pie" style={{ justifyContent: "flex-start" }}>
            <button className="primario" disabled={ocupado} onClick={() => void conectar()}>
              {ocupado ? "Esperando la autorización en el navegador…" : "Conectar con Google Drive"}
            </button>
          </div>
        )}
        {estado?.conectado && (
          <>
            <label className="fila-opcion" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={automatico}
                onChange={async (e) => { await usarApp.getState().fijarDriveAutomatico(e.target.checked); void refrescar(); }} />
              <span className="descripcion">
                Guardado automático
                <div className="tenue" style={{ fontSize: 11.5 }}>
                  Cada cambio se sube solo en segundo plano. Si no hay internet, queda en cola y se reintenta;
                  la música siempre se reproduce desde este equipo.
                </div>
              </span>
            </label>
            {automatico && (
              <p className="tenue" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                {estado.pendientes.length
                  ? `${estado.pendientes.length} proyecto(s) pendiente(s) de subir.`
                  : "Todo sincronizado."}
                {estado.ultimoError && ` Último intento fallido: ${estado.ultimoError}`}
              </p>
            )}
            {proyecto && (
              <div className="fila-opcion">
                <span className="descripcion">Subir los cambios de «{proyecto.nombre}»</span>
                <button className="primario" onClick={async () => {
                  const final = await ejecutar("Sincronizando con Google Drive", () => motor.drive.subir(proyecto.id));
                  if (final) {
                    fijar({ aviso: { texto: `Sincronizado: ${final.resultado.archivosSubidos} de ${final.resultado.archivosTotales} archivos subidos.`, tipo: "info" } });
                    void refrescar();
                  }
                }}>Sincronizar</button>
              </div>
            )}
            <h3>Proyectos en Drive</h3>
            {remotos?.length === 0 && <p className="tenue">Todavía no hay proyectos en falab_projects.</p>}
            {remotos?.map((r) => (
              <div className="fila-opcion" key={r.id}>
                <span className="descripcion">{r.nombre} {r.enLocal && <span className="tenue">· en este equipo</span>}</span>
                <button onClick={async () => {
                  const final = await ejecutar("Descargando de Google Drive", () => motor.drive.descargar(r.id));
                  if (final) {
                    await refrescarProyectos();
                    void refrescar();
                  }
                }}>{r.enLocal ? "Actualizar" : "Descargar"}</button>
              </div>
            ))}
            <div className="pie">
              <button className="plano" onClick={async () => { await motor.drive.desconectar(); void refrescar(); }}>Desconectar la cuenta</button>
            </div>
          </>
        )}
        <div className="pie"><button onClick={() => fijar({ dialogo: null })}>Cerrar</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- progreso y avisos

export function Progreso() {
  const trabajo = usarApp((s) => s.trabajo);
  if (!trabajo) return null;
  return (
    <div className="velo">
      <div className="dialogo vidrio" role="alertdialog" aria-label={trabajo.titulo} style={{ width: 420 }}>
        <h2>{trabajo.titulo}</h2>
        <div className="barra-progreso"><div style={{ width: `${Math.round(trabajo.progreso * 100)}%` }} /></div>
        <div style={{ display: "flex" }}>
          <span className="tenue crecer">{trabajo.etapa || "Preparando…"}</span>
          <span className="mono">{Math.round(trabajo.progreso * 100)}%</span>
        </div>
        <div className="pie"><button onClick={() => usarApp.getState().cancelarTrabajo()}>Cancelar</button></div>
      </div>
    </div>
  );
}

export function Aviso() {
  const aviso = usarApp((s) => s.aviso);
  const proyecto = usarApp((s) => s.proyecto);
  const cerrar = () => usarApp.getState().fijar({ aviso: null });
  useEffect(() => {
    if (!aviso || aviso.tipo === "error" || aviso.archivos) return;
    const temporizador = setTimeout(cerrar, 9000);
    return () => clearTimeout(temporizador);
  }, [aviso]);
  if (!aviso) return null;
  const mostrar = async (ruta: string) => {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(ruta);
  };
  return (
    <div className={`aviso vidrio ${aviso.tipo}`} role="status">
      <div className="crecer">
        {aviso.texto}
        {aviso.archivos && (
          <div className="archivos">
            {aviso.archivos.map((ruta) => {
              const nombre = ruta.split(/[\\/]/).pop();
              return enEscritorio
                ? <a key={ruta} href="#" onClick={(e) => { e.preventDefault(); void mostrar(ruta); }}>{nombre} — mostrar en Finder</a>
                : <a key={ruta} href={motor.urlExportacion(aviso.idProyecto ?? proyecto?.id ?? "", ruta)} download>{nombre}</a>;
            })}
          </div>
        )}
      </div>
      <button className="plano" onClick={cerrar} aria-label="Cerrar aviso"><IconoCerrar /></button>
    </div>
  );
}
