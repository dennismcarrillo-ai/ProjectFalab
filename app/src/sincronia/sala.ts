/**
 * Sala de sincronización: un dispositivo dirige y los demás le siguen en tiempo real.
 *
 * El director publica en la Mac de la banda qué canción suena, por dónde va y a qué velocidad y
 * tono. Cada seguidor abre esa misma canción y coloca su propio reproductor en ese punto, de modo
 * que el karaoke, el cancionero, la partitura y la tablatura avanzan a la vez en todas las
 * pantallas (cada músico elige la vista que le conviene).
 *
 * Para que el retraso de la red no descoloque a nadie, la posición viaja acompañada de la hora
 * del servidor en que era cierta. Cada dispositivo mide su desfase con ese reloj y calcula por
 * dónde debe ir «ahora»; después se vigila la deriva y se corrige si pasa de unas centésimas.
 */
import { create } from "zustand";
import { motorAudio } from "../audio/MotorAudio";
import { usarApp, usarReproduccion } from "../estado/almacen";
import { enEscritorio, motor, type EstadoDeSala, type RespuestaDeSala } from "../servicios/motor";

interface SalaLocal {
  /** Hay conexión con la Mac de la banda (o esta Mac tiene encendido el servidor de banda). */
  disponible: boolean;
  modo: "ninguno" | "dirigiendo" | "siguiendo";
  sala: EstadoDeSala | null;
  /** Quiénes están siguiendo ahora mismo. */
  siguen: string[];
  /** Al seguir: ¿suena también en este dispositivo? Por defecto no, para no pisar al director. */
  escuchar: boolean;
  /** Motivo por el que no se puede seguir la canción actual (por ejemplo, no está en el dispositivo). */
  falta: string | null;
}

export const usarSala = create<SalaLocal>(() => ({
  disponible: false, modo: "ninguno", sala: null, siguen: [], escuchar: false, falta: null,
}));

/** Identifica a este dispositivo mientras la página esté abierta. */
const CLIENTE = Math.random().toString(36).slice(2) + Date.now().toString(36);
/** Deriva máxima tolerada antes de recolocar el reproductor (s). */
const TOLERANCIA = 0.08;

const reloj = (): number => performance.timeOrigin + performance.now();
const dormir = (ms: number) => new Promise<void>((listo) => setTimeout(listo, ms));
const avisar = (texto: string, tipo: "info" | "error" = "info") => usarApp.setState({ aviso: { texto, tipo } });

/** Hora del servidor menos hora local (ms). */
let desfase = 0;
let version = -1;

// ------------------------------------------------------------------ transporte

async function sesionDeBanda() {
  const { motorLocal } = await import("../reproductor/motorLocal");
  return motorLocal.banda;
}

async function consultar(espera: number, sigue: boolean): Promise<RespuestaDeSala | null> {
  if (enEscritorio) return motor.banda.sala(sigue);
  const sesion = await sesionDeBanda();
  if (!sesion) return null;
  const { pedir } = await import("../reproductor/banda");
  return pedir<RespuestaDeSala>(sesion, "GET", `/banda/sala?version=${version}&espera=${espera}&sigue=${sigue ? 1 : 0}`);
}

async function publicarEnServidor(datos: unknown): Promise<RespuestaDeSala | null> {
  if (enEscritorio) return motor.banda.publicarSala(datos);
  const sesion = await sesionDeBanda();
  if (!sesion) return null;
  const { pedir } = await import("../reproductor/banda");
  return pedir<RespuestaDeSala>(sesion, "POST", "/banda/sala", datos);
}

async function cerrarEnServidor(): Promise<void> {
  if (enEscritorio) return void (await motor.banda.cerrarSala(CLIENTE));
  const sesion = await sesionDeBanda();
  if (!sesion) return;
  const { pedir } = await import("../reproductor/banda");
  await pedir(sesion, "DELETE", `/banda/sala?cliente=${encodeURIComponent(CLIENTE)}`);
}

/** Mide el desfase con el reloj del servidor: varias consultas rápidas, y vale la de menor retraso. */
async function calibrar(): Promise<void> {
  let mejor = Infinity;
  for (let i = 0; i < 5; i++) {
    const salida = reloj();
    const respuesta = await consultar(0, usarSala.getState().modo === "siguiendo").catch(() => null);
    const llegada = reloj();
    if (!respuesta?.disponible) return;
    if (llegada - salida < mejor) {
      mejor = llegada - salida;
      desfase = respuesta.ahora - (salida + llegada) / 2;
    }
  }
}

// ------------------------------------------------------------------ seguir

let aplicando = false;
let pendiente = false;
/** Tras recolocar o arrancar, se deja asentar el reproductor antes de volver a medir la deriva. */
let quietoHasta = 0;

