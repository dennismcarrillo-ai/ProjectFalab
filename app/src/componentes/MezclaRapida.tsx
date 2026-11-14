/**
 * Mezcla rápida: silenciar, dejar en solo y ajustar el volumen de cada pista sin salir del
 * karaoke, el cancionero o la partitura (por ejemplo, quitar la voz para cantar encima o el
 * bajo para tocarlo uno mismo).
 */
import { useEffect, useRef, useState } from "react";
import { usarApp } from "../estado/almacen";

export function MezclaRapida() {
  const pistas = usarApp((s) => s.proyecto!.pistas);
  const { ajustarPista } = usarApp.getState();
  const [abierta, fijarAbierta] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const silenciadas = pistas.filter((p) => p.silencio).length;
  const enSolo = pistas.filter((p) => p.solo).length;

  useEffect(() => {
    if (!abierta) return;
    const fuera = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fijarAbierta(false);
    };
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && fijarAbierta(false);
    window.addEventListener("pointerdown", fuera, true);
    window.addEventListener("keydown", tecla);
    return () => {
      window.removeEventListener("pointerdown", fuera, true);
      window.removeEventListener("keydown", tecla);
    };
  }, [abierta]);

  return (
    <div className="mezcla-rapida" ref={ref}>
      <button className={abierta || silenciadas || enSolo ? "activo" : ""} aria-expanded={abierta} aria-haspopup="dialog"
        onClick={() => fijarAbierta(!abierta)} title="Silenciar o dejar en solo las pistas (M)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M5 3h2v8H5zM5 15h2v6H5zM3 11h6v4H3zM11 3h2v3h-2zM11 10h2v11h-2zM9 6h6v4H9zM17 3h2v10h-2zM17 17h2v4h-2zM15 13h6v4h-6z" />
        </svg>
        Pistas{silenciadas ? ` · ${silenciadas} en silencio` : enSolo ? ` · ${enSolo} en solo` : ""}
      </button>
      {abierta && (
        <div className="panel-mezcla vidrio" role="dialog" aria-label="Mezcla rápida">
          {pistas.map((pista) => (
            <div className="fila-mezcla" key={pista.id}>
              <span className="punto-color" style={{ background: pista.color }} />
              <span className="nombre">{pista.nombre}</span>
              <input type="range" min={-48} max={6} step={0.5} value={pista.volumen} aria-label={`Volumen de ${pista.nombre}`}
                onChange={(e) => ajustarPista(pista.id, { volumen: Number(e.target.value) })}
                onDoubleClick={() => ajustarPista(pista.id, { volumen: 0 })} />
              <button className={`boton-mini silencio ${pista.silencio ? "activo" : ""}`} aria-pressed={pista.silencio}
                title="Silenciar" aria-label={`Silenciar ${pista.nombre}`}
                onClick={() => ajustarPista(pista.id, { silencio: !pista.silencio })}>M</button>
              <button className={`boton-mini solo ${pista.solo ? "activo" : ""}`} aria-pressed={pista.solo}
                title="Solo" aria-label={`Solo de ${pista.nombre}`}
                onClick={() => ajustarPista(pista.id, { solo: !pista.solo })}>S</button>
            </div>
          ))}
          {(silenciadas > 0 || enSolo > 0) && (
            <button className="plano" style={{ alignSelf: "flex-end" }}
              onClick={() => pistas.forEach((p) => (p.silencio || p.solo) && ajustarPista(p.id, { silencio: false, solo: false }))}>
              Que suenen todas
            </button>
          )}
        </div>
      )}
    </div>
  );
}
