#!/usr/bin/env bash
# Prepara la versión de falab para iPad (reproductor). Se ejecuta en la Mac, una sola vez.
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

echo "==> 4/4 Listo"
cat <<'FIN'

Proyecto de iPad preparado. Para instalar falab en tu iPad:

  1. Conecta el iPad a la Mac con el cable y desbloquéalo.
  2. En el iPad: Ajustes → Privacidad y seguridad → Modo de desarrollador → activar (pide reiniciar).
  3. Abre el proyecto en Xcode:

       cd app && npm run tauri ios build -- --open

     (si ese comando no abre Xcode:  open src-tauri/gen/apple/*.xcodeproj)
  4. En Xcode: elige el destino «falab_iOS» → pestaña «Signing & Capabilities» → en «Team»,
     tu cuenta de Apple. Arriba, elige tu iPad como dispositivo y pulsa ▶.
  5. La primera vez, en el iPad: Ajustes → General → VPN y gestión de dispositivos → confiar
     en tu cuenta de desarrollador.

Guía completa: docs/IPAD.md
FIN
