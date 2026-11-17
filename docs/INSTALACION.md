# Instalar falab desde cero en todos los dispositivos

Esta guía reúne, en orden, todo lo necesario para dejar falab funcionando en cada entorno.
Cada sección enlaza a su guía detallada.

## Qué papel tiene cada dispositivo

| Dispositivo | Qué es | Qué hace |
|---|---|---|
| **Mac** o **PC con Windows** | Estudio | Analiza canciones (pistas, letra, acordes), edita, graba, exporta y puede ser el servidor de la banda |
| **iPad, iPhone, teléfono y tableta Android** | Reproductor (app) | Reproduce y mezcla canciones ya analizadas, karaoke, cancionero, partitura, tablatura; sube canciones a la banda; sesiones sincronizadas |
| **Cualquier navegador** (móvil, tableta, PC) | Reproductor (web) | Lo mismo que la app, sin instalar nada, entrando en la dirección de la banda |

El análisis con IA ocurre siempre en el estudio (Mac o Windows), nunca en la nube.

Orden recomendado: **1)** el estudio, **2)** el servidor de la banda, **3)** los reproductores.

---

## 1. Estudio en Mac

Requisitos: Mac con Apple Silicon (o Intel), unos 10 GB libres.

1. Instala **Homebrew** (<https://brew.sh>) y **Xcode** desde el App Store. Abre Xcode una vez.
2. En la Terminal, descarga falab:

   ```bash
   cd ~ && git clone https://github.com/dennismcarrillo-ai/ProjectFalab.git
   ```

3. Instala el motor, los modelos de IA y la interfaz (tarda: varios GB):

   ```bash
   cd ~/ProjectFalab && ./scripts/instalar_mac.sh
   ```

4. Genera la aplicación:

   ```bash
   source "$HOME/.cargo/env" && cd ~/ProjectFalab/app && npm run tauri build -- --bundles app
   ```

5. Cópiala a Aplicaciones:

   ```bash
   rm -rf /Applications/falab.app && cp -R ~/ProjectFalab/app/src-tauri/target/release/bundle/macos/falab.app /Applications/
   ```

Abre **falab** desde Aplicaciones o Launchpad. La primera canción que analices descarga los pesos
de los modelos; después funciona sin conexión.

Opcional: Google Drive ([GOOGLE_DRIVE.md](GOOGLE_DRIVE.md)).

## 2. Estudio en Windows

Requisitos: Windows 10 u 11 de 64 bits, unos 10 GB libres. Con tarjeta NVIDIA el análisis es
mucho más rápido. Detalles en [WINDOWS.md](WINDOWS.md).

1. En PowerShell, instala Git y después cierra y vuelve a abrir PowerShell:

   ```powershell
   winget install --id Git.Git -e
   ```

2. Descarga falab:

   ```powershell
   cd $env:USERPROFILE; git clone https://github.com/dennismcarrillo-ai/ProjectFalab.git; cd ProjectFalab
   ```

3. Ejecuta el instalador (motor, modelos de IA, FFmpeg y la aplicación ya compilada):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\instalar_windows.ps1
   ```

Si aparece «Windows protegió su PC», pulsa «Más información» → «Ejecutar de todas formas».
Después, **falab** está en el menú Inicio.

## 3. Servidor de la banda (en el estudio)

Hace falta para la versión web, para que los demás suban canciones y para las sesiones
sincronizadas. Detalles en [BANDA.md](BANDA.md).

1. En falab, pantalla de inicio → **Banda** → marca **Servidor de banda encendido** y crea una
   cuenta (nombre y contraseña) para cada músico.
2. Instala **Tailscale** (<https://tailscale.com/download>) en el estudio e inicia sesión.
3. Abre el túnel HTTPS gratuito. En Mac:

   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8787
   ```

   En Windows (PowerShell):

   ```powershell
   tailscale funnel --bg 8787
   ```

   La primera vez muestra un enlace para activar Funnel: ábrelo, acepta y repite el comando.
4. El comando muestra una dirección `https://….ts.net`. Pégala en falab, en **Banda → Dirección
   para los músicos**, y compártela con la banda.

El estudio debe estar encendido y con falab abierto mientras la banda lo usa.

## 4. Versión web (cualquier dispositivo, sin instalar)

1. Abre la dirección `https://….ts.net` en Safari (iPhone/iPad) o Chrome (Android, PC).
   Si el enlace llega por WhatsApp, ábrelo en el navegador, no dentro de WhatsApp.
2. Entra con tu usuario de la banda.
3. Toca una canción para abrirla.

Si algo falla, al final de la pantalla de inicio está **«¿Algo no funciona? Comprobar este
dispositivo»**: genera un informe que se puede copiar.

## 5. App de iPad y iPhone

Se compila en la **Mac** (hace falta Xcode y un cable). Es la misma app para los dos.
Detalles en [IPAD.md](IPAD.md).

1. En el dispositivo: Ajustes → Privacidad y seguridad → **Modo de desarrollador** → activar.
2. Conéctalo a la Mac y, en la Terminal:

   ```bash
   cd ~/ProjectFalab && ./scripts/preparar_ipad.sh
   ```

3. Abre el proyecto en Xcode:

   ```bash
   cd ~/ProjectFalab/app && npm run tauri ios build -- --open
   ```

4. En Xcode: destino «falab_iOS» → **Signing & Capabilities** → en «Team», tu cuenta de Apple.
   Arriba, elige tu iPad o iPhone y pulsa ▶.
5. La primera vez, en el dispositivo: Ajustes → General → VPN y gestión de dispositivos →
   confiar en tu cuenta.

Con cuenta de Apple gratuita la app caduca a los 7 días: se renueva pulsando ▶ otra vez.

## 6. App de Android (teléfono y tableta)

Se compila en la **Mac**. El mismo APK sirve para teléfonos y tabletas.
Detalles en [ANDROID.md](ANDROID.md).

1. Instala **Android Studio** (<https://developer.android.com/studio>), ábrelo una vez y deja que
   descargue el SDK. Después, en *Settings → Languages & Frameworks → Android SDK → SDK Tools*,
   marca **NDK (Side by side)** y **Android SDK Command-line Tools** y pulsa *Apply*.
2. Genera el APK:

   ```bash
   cd ~/ProjectFalab && ./scripts/preparar_android.sh
   ```

   Para tabletas antiguas de 32 bits: `./scripts/preparar_android.sh --32bits`.
3. Envía el `.apk` que indica el script al dispositivo (cable, correo, Drive…), ábrelo allí y
   acepta «Instalar aplicaciones de orígenes desconocidos».

## 7. Conectar las apps con la banda

En la app (iPad, iPhone, Android), en la pantalla de inicio: escribe la dirección de la banda
(`https://….ts.net`), tu nombre y tu contraseña. Aparece la biblioteca de la banda; con
**Descargar** una canción queda guardada para usarla sin conexión.

Sin banda también funcionan: en el estudio, exporta el proyecto como `.falab`, pásalo al
dispositivo y ábrelo con «Elegir proyectos…».

## 8. Sesión sincronizada

Con todos conectados a la banda:

1. Quien lleva la canción pulsa **Dirigir sesión** (en el teléfono está dentro de «Ajustes»).
2. Los demás pulsan **Seguir** en el aviso que les aparece.
3. Los seguidores son un teleprónter: ven letra, acordes, partitura o tablatura en el mismo punto
   que el director, sin cargar audio. Cualquiera puede tomar el relevo con **Dirigir yo**.

---

## Actualizar

Siempre primero el código, en el estudio:

| Entorno | Qué hacer |
|---|---|
| **Mac** | `cd ~/ProjectFalab && git checkout -- app/src-tauri/Cargo.lock && git pull && cd app && npm install`, y después los pasos 4 y 5 de la sección 1 |
| **Windows** | `git pull` en la carpeta y volver a ejecutar `scripts\instalar_windows.ps1` |
| **Web** | En el estudio Mac: `cd ~/ProjectFalab/app && npm run build`. En Windows lo hace el instalador. Los músicos solo recargan la página |
| **iPad / iPhone** | `./scripts/preparar_ipad.sh` y ▶ en Xcode (se instala encima, conserva las canciones) |
| **Android** | `./scripts/preparar_android.sh` e instalar el APK encima |

## Dónde están los datos y los registros

- Proyectos y configuración: carpeta `Falab` en tu carpeta de usuario (Mac y Windows).
- Si el estudio falla: `Falab/motor.log`.
- En los reproductores: el botón de diagnóstico de la pantalla de inicio.
