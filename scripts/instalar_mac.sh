#!/usr/bin/env bash
# Instalación de falab en macOS (Apple Silicon o Intel).
# Uso:  ./scripts/instalar_mac.sh            -> todo (motor + modelos de IA + interfaz)
#       ./scripts/instalar_mac.sh --sin-ia   -> sin Demucs/Whisper/BasicPitch (para probar la interfaz)
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
CON_IA=1
[[ "${1:-}" == "--sin-ia" ]] && CON_IA=0

echo "==> 1/5 Herramientas del sistema (Homebrew)"
if ! command -v brew >/dev/null; then
  echo "Falta Homebrew. Instálalo desde https://brew.sh y vuelve a ejecutar este script." >&2
  exit 1
fi
brew install ffmpeg rubberband uv node rustup
command -v cargo >/dev/null || rustup-init -y --no-modify-path
export PATH="$HOME/.cargo/bin:$PATH"
xcode-select -p >/dev/null 2>&1 || { echo "Instala las herramientas de Xcode: xcode-select --install" >&2; exit 1; }

echo "==> 2/5 Motor de audio (Python 3.11 en un entorno aislado)"
cd "$RAIZ/motor"
uv venv --python 3.11 .venv
if [[ $CON_IA -eq 1 ]]; then
  echo "    Instalando también los modelos de IA (varios GB, puede tardar)…"
  uv pip install --python .venv/bin/python -e ".[ia,dev]"
else
  uv pip install --python .venv/bin/python -e ".[dev]"
fi

echo "==> 3/5 Registro de la ruta del motor"
mkdir -p "$HOME/Falab/config"
echo "$RAIZ/motor/.venv/bin/python" > "$HOME/Falab/config/ruta_motor.txt"

echo "==> 4/5 Comprobación del motor"
.venv/bin/python -m pytest -q

echo "==> 5/5 Interfaz"
cd "$RAIZ/app"
npm install

cat <<'FIN'

Instalación terminada.

  Abrir falab en modo desarrollo:   cd app && npm run tauri dev
  Generar la aplicación (.app/.dmg): cd app && npm run tauri build

La primera vez que analices una canción se descargan los pesos de los modelos
(Demucs: decenas de MB; Whisper: ~1,5 GB con la calidad equilibrada). Después todo funciona sin conexión.
FIN
