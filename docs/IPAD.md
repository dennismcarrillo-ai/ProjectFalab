# falab en el iPad

La versión para iPad es un **reproductor**: abre las canciones que ya analizaste con falab en la
Mac y ofrece mezcla, karaoke, cancionero, partitura, tablatura, playlists y show continuo. No
analiza canciones nuevas ni edita clips: el análisis necesita un motor de IA que un iPad no puede
ejecutar, y falab no usa servidores.

## Qué necesitas

- La Mac con falab ya instalado y **Xcode**.
- Un cable para conectar el iPad, y iPadOS 16.4 o posterior.
- Una cuenta de Apple. Con una cuenta gratuita la app instalada caduca a los 7 días y hay que
  volver a instalarla desde Xcode; con una cuenta de desarrollador de pago (99 USD al año) dura
  un año.

## Instalar la app

En la Mac:

```bash
cd ~/ProjectFalab && git pull && ./scripts/preparar_ipad.sh
```

El script instala lo necesario y, al final, te indica los pasos en Xcode (elegir tu cuenta en
«Signing & Capabilities», seleccionar el iPad y pulsar ▶).

## Pasar canciones al iPad

1. En la Mac, en la biblioteca de falab, pulsa **Exportar** en cada proyecto. Se crea un archivo
   `.falab` con todo: el audio de cada pista, los acordes, la letra, las partituras.
2. Envía los `.falab` al iPad (AirDrop, iCloud Drive o cable).
3. En falab, pulsa **Elegir proyectos…** y selecciónalos: falab los copia a su espacio propio.

También puedes guardarlos con la app **Archivos** en **En mi iPad → falab** y pulsar
**Actualizar la lista**; así no se copian y no ocupan el doble mientras conservas el original.

Los proyectos exportados con versiones anteriores de falab no traen los datos que el iPad
necesita: vuelve a exportarlos.

Cada canción ocupa en el iPad lo mismo que su `.falab` (del orden de 150–300 MB con seis pistas).
No se duplica: falab lee el archivo directamente, sin descomprimirlo.

## Qué se puede hacer

| En el iPad | Solo en la Mac |
|---|---|
| Mezcla: volumen, silencio, solo, paneo y reverb por pista | Analizar canciones nuevas |
| Velocidad sin cambiar el tono y tono sin cambiar la velocidad | Editar clips (cortar, pegar, recortar) |
| Metrónomo con el mapa de pulsos y cuenta regresiva | Grabar audio o video |
| Karaoke, cancionero (tres cifrados, transposición), partitura y tablatura | Editar la letra o la estructura |
| Playlists con todos los órdenes y show continuo | Exportar y Google Drive |
| Pedal pasapáginas de tipo teclado (Bluetooth) | Pedal MIDI |

La mezcla que hagas en el iPad se guarda en el iPad; no modifica el archivo `.falab`.

## Cómo funciona por dentro

La interfaz es la misma que en la Mac. Lo que cambia es quién le responde: en la Mac, el motor
Python; en el iPad, un motor local escrito en TypeScript (`app/src/reproductor/`) que:

- lee el `.falab` por tramos, sin extraerlo (es un ZIP sin compresión);
- decodifica el audio FLAC solo en los fragmentos de ~3 s que pide el reproductor, así que la
  memoria no depende de la duración de la canción;
- escribe los nombres de los acordes según el cifrado y el tono elegidos.

Todo lo que en la Mac calcula Python al vuelo (compases, cancionero, partituras) viaja ya resuelto
dentro del `.falab`.

## Estado

El reproductor está probado en un navegador con tamaño de pantalla de iPad, abriendo proyectos
`.falab` reales sin ningún motor en marcha. **La compilación para iOS y la app en un iPad real no
se han probado todavía**: si algo falla al compilar o al abrir, el error de Xcode es lo que hace
falta para corregirlo.

Puedes probar el reproductor sin iPad, en el navegador de la Mac:

```bash
cd ~/ProjectFalab/app && npm run dev
```

y abrir `http://127.0.0.1:1420/?reproductor=1`.