function objetivoDe(sala: EstadoDeSala): number {
  if (!sala.sonando) return sala.posicion;
  return sala.posicion + ((reloj() + desfase - sala.momento) / 1000) * sala.velocidad;
}

/** Coloca el reproductor de este dispositivo donde va el director. */
function ajustar(): void {
  const { modo, sala } = usarSala.getState();
  const proyecto = usarApp.getState().proyecto;
  if (modo !== "siguiendo" || !sala || !proyecto || proyecto.id !== sala.proyecto) return;
  const local = usarReproduccion.getState();
  const objetivo = objetivoDe(sala);
  const sonando = sala.sonando && objetivo < proyecto.duracion;
  if (!sonando) {
    if (local.estado !== "detenido") motorAudio.pausar();
    const destino = Math.min(objetivo, proyecto.duracion);
    if (Math.abs(local.posicion - destino) > 0.03) motorAudio.saltar(destino);
    return;
  }
  if (reloj() < quietoHasta) return;
  if (local.estado === "detenido") {
    quietoHasta = reloj() + 900;
    motorAudio.saltar(objetivo);
    void motorAudio.reproducir({ sinCuenta: true }).catch((error) => avisar(`No se pudo reproducir: ${(error as Error).message}`, "error"));
  } else if (!local.esperando && Math.abs(local.posicion - objetivo) > TOLERANCIA) {
    quietoHasta = reloj() + 600;
    motorAudio.saltar(objetivo);
  }
}

/** Abre la canción del director (si hace falta), iguala velocidad y tono, y se coloca en su punto. */
async function aplicar(): Promise<void> {
  if (aplicando) {
    pendiente = true;
    return;
  }
  aplicando = true;
  try {
    const { modo, sala } = usarSala.getState();
    if (modo !== "siguiendo" || !sala || !sala.proyecto) return;
    if (usarApp.getState().proyecto?.id !== sala.proyecto) {
      const laTiene = () => usarApp.getState().proyectos.some((p) => p.id === sala.proyecto);
      if (!laTiene()) await usarApp.getState().refrescarProyectos().catch(() => undefined);
      if (!laTiene()) {
        usarSala.setState({ falta: `«${sala.nombre}» no está en este dispositivo ni en la biblioteca de la banda.` });
        return;
      }
      await usarApp.getState().abrir(sala.proyecto);
      if (usarApp.getState().proyecto?.id !== sala.proyecto) {
        usarSala.setState({ falta: `No se pudo abrir «${sala.nombre}».` });
        return;
      }
    }
    usarSala.setState({ falta: null });
    const proyecto = usarApp.getState().proyecto!;
    if (proyecto.velocidad !== sala.velocidad || proyecto.tono !== sala.tono) {
      usarApp.getState().ajustarProyecto({ velocidad: sala.velocidad, tono: sala.tono });
    }
    quietoHasta = 0;
    ajustar();
  } finally {
    aplicando = false;
    if (pendiente) {
      pendiente = false;
      void aplicar();
    }
  }
}

// ------------------------------------------------------------------ dirigir

let ultimoPublicado: { proyecto: string; sonando: boolean; posicion: number; momento: number; velocidad: number; tono: number } | null = null;
let envio: Promise<void> = Promise.resolve();
let envioPendiente = false;

function instantanea() {
  const proyecto = usarApp.getState().proyecto;
  const local = usarReproduccion.getState();
  return {
    cliente: CLIENTE,
    proyecto: proyecto?.id ?? "",
    nombre: proyecto?.nombre ?? "",
    // Durante la cuenta regresiva o mientras carga audio, la canción aún no avanza.
    sonando: !!proyecto && local.estado === "reproduciendo" && !local.esperando,
    posicion: proyecto ? local.posicion : 0,
    momento: reloj() + desfase,
    velocidad: proyecto?.velocidad ?? 1,
    tono: proyecto?.tono ?? 0,
  };
}

function publicar(latido = false): void {
  if (usarSala.getState().modo !== "dirigiendo") return;
  if (envioPendiente && !latido) return; // ya hay un envío en cola: llevará el estado más reciente
  if (!latido) envioPendiente = true;
  envio = envio.then(async () => {
    envioPendiente = false;
    if (usarSala.getState().modo !== "dirigiendo") return;
    const datos = instantanea();
    ultimoPublicado = datos;
    try {
      const respuesta = await publicarEnServidor({ ...datos, latido });
      if (respuesta) recibir(respuesta);
    } catch {
      /* se reintenta con el siguiente latido */
    }
  });
}

