#!/usr/bin/env bash
# Compila falab para Android (teléfonos y tabletas) y genera un APK instalable. Se ejecuta en la Mac.
# Uso:  ./scripts/preparar_android.sh            -> dispositivos de 64 bits (lo habitual)
#       ./scripts/preparar_android.sh --32bits  -> además, tabletas antiguas de 32 bits
# Requisitos: Android Studio instalado (con el SDK, el NDK y las «Command-line Tools») y haber
# ejecutado antes scripts/instalar_mac.sh.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v brew >/dev/null && [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> 1/4 Herramientas de Android"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [[ ! -d "$ANDROID_HOME" ]]; then
  echo "No se encuentra el SDK de Android en $ANDROID_HOME." >&2
  echo "Instala Android Studio (https://developer.android.com/studio), ábrelo una vez y deja que descargue el SDK." >&2
  exit 1
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidato in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" "/Applications/Android Studio.app/Contents/jre/Contents/Home"; do
    [[ -d "$candidato" ]] && export JAVA_HOME="$candidato" && break
  done
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "No se encuentra Java. Con Android Studio instalado debería estar en su carpeta; si no, instala un JDK 17." >&2
  exit 1
fi
if [[ -z "${NDK_HOME:-}" ]]; then
  ULTIMO_NDK="$(ls -d "$ANDROID_HOME"/ndk/*/ 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -z "$ULTIMO_NDK" ]]; then
    echo "Falta el NDK de Android. En Android Studio: Settings → Languages & Frameworks → Android SDK →" >&2
    echo "pestaña «SDK Tools» → marca «NDK (Side by side)» y «Android SDK Command-line Tools» → Apply." >&2
    exit 1
  fi
  export NDK_HOME="${ULTIMO_NDK%/}"
fi
echo "    SDK:  $ANDROID_HOME"
echo "    NDK:  $NDK_HOME"
echo "    Java: $JAVA_HOME"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

echo "==> 2/4 Interfaz"
cd "$RAIZ/app"
npm install
npm run build

echo "==> 3/4 Proyecto de Android"
if [[ ! -d src-tauri/gen/android ]]; then
  npm run tauri android init
fi
# El icono de falab (el proyecto recién creado trae el genérico de Tauri).
cp -R src-tauri/icons/android/. src-tauri/gen/android/app/src/main/res/

echo "==> 4/4 Compilando el APK (la primera vez tarda bastante)"
# Versión de depuración: va firmada con una clave de pruebas y se puede instalar directamente.
# Casi todos los teléfonos y tabletas son de 64 bits (aarch64). Con --32bits se añade la variante
# para tabletas antiguas o muy económicas, y sale un único APK que sirve para las dos.
DESTINOS=(--target aarch64)
[[ "${1:-}" == "--32bits" ]] && DESTINOS=(--target aarch64 --target armv7)
npm run tauri android build -- --debug --apk "${DESTINOS[@]}"

APK="$(find src-tauri/gen/android -name '*.apk' -newer package.json 2>/dev/null | head -1)"
cat <<FIN

APK generado:
  $RAIZ/app/${APK:-src-tauri/gen/android/app/build/outputs/apk/}

Para instalarlo:
  · Con cable: activa en el teléfono «Depuración por USB» (Ajustes → Opciones de desarrollador) y ejecuta
        "$ANDROID_HOME/platform-tools/adb" install -r "$RAIZ/app/$APK"
  · Sin cable: envía el archivo .apk al teléfono (correo, Drive…), ábrelo allí y acepta
    «Instalar aplicaciones de orígenes desconocidos».

Guía completa: docs/ANDROID.md
FIN
