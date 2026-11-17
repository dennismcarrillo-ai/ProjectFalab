# falab en Windows

La versión de Windows hace lo mismo que la de Mac: separa pistas, transcribe letra, detecta
acordes, edita, graba, exporta y puede hacer de servidor de la banda. Todo el análisis ocurre en
el propio equipo.

## Requisitos

- Windows 10 u 11 de 64 bits.
- Unos 10 GB libres (modelos de IA incluidos).
- Recomendado: 16 GB de memoria. Con una tarjeta **NVIDIA** el análisis es mucho más rápido; sin
  ella funciona igual, pero una canción puede tardar varias veces su duración.

## Instalación

1. Instala Git si no lo tienes. En PowerShell:

   ```powershell
   winget install --id Git.Git -e
   ```

2. Cierra y vuelve a abrir PowerShell, y descarga falab:

   ```powershell
   cd $env:USERPROFILE
   git clone https://github.com/dennismcarrillo-ai/ProjectFalab.git
   cd ProjectFalab
   ```

3. Ejecuta el instalador:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\instalar_windows.ps1
   ```

   Instala FFmpeg, el motor de audio con los modelos de IA (tarda: son varios GB) y, al final,
   abre el instalador de la aplicación. Después, falab aparece en el menú Inicio.

Si Windows muestra «Windows protegió su PC» al abrir el instalador, pulsa «Más información» y
«Ejecutar de todas formas»: el instalador no está firmado.

## Actualizar

```powershell
cd $env:USERPROFILE\ProjectFalab
git pull
powershell -ExecutionPolicy Bypass -File scripts\instalar_windows.ps1
```

## Diferencias con la Mac

- **Letras**: se usa faster-whisper en lugar de mlx-whisper. La calidad es la misma; en un equipo
  sin tarjeta NVIDIA es más lento.
- **Guías de voz**: se generan con la voz de Windows. Para que hablen en español hace falta tener
  instalada una voz en español (Configuración → Hora e idioma → Voz).
- **Exportar con cambio de tono o velocidad**: sin Rubber Band instalado se usa el método
  alternativo, algo menos fino.
- **Servidor de la banda**: funciona igual, con Tailscale para Windows (`tailscale funnel 8787`).
- **Datos**: los proyectos se guardan en `C:\Users\<tú>\Falab`. Si algo falla, el registro del
  motor está en `Falab\motor.log`.

## Cómo se genera el instalador

Cada cambio en el repositorio lo compila GitHub (`.github/workflows/windows.yml`) y lo publica en
la sección «Releases», con la etiqueta `windows`. El script de instalación lo descarga de ahí, así
que en el equipo no hacen falta ni Rust ni Visual Studio.
