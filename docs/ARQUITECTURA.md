# Arquitectura de falab

falab es una aplicación de escritorio híbrida con tres procesos, cada uno haciendo lo que mejor
sabe hacer:

```
┌──────────────────────────── falab.app ─────────────────────────────┐
│                                                                    │
│  Interfaz (WebView del sistema)            Carcasa (Rust · Tauri 2) │
│  React + TypeScript                        ─ lanza y cierra el motor│
│  ├─ Línea de tiempo, mezclador, vistas     ─ puente `peticion_motor`│
│  ├─ Hilo de audio (AudioWorklet)           ─ diálogos nativos       │
│  │   transporte · montaje de clips ·                │               │
│  │   time-stretch/pitch (SoundTouch) ·              │ HTTP en       │
│  │   metrónomo                                      │ 127.0.0.1     │
│  └─ Nodos Web Audio: EQ ×3 → fader → paneo          ▼ + testigo     │
│                                            Motor (Python 3.11)      │
│                                            FastAPI · un trabajo     │
│                                            pesado a la vez          │
│                                            ├─ Pipeline de IA        │
│                                            ├─ Audio por fragmentos  │
│                                            ├─ Exportación (render)  │
│                                            └─ Google Drive          │
└────────────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
  ~/Falab/proyectos/<id>/             Google Drive: falab_projects/
```

## Dos capas

- **Capa 1 · Gestión** (`Biblioteca.tsx`, `biblioteca.py`, `paquete.py`, `drive.py`): proyectos,
  playlists, importación/exportación y sincronización. Las playlists son listas de identificadores
  en `~/Falab/config/biblioteca.json`; no duplican audio.
- **Capa 2 · Editor y directo** (`Editor.tsx`, `vistas/`, `audio/`): mezcla, edición, karaoke,
  cancionero y partitura.

Drive es siempre una **copia**: los proyectos viven y se reproducen desde el disco local. Con el
guardado automático, cada cambio entra en una cola persistente que un hilo en segundo plano sube
cuando hay conexión. Una caída de internet no puede cortar la música.

## Decisiones tecnológicas

| Decisión | Por qué |
|---|---|
| **Tauri 2** en lugar de Electron | Usa el WebView del sistema: instalador de ~10 MB y 100–200 MB menos de RAM, que quedan libres para los modelos de IA. |
| **Motor en Python** como proceso aparte | Demucs, Whisper, BasicPitch y librosa son Python. Al ser otro proceso, un análisis pesado nunca congela la interfaz, y al terminar el sistema recupera toda su memoria. |
| **HTTP local + testigo de sesión** | Simple de depurar. La carcasa genera un testigo aleatorio por sesión y hace de puente, así ninguna página web ni otro programa puede dar órdenes al motor. |
| **AudioWorklet propio** en lugar de Tone.js | Tone.js reproduce `AudioBuffer` completos en memoria. El procesador propio lee el audio por fragmentos y hace el montaje de clips con precisión de muestra. |
| **SoundTouch (WSOLA)** en tiempo real, **Rubber Band** al exportar | SoundTouch es ligero y suficiente para escuchar; Rubber Band da calidad de estudio en el archivo final. |
| **MLX Whisper** en Apple Silicon | Usa la GPU del M1; en otros equipos se usa faster-whisper. |
| **Anti-bleed por DSP** | No existe un modelo neuronal abierto para separar bajo de bombo. Se usan máscaras espectrales suaves que conservan la suma de ambos stems. |

## Pipeline local de IA

`motor/falab_motor/pipeline/orquestador.py`

```
archivo (MP3, WAV, FLAC, OGG, AAC, MP4, MOV, MKV)
   │ FFmpeg → mezcla.flac (44,1 kHz, estéreo, 24 bits)
   ▼
1. Demucs v4 (htdemucs_6s)      → voz, bajo, batería, guitarra, piano, otros   separacion.py
2. Anti-bleed bajo/bombo        → reparte graves entre bajo y batería          anti_bleed.py
3. librosa: mapa de pulsos      → instante y BPM local de cada pulso           mapa_tempo.py
4. BasicPitch: audio → MIDI     → notas por stem                               notas.py
   Cifrado de acordes           → estándar, jazz o latino; inversiones         acordes.py
5. Whisper sobre el stem de voz → letra con tiempos por palabra                letras.py
```