/** ¿Ha cambiado algo que los seguidores deban saber (canción, pausa, salto, velocidad, tono)? */
function vigilarDirector(): void {
  if (usarSala.getState().modo !== "dirigiendo") return;
  const ahora = instantanea();
  const antes = ultimoPublicado;
  if (!antes || antes.proyecto !== ahora.proyecto || antes.sonando !== ahora.sonando
    || antes.velocidad !== ahora.velocidad || antes.tono !== ahora.tono) return publicar();
  const esperado = antes.sonando ? antes.posicion + ((ahora.momento - antes.momento) / 1000) * antes.velocidad : antes.posicion;
  if (Math.abs(ahora.posicion - esperado) > 0.15) publicar();
}

// ------------------------------------------------------------------ estado común

function recibir(respuesta: RespuestaDeSala): void {
  const { modo, sala: anterior } = usarSala.getState();
  const cambio = respuesta.version !== version;
  version = respuesta.version;
  usarSala.setState({ disponible: respuesta.disponible, sala: respuesta.sala, siguen: respuesta.siguen });
  if (modo === "dirigiendo" && respuesta.sala && respuesta.sala.cliente !== CLIENTE) {
    usarSala.setState({ modo: "ninguno" });
    avisar(`${respuesta.sala.director} ha tomado la dirección de la sesión.`);
  } else if (modo === "siguiendo") {
    if (!respuesta.sala) {
      dejarDeSeguir();
      avisar(`${anterior?.director ?? "El director"} ha terminado la sesión sincronizada.`);
    } else if (cambio) {
      void aplicar();
    }
  }
}

function dejarDeSeguir(): void {
  usarSala.setState({ modo: "ninguno", falta: null });
  motorAudio.pausar();
  motorAudio.fijarSilencio(false);
}

/** Empieza a seguir al director. Debe llamarse desde un toque: así el navegador deja sonar. */
export function seguir(): void {
  const { sala, escuchar } = usarSala.getState();
  if (!sala) return;
  motorAudio.fijarSilencio(!escuchar);
  void motorAudio.iniciar().catch((error) => avisar(`No se pudo preparar el audio: ${(error as Error).message}`, "error"));
  usarSala.setState({ modo: "siguiendo", falta: null });
  void calibrar().then(aplicar);
}

/** Este dispositivo pasa a dirigir: los demás verán lo que haga con el transporte. */
export function dirigir(): void {
  if (usarSala.getState().modo === "siguiendo") dejarDeSeguir();
  ultimoPublicado = null;
  usarSala.setState({ modo: "dirigiendo" });
  void calibrar().then(() => publicar());
}

export function dejar(): void {
  const { modo } = usarSala.getState();
  if (modo === "siguiendo") dejarDeSeguir();
  if (modo === "dirigiendo") {
    usarSala.setState({ modo: "ninguno" });
    void cerrarEnServidor().catch(() => undefined);
  }
}

export function fijarEscucha(escuchar: boolean): void {
  usarSala.setState({ escuchar });
  if (usarSala.getState().modo === "siguiendo") motorAudio.fijarSilencio(!escuchar);
}

// ------------------------------------------------------------------ puesta en marcha

let enMarcha = false;

/** Arranca la vigilancia de la sala. Se llama una vez al abrir la aplicación. */
export function iniciarSala(): void {
  if (enMarcha || typeof window === "undefined") return;
  enMarcha = true;

  // Consulta continua. En la web la respuesta se retiene hasta que algo cambia (aviso inmediato);
  // en la Mac, que habla con su propio motor, se pregunta a menudo.
  void (async () => {
    for (;;) {
      const { modo } = usarSala.getState();
      let pausa = 5000;
      try {
        const respuesta = await consultar(enEscritorio ? 0 : 20, modo === "siguiendo");
        if (!respuesta) usarSala.setState({ disponible: false, sala: null });
        else {
          recibir(respuesta);
          if (!respuesta.disponible) pausa = 15000;
          else if (!enEscritorio) pausa = 50;
          else pausa = usarSala.getState().modo === "siguiendo" ? 400 : 3000;
        }
      } catch {
        usarSala.setState({ disponible: false });
      }
      await dormir(pausa);
    }
  })();

  usarReproduccion.subscribe(vigilarDirector);
  usarApp.subscribe(vigilarDirector);

  let latidos = 0;
  setInterval(() => {
    const { modo } = usarSala.getState();
    latidos++;
    if (modo === "siguiendo") ajustar();
    if (modo === "dirigiendo" && latidos % 4 === 0) publicar(true);
    if (modo !== "ninguno" && latidos % 120 === 0) void calibrar();
  }, 1000);

  // Al cerrar la página, el director suelta la sala para que nadie se quede esperando.
  window.addEventListener("pagehide", () => {
    if (usarSala.getState().modo === "dirigiendo") void cerrarEnServidor().catch(() => undefined);
  });
}
