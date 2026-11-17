/**
 * Barra de la sala de sincronización: quién dirige, botón para seguirle y, para el director,
 * quiénes le están siguiendo. Solo aparece cuando hay conexión con la Mac de la banda.
 */
import { usarApp } from "../estado/almacen";
import { dejar, dirigir, fijarEscucha, seguir, usarSala } from "../sincronia/sala";

export function BarraDeSala() {
  const { disponible, modo, sala, siguen, escuchar, falta } = usarSala();
  const hayProyecto = usarApp((s) => !!s.proyecto);
  if (!disponible) return null;

  if (modo === "dirigiendo") {
    return (
      <div className="barra-sala dirigiendo" role="status">
        <span className="punto-vivo" aria-hidden />
        <strong>Diriges la sesión</strong>
        <span className="tenue crecer">
          {siguen.length ? `Te siguen: ${siguen.join(", ")}` : "Aún no te sigue nadie. Los demás verán el aviso para unirse."}
        </span>
        <button onClick={dejar}>Terminar</button>
      </div>
    );
  }

  if (modo === "siguiendo" && sala) {
    return (
      <div className="barra-sala siguiendo" role="status">
        <span className="punto-vivo" aria-hidden />
        <strong>Siguiendo a {sala.director}</strong>
        <span className="tenue crecer">{falta ?? (sala.nombre ? `«${sala.nombre}»` : "Esperando a que abra una canción…")}</span>
        <label className="casilla" title="Sin marcar, este dispositivo es un teleprónter: muestra letra y acordes sin descargar audio">
          <input type="checkbox" checked={escuchar} onChange={(e) => fijarEscucha(e.target.checked)} />
          Oír aquí
        </label>
        <button onClick={dirigir} title="Pasas a dirigir tú: los demás te seguirán a ti">Dirigir yo</button>
        <button onClick={dejar}>Dejar de seguir</button>
      </div>
    );
  }

  if (sala) {
    return (
      <div className="barra-sala" role="status">
        <span className="punto-vivo" aria-hidden />
        <span className="crecer">
          <strong>{sala.director}</strong> dirige una sesión sincronizada{sala.nombre ? ` · «${sala.nombre}»` : ""}
        </span>
        <button className="primario" onClick={seguir}>Seguir</button>
        <button onClick={dirigir} title="Pasas a dirigir tú: los demás te seguirán a ti">Dirigir yo</button>
      </div>
    );
  }

  return (
    <div className={`barra-sala discreta ${hayProyecto ? "con-proyecto" : ""}`}>
      <span className="tenue crecer">
        {hayProyecto ? "Sincroniza esta canción en los dispositivos de la banda." : "Sesión sincronizada: todos ven la misma canción a la vez."}
      </span>
      <button onClick={dirigir} title="Los demás dispositivos de la banda podrán seguir lo que reproduzcas">Dirigir sesión</button>
    </div>
  );
}
