/**
 * Diagnóstico del reproductor: comprueba, paso a paso, todo lo que hace falta para que falab
 * funcione en este dispositivo (conexión con la banda, lectura de canciones, audio, reloj común)
 * y lo deja en un texto que se puede copiar y enviar. En un teléfono no hay consola: esto la suple.
 */
import { useState } from "react";
import { usarSala } from "../sincronia/sala";

type Linea = { bien: boolean | null; texto: string };

async function comprobar(anotar: (linea: Linea) => void): Promise<void> {
  const paso = async (nombre: string, tarea: () => Promise<string>) => {
    try {
      anotar({ bien: true, texto: `${nombre}: ${await tarea()}` });
    } catch (error) {
      anotar({ bien: false, texto: `${nombre}: ${(error as Error)?.name ?? ""} ${(error as Error)?.message ?? error}` });
    }
  };
  anotar({ bien: null, texto: `Navegador: ${navigator.userAgent}` });
  anotar({ bien: null, texto: `Pantalla: ${window.innerWidth}×${window.innerHeight} · página: ${location.origin}` });
  anotar({ bien: window.isSecureContext, texto: `Contexto seguro (https): ${window.isSecureContext ? "sí" : "no"}` });

  // El audio va primero: tiene que arrancar dentro del toque del botón.
  let contexto: AudioContext | null = null;
  await paso("Audio", async () => {
    contexto = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
    void contexto.resume();
    const tono = contexto.createOscillator();
    const volumen = contexto.createGain();
    volumen.gain.value = 0.08;
    tono.connect(volumen).connect(contexto.destination);
    tono.start();
    tono.stop(contexto.currentTime + 0.4);
    const antes = contexto.currentTime;
    await new Promise((listo) => setTimeout(listo, 500));
    if (contexto.state !== "running") throw new Error(`el audio quedó en estado «${contexto.state}»`);
    if (contexto.currentTime === antes) throw new Error("el reloj de audio no avanza");
    return `en marcha a ${contexto.sampleRate} Hz (debió sonar un pitido corto)`;
  });
  await paso("Motor de audio", async () => {
    if (!contexto) throw new Error("no hay audio");
    await contexto.audioWorklet.addModule("/worklets/falab-procesador.js");
    const nodo = new AudioWorkletNode(contexto, "falab-procesador", { numberOfInputs: 0, numberOfOutputs: 13, outputChannelCount: new Array(13).fill(2) });
    nodo.disconnect();
    return "cargado";
  });
  void (contexto as AudioContext | null)?.close();

  await paso("Memoria del navegador", async () => {
    localStorage.setItem("falab.prueba", "1");
    localStorage.removeItem("falab.prueba");
    return "disponible";
  });

  const { motorLocal } = await import("../reproductor/motorLocal");
  const { pedir } = await import("../reproductor/banda");
  const sesion = motorLocal.banda;
  if (!sesion) {
    anotar({ bien: null, texto: "Banda: sin sesión iniciada (entra con tu usuario para comprobar la conexión)" });
    return;
  }
  await paso("Servidor de la banda", async () => {
    const inicio = performance.now();
    const info = await pedir<{ version: string }>(sesion, "GET", "/banda/info");
    return `versión ${info.version}, responde en ${Math.round(performance.now() - inicio)} ms`;
  });
  await paso("Sesión", async () => `iniciada como ${(await pedir<{ nombre: string }>(sesion, "GET", "/banda/yo")).nombre}`);
  let primera: { id: string; nombre: string; peso: number } | undefined;
  await paso("Canciones", async () => {
    const { canciones } = await pedir<{ canciones: { id: string; nombre: string; peso: number }[] }>(sesion, "GET", "/banda/canciones");
    primera = canciones[0];
    return `${canciones.length} en la biblioteca de la banda`;
  });
  if (primera) {
    const cancion = primera;
    await paso("Lectura por tramos", async () => {
      const respuesta = await fetch(`${sesion.url}/banda/canciones/${cancion.id}/paquete`, {
        headers: { Authorization: `Bearer ${sesion.testigo}`, Range: `bytes=${cancion.peso - 1024}-${cancion.peso - 1}` },
      });
      const bytes = (await respuesta.arrayBuffer()).byteLength;
      if (respuesta.status !== 206 || bytes !== 1024) throw new Error(`respuesta ${respuesta.status} con ${bytes} bytes (se esperaban 1024)`);
      return "correcta";
    });
    await paso(`Abrir «${cancion.nombre}»`, async () => {
      const datos = await motorLocal.atender("GET", `/proyectos/${cancion.id}`);
      return `${JSON.parse(new TextDecoder().decode(datos)).pistas.length} pistas`;
    });
  }
  await paso("Sala de sincronización", async () => {
    const sala = await pedir<{ ahora: number; sala: { director: string } | null }>(sesion, "GET", "/banda/sala");
    return `disponible, reloj a ${Math.round(sala.ahora - Date.now())} ms del de este dispositivo` + (sala.sala ? `, dirige ${sala.sala.director}` : "");
  });
  anotar({ bien: null, texto: `Estado de la sala aquí: ${JSON.stringify({ ...usarSala.getState(), sala: undefined })}` });
}

export function Diagnostico() {
  const [lineas, fijarLineas] = useState<Linea[] | null>(null);
  const [ocupado, fijarOcupado] = useState(false);
  const [copiado, fijarCopiado] = useState(false);
  const texto = (lineas ?? []).map((l) => `${l.bien === null ? "·" : l.bien ? "✓" : "✗"} ${l.texto}`).join("\n");

  const lanzar = () => {
    fijarOcupado(true);
    fijarCopiado(false);
    fijarLineas([]);
    void comprobar((linea) => fijarLineas((antes) => [...(antes ?? []), linea]))
      .catch((error) => fijarLineas((antes) => [...(antes ?? []), { bien: false, texto: String(error) }]))
      .finally(() => fijarOcupado(false));
  };

  return (
    <div className="diagnostico">
      <button className="plano" onClick={lanzar} disabled={ocupado}>{ocupado ? "Comprobando…" : "¿Algo no funciona? Comprobar este dispositivo"}</button>
      {lineas && (
        <div className="vidrio informe">
          <pre>{texto || "…"}</pre>
          {!ocupado && (
            <button onClick={() => void navigator.clipboard?.writeText(`falab · diagnóstico\n${texto}`).then(() => fijarCopiado(true))}>
              {copiado ? "Copiado" : "Copiar informe"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
