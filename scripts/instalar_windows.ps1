# Instalación de falab en Windows 10/11 (64 bits).
# Uso (desde la carpeta del repositorio, en PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\instalar_windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\instalar_windows.ps1 -SinIA   # sin Demucs/Whisper/BasicPitch
#
# Instala el motor de audio (Python 3.11 en un entorno aislado, con los modelos de IA), FFmpeg y
# la aplicación ya compilada. Para actualizar, basta con «git pull» y volver a ejecutarlo.
param([switch]$SinIA)

$ErrorActionPreference = "Stop"
$Raiz = Split-Path -Parent $PSScriptRoot
$Publicacion = "https://github.com/dennismcarrillo-ai/ProjectFalab/releases/download/windows"

function Comprobar($mensaje) { if ($LASTEXITCODE -ne 0) { throw $mensaje } }

Write-Host "==> 1/5 Herramientas del sistema"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Falta winget. Instala «Instalador de aplicación» desde Microsoft Store y vuelve a ejecutar este script."
}
foreach ($paquete in @("Gyan.FFmpeg", "astral-sh.uv", "Microsoft.VCRedist.2015+.x64")) {
    winget install --id $paquete -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
}
# Lo recién instalado aún no está en el PATH de esta ventana.
$env:Path = "$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:USERPROFILE\.local\bin;" +
    [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "No se encontró «uv» tras instalarlo. Cierra esta ventana, abre otra de PowerShell y vuelve a ejecutar el script."
}

Write-Host "==> 2/5 Motor de audio (Python 3.11 en un entorno aislado)"
Set-Location "$Raiz\motor"
$Python = "$Raiz\motor\.venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { uv venv --python 3.11 .venv; Comprobar "No se pudo crear el entorno de Python." }
if ($SinIA) {
    uv pip install --python $Python -e ".[dev]"; Comprobar "No se pudo instalar el motor."
} else {
    Write-Host "    Instalando también los modelos de IA (varios GB, puede tardar)..."
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        Write-Host "    Tarjeta NVIDIA detectada: se instala PyTorch con aceleración por GPU."
        uv pip install --python $Python "torch>=2.2,<2.6" "torchaudio>=2.2,<2.6" --index-url https://download.pytorch.org/whl/cu121
        Comprobar "No se pudo instalar PyTorch para GPU."
    }
    uv pip install --python $Python -e ".[ia,dev]"; Comprobar "No se pudo instalar el motor con los modelos de IA."
}

Write-Host "==> 3/5 Registro de la ruta del motor"
$Config = "$env:USERPROFILE\Falab\config"
New-Item -ItemType Directory -Force -Path $Config | Out-Null
[IO.File]::WriteAllText("$Config\ruta_motor.txt", $Python)

Write-Host "==> 4/5 Comprobación del motor"
$env:PYTHONUTF8 = "1"
& $Python -m pytest -q
Comprobar "Las pruebas del motor han fallado."

Write-Host "==> 5/5 Aplicación"
$Temporal = Join-Path $env:TEMP "falab-instalacion"
New-Item -ItemType Directory -Force -Path $Temporal | Out-Null
# Interfaz web ya compilada: la sirve este equipo a la banda cuando se activa «Compartir con la banda».
Invoke-WebRequest "$Publicacion/falab-web.zip" -OutFile "$Temporal\falab-web.zip"
if (Test-Path "$Raiz\app\dist") { Remove-Item -Recurse -Force "$Raiz\app\dist" }
Expand-Archive "$Temporal\falab-web.zip" -DestinationPath "$Raiz\app\dist"
Invoke-WebRequest "$Publicacion/falab-windows-setup.exe" -OutFile "$Temporal\falab-windows-setup.exe"
Write-Host "    Abriendo el instalador de falab..."
Start-Process "$Temporal\falab-windows-setup.exe" -Wait

Write-Host ""
Write-Host "Instalación terminada. Abre «falab» desde el menú Inicio."
Write-Host "La primera vez que analices una canción se descargan los pesos de los modelos"
Write-Host "(Demucs: decenas de MB; Whisper: ~1,5 GB). Después todo funciona sin conexión."