Cada etapa escribe su resultado en disco. Si una etapa opcional falla o su modelo no está
instalado, se anota un aviso y el proyecto sigue siendo utilizable.

## Cómo se mantiene baja la RAM

El objetivo es que funcione con holgura en un equipo de 8 GB.

**En el análisis**

1. **Un solo modelo en memoria a la vez.** Las etapas van en serie; cada modelo se carga, se usa
   y se libera (`del`, `gc.collect()`, vaciado de la caché de GPU). La cola de trabajos solo
   ejecuta un trabajo pesado simultáneamente.
2. **Demucs por bloques a disco.** La canción se separa en bloques de 40 s (con 2 s de solape y
   fundido cruzado) que se escriben al FLAC según salen. El pico de memoria es el mismo para una
   canción de 2 minutos que para una de 20.
3. **Anti-bleed sobre audio diezmado.** Solo interesan los graves, así que se trabaja a 2,7 kHz
   (16× menos datos) y solo la *diferencia* se devuelve a 44,1 kHz.
4. **Análisis rítmico y armónico a 22 kHz mono.**

**En la edición y la reproducción**

5. **Edición no destructiva.** Un clip es una referencia `{fuente, desplazamiento, duración}`.
   Copiar, pegar, cortar y recortar crean o modifican referencias de unos bytes; no se copia ni
   una muestra. El historial de deshacer guarda instantáneas de esas referencias.
6. **Audio por fragmentos.** El reproductor nunca decodifica un stem entero. Pide al motor
   fragmentos de ~3 s en PCM de 16 bits y mantiene solo una ventana alrededor del cursor
   (3 s por detrás, 18 s por delante); lo que queda lejos se libera.

   | | Seis stems de 5 minutos |
   |---|---|
   | Decodificados a `AudioBuffer` (float32) | ~635 MB |
   | Con fragmentos de falab | ~40 MB, sea cual sea la duración |

7. **Ondas a partir de picos precalculados.** El motor guarda un par mín/máx cada 256 muestras
   (~100 KB por stem). Las ondas se dibujan en un lienzo del tamaño de la ventana visible, no del
   proyecto.
8. **Velocidad y tono como parámetros.** El time-stretch y el pitch-shift se aplican en el
   momento de reproducir; no se generan copias procesadas del audio.
9. **Exportación en el motor.** La mezcla final se renderiza en Python pista a pista, leyendo de
   disco solo los tramos usados. El EQ usa los mismos coeficientes bicuadráticos que Web Audio y
   el paneo la misma ley, así que el archivo suena como lo que se oye en la app.
10. **Bibliotecas pesadas bajo demanda.** El grabador de partituras (1,2 MB) solo se carga al
    abrir la vista Partitura.

## Formato de proyecto

```
~/Falab/proyectos/<id>/
├── proyecto.json        mezcla y edición (pistas, clips, EQ, velocidad, tono, metrónomo)
├── audio/mezcla.flac    audio original normalizado
├── stems/*.flac         un archivo por instrumento
├── analisis/            mapa_tempo.json · acordes.json · letras.json · notas.json · *.mid
├── picos/*.bin          picos de onda (regenerables)
└── exportaciones/
```

El modelo de datos está descrito en `app/src/tipos.ts` y `motor/falab_motor/proyecto.py`.

## Mapa del código

| Ruta | Contenido |
|---|---|
| `motor/falab_motor/pipeline/` | Las cinco etapas de IA y su orquestador |
| `motor/falab_motor/exportacion/` | Render de mezcla, audio/video, cancionero, partitura, tablatura |
| `motor/falab_motor/servidor.py` | API HTTP local |
| `motor/falab_motor/drive.py` | Sincronización con Google Drive |
| `app/src/audio/procesador.worklet.ts` | Reproductor en el hilo de audio |
| `app/src/audio/MotorAudio.ts` | Grafo del mezclador y carga de fragmentos |
| `app/src/edicion/operaciones.ts` | Cortar, copiar, pegar, recortar (funciones puras) |
| `app/src/componentes/Editor.tsx` | Línea de tiempo y cabeceras de mezcla |
| `app/src/vistas/` | Karaoke, Cancionero, Partitura |
| `app/src-tauri/src/lib.rs` | Carcasa de escritorio |
