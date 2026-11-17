#!/usr/bin/env bash
# Prepara la versión de falab para iPad y iPhone (reproductor): es la misma app para los dos. Se ejecuta en la Mac, una sola vez.
# Requisitos: Xcode instalado y haber ejecutado antes scripts/instalar_mac.sh.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v brew >/dev/null && [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> 1/4 Herramientas de iOS"
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Hace falta Xcode completo (no solo las herramientas de línea de comandos)." >&2
  echo "Ábrelo una vez y ejecuta:  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi
command -v pod >/dev/null || brew install cocoapods
rustup target add aarch64-apple-ios aarch64-apple-ios-sim

echo "==> 2/4 Interfaz"
cd "$RAIZ/app"
npm install
npm run build

echo "==> 3/4 Proyecto de Xcode"
if [[ ! -d src-tauri/gen/apple ]]; then
  npm run tauri ios init
fi
# El icono de falab (el proyecto recién creado trae el genérico de Tauri).
ICONOS="$(find src-tauri/gen/apple -type d -name AppIcon.appiconset | head -1)"
[[ -n "$ICONOS" ]] && cp src-tauri/icons/ios/*.png "$ICONOS/"

echo "==> 4/4 Listo"
cat <<'FIN'

Proyecto preparado. Para instalar falab en tu iPad o iPhone:

  1. Conecta el iPad o el iPhone a la Mac con el cable y desbloquéalo.
  2. En el dispositivo: Ajustes → Privacidad y seguridad → Modo de desarrollador → activar (pide reiniciar).
  3. Abre el proyecto en Xcode:

       cd app && npm run tauri ios build -- --open

     (si ese comando no abre Xcode:  open src-tauri/gen/apple/*.xcodeproj)
  4. En Xcode: elige el destino «falab_iOS» → pestaña «Signing & Capabilities» → en «Team»,
     tu cuenta de Apple. Arriba, elige tu iPad o iPhone como dispositivo y pulsa ▶.
  5. La primera vez, en el dispositivo: Ajustes → General → VPN y gestión de dispositivos → confiar
     en tu cuenta de desarrollador.

Guía completa: docs/IPAD.md
FIN
