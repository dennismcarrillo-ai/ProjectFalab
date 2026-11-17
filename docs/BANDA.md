# Compartir falab con la banda

Tu Mac puede hacer de servidor para tu banda: los demás músicos entran desde su navegador (o
desde la app de iPad o Android), ven las canciones, las reproducen y pueden subir las suyas para
que **tu Mac** las analice. No hay nube ni cuotas: las canciones, las cuentas y el análisis se
quedan en tu Mac.

```
 Músico (móvil, tableta, PC)                Tu Mac
 navegador ──HTTPS──► túnel gratuito ──►  servidor de banda de falab (puerto 8787)
                                            ├─ cuentas de la banda
                                            ├─ biblioteca (.falab servidos por tramos)
                                            └─ cola de análisis (Demucs, Whisper…)
```

## 1. Encender el servidor

En falab (Mac), en la pantalla de inicio pulsa **Banda**:

1. Marca **Servidor de banda encendido**.
2. En **Músicos**, crea una cuenta para cada uno (nombre y contraseña de al menos 8 caracteres).
   Dásela por un canal privado; cada músico usa la suya.

El servidor escucha solo dentro de tu Mac (`127.0.0.1:8787`). Para que entren desde otras redes
hace falta el paso 2.

## 2. Abrir un túnel HTTPS gratuito (Tailscale Funnel)

Los navegadores solo permiten el audio de falab en páginas `https://`. Tailscale Funnel te da una
dirección `https://` pública que apunta a tu Mac, sin abrir puertos en el router. Está incluido en
el plan gratuito y **solo se instala en tu Mac**: los músicos no instalan nada.

1. Instala Tailscale desde <https://tailscale.com/download> e inicia sesión.
2. En la Terminal:

   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8787
   ```

   La primera vez te mostrará un enlace para activar Funnel y los certificados HTTPS en tu
   cuenta: ábrelo, acepta y repite el comando.
3. El comando muestra la dirección pública, del tipo `https://tu-mac.algo.ts.net`. Pégala en falab,
   en **Banda → Dirección para los músicos**, y compártela con la banda.

Para dejar de compartir: apaga el servidor en falab, o cierra el túnel con

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel reset
```

> Los comandos de Tailscale pueden cambiar entre versiones. Si alguno no funciona, la referencia
> actual está en <https://tailscale.com/docs/features/tailscale-funnel>.

## 3. Lo que hace cada músico

1. Abre la dirección en su navegador (Chrome, Safari, Edge…), en el móvil, la tableta o el PC.
2. Entra con su nombre y contraseña.
3. Ve la biblioteca. Al tocar una canción se reproduce **por internet**, pidiendo a tu Mac solo
   los trozos que necesita.
4. **Subir una canción**: elige un audio o un video; tu Mac lo analiza (unos minutos) y aparece
   en la lista de todos, con el nombre de quien lo subió.
5. **Descargar**: guarda la canción como archivo `.falab` para usarla sin conexión (se abre
   después con «Elegir proyectos…»).

En las apps de iPad y Android es igual, escribiendo además la dirección de la banda al entrar.

## Qué conviene saber

- **Tu Mac debe estar encendida**, con falab abierto. Mientras el servidor está encendido la Mac
  no entra en reposo, pero con la tapa cerrada sí. Si está apagada, los músicos pueden seguir
  tocando lo que hayan descargado.
- **Las canciones se analizan de una en una.** Si varios suben a la vez, se ponen en cola.
- **Para ensayar o tocar en directo, mejor descargar.** El streaming depende de la conexión de
  cada uno y de la tuya, y Tailscale aplica a Funnel un límite de ancho de banda que no publica.
- **Tamaño máximo por subida**: 600 MB.
- **Lo que un músico NO puede hacer** desde fuera: borrar canciones, editar clips, cambiar la
  estructura o tocar tus ajustes. Eso solo se hace en la Mac. La mezcla que cada uno haga
  (volúmenes, silencios, tono) se guarda en su propio dispositivo.

## Seguridad

- Las contraseñas no se guardan: solo una huella cifrada (scrypt). Tampoco los testigos de sesión.
- Tras cinco intentos fallidos, ese usuario debe esperar un minuto.
- Las sesiones caducan a los 30 días; cambiar la contraseña de un músico cierra sus sesiones.
- El servidor de banda es una aplicación separada de la que usa tu app de la Mac y solo ofrece
  ver, reproducir, descargar y subir. Aun así, la dirección es pública: usa contraseñas largas y
  apaga el servidor cuando no lo uses.

## Estado

El servidor, las cuentas, el streaming y la subida están probados con pruebas automáticas y de
punta a punta en un navegador contra el servidor real, en la misma máquina. **No se ha probado a
través de un túnel de Tailscale ni desde otra red**: eso es lo que queda por confirmar en tu Mac.

## Sesión sincronizada (todos ven la canción a la vez)

Con la banda conectada aparece una barra bajo la cabecera:

1. Quien lleva la canción pulsa **Dirigir sesión** (puede ser la Mac, la web, el iPad o el Android).
2. A los demás les sale el aviso «*Nombre* dirige una sesión sincronizada» y pulsan **Seguir**.
3. Desde ese momento, todo lo que haga el director con el transporte (abrir una canción,
   reproducir, pausar, saltar a otro punto, cambiar velocidad o tono) se repite en los demás
   dispositivos. Cada músico elige su vista: karaoke, cancionero, partitura, tablatura o mezcla.

Detalles:

- Los seguidores van **en silencio** por defecto, para no pisar el sonido del director. La casilla
  «Oír aquí» lo activa (útil si cada uno está en un sitio distinto, con auriculares).
- El director ve quién le sigue. Si otro pulsa «Dirigir yo», toma el relevo.
- La posición se corrige sola: cada dispositivo mide su desfase con el reloj de la Mac de la banda
  y se recoloca si se aleja más de 80 ms.
- Cada seguidor necesita la canción: vale la de la biblioteca de la banda (se reproduce por
  internet) o una copia guardada en el dispositivo.
- En la Mac hace falta tener encendido «Compartir con la banda» para que aparezca la barra.
- Si el director deja de dar señales durante 20 segundos (cerró la app, se quedó sin red), la
  sesión termina sola.
