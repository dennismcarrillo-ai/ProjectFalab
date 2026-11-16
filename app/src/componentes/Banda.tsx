/**
 * Banda: la Mac de un músico analiza las canciones y las comparte con los demás.
 *  - PanelDeBanda: en el reproductor (web, iPad, Android), para entrar, subir canciones y ver la cola.
 *  - DialogoBanda: en la app de la Mac, para encender el servidor y gestionar las cuentas.
 */
import { useEffect, useRef, useState } from "react";
import { usarApp } from "../estado/almacen";
import { servidaPorLaBanda } from "../reproductor/banda";
import { motor, type EstadoDeBanda } from "../servicios/motor";

const EXTENSIONES = ".mp3,.wav,.flac,.ogg,.aac,.m4a,.mp4,.mov,.mkv";

export function PanelDeBanda() {
  const banda = usarApp((s) => s.banda);
  const { entrarEnBanda, salirDeBanda, subirABanda } = usarApp.getState();
  const [url, fijarUrl] = useState("");
  const [nombre, fijarNombre] = useState("");
  const [clave, fijarClave] = useState("");
  const [entrando, fijarEntrando] = useState(false);
  const [coros, fijarCoros] = useState(false);
  const refArchivo = useRef<HTMLInputElement>(null);

  if (!banda.usuario) {
    const entrar = async (e: React.FormEvent) => {
      e.preventDefault();
      fijarEntrando(true);
      if (await entrarEnBanda(servidaPorLaBanda ? "" : url, nombre, clave)) fijarClave("");
      fijarEntrando(false);
    };
    return (
      <form className="panel-banda vidrio" onSubmit={entrar} aria-label="Entrar en la banda">
        <strong>{servidaPorLaBanda ? "Entra con tu usuario de la banda" : "Conectar con la Mac de la banda"}</strong>
        <div className="tenue">
          {servidaPorLaBanda
            ? "Verás las canciones compartidas y podrás subir las tuyas para que se analicen."
            : "Si alguien de tu banda comparte su falab, escribe la dirección que te dio y tu usuario."}
        </div>
        <div className="campos">
          {!servidaPorLaBanda && (
            <input type="url" inputMode="url" placeholder="https://… (dirección de la banda)" value={url} required
              aria-label="Dirección de la banda" autoCapitalize="none" autoCorrect="off" onChange={(e) => fijarUrl(e.target.value)} />
          )}
          <input type="text" placeholder="Tu nombre" value={nombre} required aria-label="Nombre de usuario" autoComplete="username"
            autoCapitalize="none" onChange={(e) => fijarNombre(e.target.value)} />
          <input type="password" placeholder="Contraseña" value={clave} required aria-label="Contraseña" autoComplete="current-password"
            onChange={(e) => fijarClave(e.target.value)} />
          <button className="primario" type="submit" disabled={entrando}>{entrando ? "Entrando…" : "Entrar"}</button>
        </div>
      </form>
    );
  }

  return (
    <div className="panel-banda vidrio">
      <div className="cabecera-banda">
        <strong>Banda · hola, {banda.usuario}</strong>
        <span className="crecer" />
        <button className="plano" onClick={() => void salirDeBanda()}>Cerrar sesión</button>
      </div>
      <div className="campos">
        <button className="primario" disabled={banda.subida !== null} onClick={() => refArchivo.current?.click()}>
          {banda.subida !== null ? `Subiendo… ${Math.round(banda.subida * 100)}%` : "Subir una canción"}
        </button>
        <label className="casilla">
          <input type="checkbox" checked={coros} onChange={(e) => fijarCoros(e.target.checked)} />
          Separar coros de la voz principal
        </label>
        <input ref={refArchivo} type="file" hidden accept={EXTENSIONES} aria-label="Canción para subir a la banda"
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            if (archivo) void subirABanda(archivo, coros);
            e.target.value = "";
          }} />
      </div>
      {banda.subida !== null && <div className="barra-progreso"><div style={{ width: `${Math.round(banda.subida * 100)}%` }} /></div>}
      <div className="tenue" style={{ fontSize: 12 }}>
        La canción se analiza en la Mac de la banda (unos minutos) y aparece en la lista de todos.
      </div>
      {banda.cola.length > 0 && (
        <div className="cola-banda" aria-label="Canciones en análisis">
          {banda.cola.map((trabajo) => (
            <div className="en-cola" key={trabajo.id}>
              <span className="titulo">{trabajo.nombre} <span className="tenue">· {trabajo.usuario}</span></span>
              {trabajo.estado === "error"
                ? <span style={{ color: "var(--peligro)" }}>No se pudo analizar: {trabajo.error}</span>
                : trabajo.estado === "pendiente"
                  ? <span className="tenue">En cola</span>
                  : <><span className="tenue">{trabajo.etapa || "Analizando…"}</span>
                    <span className="barra-progreso"><span style={{ width: `${Math.round(trabajo.progreso * 100)}%` }} /></span>
                    <span className="mono">{Math.round(trabajo.progreso * 100)}%</span></>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** App de la Mac: encender el servidor de banda y gestionar las cuentas de los músicos. */
export function DialogoBanda() {
  const { fijar } = usarApp.getState();
  const [estado, fijarEstado] = useState<EstadoDeBanda | null>(null);
  const [direccion, fijarDireccion] = useState("");
  const [nombre, fijarNombre] = useState("");
  const [clave, fijarClave] = useState("");
  const error = (e: unknown) => fijar({ aviso: { texto: (e as Error).message, tipo: "error" } });
  const aplicar = (nuevo: EstadoDeBanda) => {
    fijarEstado(nuevo);
    fijarDireccion(nuevo.direccion);
  };
  useEffect(() => void motor.banda.estado().then(aplicar).catch(error), []); // eslint-disable-line react-hooks/exhaustive-deps

  const crear = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await motor.banda.crearUsuario(nombre, clave);
      fijarNombre("");
      fijarClave("");
      aplicar(await motor.banda.estado());
    } catch (e2) {
      error(e2);
    }
  };

  return (
    <div className="velo" onPointerDown={(e) => e.target === e.currentTarget && fijar({ dialogo: null })}>
      <div className="dialogo vidrio" role="dialog" aria-label="Banda" style={{ width: 620 }}>
        <h2>Compartir con la banda</h2>
        <p className="tenue">
          Esta Mac hace de servidor: los demás músicos entran desde su navegador, ven las canciones y pueden subir las
          suyas para que se analicen aquí. No hay nube: las canciones y las cuentas se quedan en esta Mac.
        </p>
        {!estado && <p className="tenue">Comprobando…</p>}
        {estado && (
          <>
            <label className="fila-opcion" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={estado.activo}
                onChange={(e) => void motor.banda.fijar({ activo: e.target.checked }).then(aplicar).catch(error)} />
              <span className="descripcion">
                Servidor de banda encendido
                <div className="tenue" style={{ fontSize: 11.5 }}>
                  {estado.funcionando
                    ? `Escuchando en esta Mac (puerto ${estado.puerto}). Mientras esté encendido, la Mac no entra en reposo.`
                    : "Apagado: nadie puede entrar."}
                </div>
              </span>
            </label>
            {!estado.interfazLista && (
              <p style={{ color: "var(--ambar)" }}>
                Falta compilar la interfaz web. Ejecuta «npm run build» en la carpeta app y vuelve a encender el servidor.
              </p>
            )}

            <h3>Dirección para los músicos</h3>
            <p className="tenue" style={{ fontSize: 12 }}>
              Para que entren desde otras redes hace falta un túnel HTTPS gratuito (ver docs/BANDA.md). Pega aquí la
              dirección que te dé, para tenerla a mano y compartirla.
            </p>
            <div className="fila-opcion">
              <input type="url" placeholder="https://tu-mac.tu-red.ts.net" value={direccion} style={{ flex: 1, userSelect: "text" }}
                aria-label="Dirección pública" onChange={(e) => fijarDireccion(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <button onClick={() => void motor.banda.fijar({ direccion }).then(aplicar).catch(error)}>Guardar</button>
              <button disabled={!estado.direccion} onClick={() => void navigator.clipboard?.writeText(estado.direccion)}>Copiar</button>
            </div>

            <h3>Músicos</h3>
            {estado.usuarios.length === 0 && <p className="tenue">Aún no hay cuentas. Crea una para cada músico.</p>}
            {estado.usuarios.map((usuario) => (
              <div className="fila-opcion" key={usuario.id}>
                <span className="descripcion">{usuario.nombre}</span>
                <button className="plano" onClick={() => {
                  const nueva = window.prompt(`Nueva contraseña para ${usuario.nombre} (mínimo 8 caracteres):`);
                  if (nueva) void motor.banda.cambiarClave(usuario.id, nueva).then(() => fijar({ aviso: { texto: "Contraseña cambiada.", tipo: "info" } })).catch(error);
                }}>Cambiar contraseña</button>
                <button className="plano" onClick={() => {
                  if (window.confirm(`¿Quitar a ${usuario.nombre} de la banda?`)) void motor.banda.eliminarUsuario(usuario.id).then(() => motor.banda.estado()).then(aplicar).catch(error);
                }}>Quitar</button>
              </div>
            ))}
            <form className="fila-opcion" onSubmit={crear}>
              <input type="text" placeholder="Nombre" value={nombre} required style={{ flex: 1, userSelect: "text" }} aria-label="Nombre del músico"
                onChange={(e) => fijarNombre(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <input type="text" placeholder="Contraseña (mín. 8)" value={clave} required minLength={8} style={{ flex: 1, userSelect: "text" }}
                aria-label="Contraseña del músico" onChange={(e) => fijarClave(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <button className="primario" type="submit">Añadir</button>
            </form>
          </>
        )}
        <div className="pie"><button onClick={() => fijar({ dialogo: null })}>Cerrar</button></div>
      </div>
    </div>
  );
}
