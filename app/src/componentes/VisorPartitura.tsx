/**
 * Partitura y tablatura sincronizadas con la reproducción.
 *
 * El dibujo lo hace alphaTab (estilo Guitar Pro), pero SIN su reproductor: el motor nos dice
 * cuándo empieza cada compás real de la canción y el cursor se coloca con nuestro propio reloj
 * de audio. Así sigue los cambios de tempo y de compás igual que el metrónomo.
 *
 * Para no congelar la interfaz: la biblioteca se carga solo al abrir el visor, el dibujo es
 * perezoso (solo los sistemas visibles) y el cursor se mueve escribiendo estilos directamente,
 * sin volver a renderizar React en cada cuadro.
 */
import { useEffect, useRef, useState } from "react";
import { usarApp, usarReproduccion } from "../estado/almacen";
import { motor } from "../servicios/motor";

export type ModoPartitura = "partitura" | "tablatura" | "ambas";

interface Compas { inicio: number; fin: number }
interface Caja { x: number; y: number; w: number; h: number }
interface ApiMinima {
  boundsLookup: { findMasterBarByIndex(indice: number): { realBounds: Caja } | null } | null;
  destroy(): void;
}

export function VisorPartitura({ instrumento, modo, escala = 1 }: { instrumento: string; modo: ModoPartitura; escala?: number }) {
  const idProyecto = usarApp((s) => s.proyecto!.id);
  // Si cambia la estructura (compases) o el tempo, la partitura debe regenerarse.
  const version = usarApp((s) => `${s.analisis?.secciones.map((x) => `${x.inicio}:${x.compas ?? ""}`).join("|")}#${s.analisis?.mapaTempo.pulsos.length}`);
  const refCaja = useRef<HTMLDivElement>(null);
  const refLienzo = useRef<HTMLDivElement>(null);
  const refCursor = useRef<HTMLDivElement>(null);
  const [estado, fijarEstado] = useState<"cargando" | "lista" | "vacia" | "error">("cargando");

  useEffect(() => {
    let vigente = true;
    let api: ApiMinima | null = null;
    let compases: Compas[] = [];
    let ultimoSistema = -1;
    let cancelarReloj = () => {};
    fijarEstado("cargando");

    const colocar = ({ posicion, estado: transporte }: { posicion: number; estado: string }) => {
      const cursor = refCursor.current;
      const consulta = api?.boundsLookup;
      if (!cursor || !consulta || compases.length === 0) return;
      // Búsqueda binaria del compás que contiene la posición.
      let a = 0, b = compases.length - 1;
      while (a < b) {
        const medio = (a + b + 1) >> 1;
        if (compases[medio].inicio <= posicion) a = medio; else b = medio - 1;
      }
      const compas = compases[a];
      const caja = consulta.findMasterBarByIndex(a)?.realBounds;
      if (!caja) return;
      const avance = Math.min(1, Math.max(0, (posicion - compas.inicio) / Math.max(compas.fin - compas.inicio, 0.01)));
      cursor.style.display = "block";
      cursor.style.transform = `translate(${caja.x + avance * caja.w}px, ${caja.y}px)`;
      cursor.style.height = `${caja.h}px`;
      // Al cambiar de sistema (línea de pentagramas) se desplaza la vista para seguir al cursor.
      const contenedor = refCaja.current;
      if (contenedor && transporte !== "detenido" && caja.y !== ultimoSistema) {
        ultimoSistema = caja.y;
        contenedor.scrollTo({ top: Math.max(0, caja.y - 40), behavior: "smooth" });
      }
    };

    (async () => {
      try {
        const datos = await motor.alphatex(idProyecto, instrumento, modo);
        const alphaTab = await import("@coderline/alphatab");
        if (!vigente || !refLienzo.current) return;
        compases = datos.compases;
        refLienzo.current.innerHTML = "";
        const nueva = new alphaTab.AlphaTabApi(refLienzo.current, {
          core: { useWorkers: false, fontDirectory: "/alphatab/font/", enableLazyLoading: true },
          player: { playerMode: alphaTab.PlayerMode.Disabled },
          display: { scale: escala, layoutMode: alphaTab.LayoutMode.Page },
          // En el panel estrecho se omite el título para aprovechar el alto.
          notation: escala < 1
            ? { elements: new Map([[alphaTab.NotationElement.ScoreTitle, false], [alphaTab.NotationElement.GuitarTuning, false]]) }
            : {},
        });
        api = nueva as unknown as ApiMinima;
        nueva.error.on((error) => {
          console.error("alphaTab:", error);
          if (vigente) fijarEstado("error");
        });
        nueva.postRenderFinished.on(() => {
          if (!vigente) return;
          fijarEstado("lista");
          colocar(usarReproduccion.getState());
        });
        // Clic en un compás: la canción salta ahí.
        nueva.beatMouseDown.on((pulso) => {
          const indice = pulso.voice.bar.index;
          if (compases[indice]) usarApp.getState().saltar(compases[indice].inicio);
        });
        nueva.tex(datos.tex);
        cancelarReloj = usarReproduccion.subscribe(colocar);
      } catch (error) {
        if (!vigente) return;
        const mensaje = (error as Error).message ?? "";
        fijarEstado(/no hay notas/i.test(mensaje) ? "vacia" : "error");
        if (!/no hay notas/i.test(mensaje)) console.error(error);
      }
    })();
    return () => {
      vigente = false;
      cancelarReloj();
      api?.destroy();
    };
  }, [idProyecto, instrumento, modo, escala, version]);

  return (
    <div className="visor-partitura" ref={refCaja}>
      {estado === "cargando" && <p className="aviso-visor">Preparando la partitura…</p>}
      {estado === "vacia" && <p className="aviso-visor">No hay notas detectadas para este instrumento.</p>}
      {estado === "error" && <p className="aviso-visor">No se pudo dibujar la partitura de este instrumento.</p>}
      <div className="papel" style={{ visibility: estado === "lista" ? "visible" : "hidden" }}>
        <div ref={refLienzo} />
        <div className="cursor-partitura" ref={refCursor} />
      </div>
    </div>
  );
}

export const NOMBRES_INSTRUMENTO: Record<string, string> = {
  voz: "Voz", bajo: "Bajo", guitarra: "Guitarra", piano: "Piano", otros: "Otros",
};
export const CON_TRASTES = ["bajo", "guitarra"];
