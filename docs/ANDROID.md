# falab en Android

Como en el iPad, la versión para Android es un **reproductor**: abre las canciones que ya
analizaste con falab en la Mac y ofrece mezcla, karaoke, cancionero, partitura, tablatura,
playlists y show continuo. No analiza canciones ni edita; eso se hace en la Mac. La interfaz se
adapta a tabletas y a teléfonos.

## Qué necesitas

- La Mac con falab ya instalado.
- **Android Studio** (gratuito): <https://developer.android.com/studio>. Ábrelo una vez y deja
  que descargue el SDK. Después, en *Settings → Languages & Frameworks → Android SDK → SDK Tools*,
  marca **NDK (Side by side)** y **Android SDK Command-line Tools** y pulsa *Apply*.
- Un dispositivo con Android 7 o posterior. No hace falta cuenta de pago ni tienda de apps.

## Compilar e instalar

En la Mac:

```bash
cd ~/ProjectFalab && git pull && ./scripts/preparar_android.sh
```

El script comprueba las herramientas, compila y deja un archivo `.apk`. Al final te indica dónde
está y cómo instalarlo: con cable (`adb`) o enviándolo al teléfono y abriéndolo allí. La primera
compilación tarda varios minutos.

## Pasar canciones

1. En la Mac, en la biblioteca de falab, pulsa **Exportar** en cada proyecto: se crea un archivo
   `.falab`.
2. Pasa los `.falab` al dispositivo (cable, Google Drive, Quick Share…).
3. En falab, pulsa **Elegir proyectos…** y selecciónalos. falab los copia a su espacio propio y
   quedan disponibles sin conexión; después puedes borrar los originales de Descargas.

Cada canción ocupa lo mismo que su `.falab`. Para quitar una, usa «Eliminar» en la lista.

## Diferencias con el iPad

- En Android no hay carpeta compartida con la app Archivos: las canciones se añaden siempre con
  «Elegir proyectos…».
- La app usa el componente web del sistema (Android System WebView). Si algo falla de forma rara,
  actualiza «Android System WebView» y «Chrome» desde Play Store.

## Estado

El reproductor está probado en un navegador con tamaño y perfil de teléfono Android, abriendo
proyectos `.falab` reales sin ningún motor en marcha, y la copia de archivos al dispositivo tiene
pruebas automáticas. **La compilación para Android y la app en un dispositivo real no se han
probado todavía.** En particular, quedan por confirmar en un dispositivo:

- que el selector de archivos entrega bien archivos de cientos de MB;
- que el audio sigue sonando con la pantalla apagada (en Android depende del fabricante);
- que la pantalla se mantiene encendida mientras suena.

Si la compilación o la app fallan, el texto del error es lo que hace falta para corregirlo.

## Tabletas Android

El mismo APK sirve para teléfonos y tabletas: se instala igual. En una tableta la interfaz usa el
diseño amplio (como en el iPad): mezclador con todas las pistas a la vista en horizontal, y en
vertical la cabecera se reparte en dos filas y la biblioteca en una sola columna.

Si al instalar el APK la tableta dice «La aplicación no es compatible» o «No se ha instalado la
aplicación», probablemente es de 32 bits (modelos antiguos o muy económicos). Genera el APK con
las dos variantes:

```bash
./scripts/preparar_android.sh --32bits
```
