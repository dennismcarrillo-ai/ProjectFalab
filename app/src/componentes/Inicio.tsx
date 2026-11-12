import { useEffect, useRef, useState } from "react";
import { usarApp } from "../estado/almacen";
import { enEscritorio, type OpcionesImportar } from "../servicios/motor";
import { Biblioteca } from "./Biblioteca";
import { IconoNube } from "../util/iconos";

const EXTENSIONES = ["mp3", "wav", "flac", "ogg", "aac", "m4a", "mp4", "mov", "mkv", "falab"];

/** Pantalla de inicio: importar una canción o un video y abrir proyectos anteriores. */
export function Inicio() {
  const salud = usarApp((s) => s.salud);
  const { importar, crearDemo, fijar } = usarApp.getState();
  const [encima, fijarEncima] = useState(false);
  const [opciones, fijarOpciones] = useState<OpcionesImportar>({
    separar: true, antiBleed: true, extraerNotas: true, transcribirLetras: true, calidadLetras: "equilibrado", idioma: null,
  });
  const refOpciones = useRef(opciones);
  refOpciones.current = opciones;
  const refArchivo = useRef<HTMLInputElement>(null);
  const c = salud?.componentes;

  // En la app de escritorio, soltar un archivo entrega su ruta en disco (no hay que copiarlo).
  useEffect(() => {
    if (!enEscritorio) return;
    let cancelar: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      cancelar = await getCurrentWebview().onDragDropEvent((evento) => {
        if (evento.payload.type === "over") fijarEncima(true);
        else if (evento.payload.type === "drop") {
          fijarEncima(false);
          if (evento.payload.paths[0]) void importar(evento.payload.paths[0], refOpciones.current);
        } else fijarEncima(false);
      });
    });
    return () => cancelar?.();
  }, [importar]);

  const elegir = async () => {
    if (!enEscritorio) {
      refArchivo.current?.click();
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const ruta = await open({ multiple: false, filters: [{ name: "Audio, video o proyecto de falab", extensions: EXTENSIONES }] });
    if (typeof ruta === "string") void importar(ruta, opciones);
  };

  const casilla = (clave: "separar" | "antiBleed" | "extraerNotas" | "transcribirLetras", texto: string, disponible: boolean | undefined, falta: string) => (
    <label className={disponible === false ? "falta" : ""} title={disponible === false ? `Falta instalar ${falta}: esta etapa se omitirá.` : undefined}>
      <input type="checkbox" checked={opciones[clave]} onChange={(e) => fijarOpciones({ ...opciones, [clave]: e.target.checked })} />
      {texto}{disponible === false ? " ⚠" : ""}
    </label>
  );

  return (
    <div className="inicio">
      <div className="portada vidrio">
        <img src="/icono.svg" alt="" />
        <div>
          <h1>falab</h1>
          <p>Separa instrumentos, transcribe la letra, saca los acordes y edita la mezcla. Todo el análisis se hace en este equipo: tu música no sale de aquí.</p>
        </div>
      </div>

      <div className={`zona-soltar vidrio ${encima ? "encima" : ""}`}
        onDragOver={(e) => { e.preventDefault(); fijarEncima(true); }}
        onDragLeave={() => fijarEncima(false)}
        onDrop={(e) => {
          e.preventDefault();
          fijarEncima(false);
          const archivo = e.dataTransfer.files[0];
          if (archivo && !enEscritorio) void importar(archivo, opciones);
        }}>
        <strong>Arrastra aquí una canción o un video</strong>
        <div className="tenue">MP3 · WAV · FLAC · OGG · AAC · MP4 · MOV · MKV · o un proyecto exportado (.falab)</div>
        <div className="acciones">
          <button className="primario" onClick={elegir}>Elegir archivo…</button>
          <button onClick={() => void crearDemo()} title="Crea un proyecto con audio sintético para probar la interfaz sin modelos de IA">
            Probar con una demostración
          </button>
          <button onClick={() => fijar({ dialogo: "drive" })}><IconoNube /> Google Drive</button>
        </div>
        <input ref={refArchivo} type="file" hidden accept={EXTENSIONES.map((e) => "." + e).join(",")}
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            if (archivo) void importar(archivo, opciones);
            e.target.value = "";
          }} />
        <div className="opciones">
          {casilla("separar", "Separar instrumentos (Demucs)", c?.demucs, "Demucs")}
          {casilla("antiBleed", "Limpiar graves bajo/bombo", true, "")}
          {casilla("extraerNotas", "Extraer notas (BasicPitch)", c?.basicPitch, "BasicPitch")}
          {casilla("transcribirLetras", "Transcribir la letra (Whisper)", c?.whisper, "Whisper")}
          <label>
            Calidad de la letra
            <select value={opciones.calidadLetras} onChange={(e) => fijarOpciones({ ...opciones, calidadLetras: e.target.value as OpcionesImportar["calidadLetras"] })}>
              <option value="rapido">Rápida</option>
              <option value="equilibrado">Equilibrada</option>
              <option value="preciso">Máxima</option>
            </select>
          </label>
          <label>
            Idioma
            <select value={opciones.idioma ?? ""} onChange={(e) => fijarOpciones({ ...opciones, idioma: e.target.value || null })}>
              <option value="">Detectar</option>
              <option value="es">Español</option>
              <option value="en">Inglés</option>
              <option value="pt">Portugués</option>
              <option value="fr">Francés</option>
              <option value="it">Italiano</option>
            </select>
          </label>
        </div>
        {c && !c.ffmpeg && <p className="falta" style={{ color: "var(--ambar)" }}>No se encuentra FFmpeg: instálalo con «brew install ffmpeg» para poder importar archivos.</p>}
      </div>

      <Biblioteca />
    </div>
  );
}
