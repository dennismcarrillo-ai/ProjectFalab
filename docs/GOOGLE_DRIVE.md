# Conectar falab con Google Drive

falab sincroniza los proyectos con la carpeta **`falab_projects`** de tu Google Drive mediante
OAuth 2.0. Google exige que cada aplicación use su propio «cliente OAuth», así que hay que crearlo
una vez (es gratis y lleva unos cinco minutos).

## 1. Crear el cliente OAuth

1. Entra en <https://console.cloud.google.com/> y crea un proyecto (por ejemplo, «falab»).
2. **APIs y servicios → Biblioteca** → busca **Google Drive API** → **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: **Externo**.
   - Rellena el nombre de la aplicación y tu correo.
   - En **Usuarios de prueba**, añade tu propia cuenta de Google.
4. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **App de escritorio**.
   - Pulsa **Descargar JSON**.

## 2. Guardar el archivo

Renombra el archivo descargado a `credenciales_drive.json` y guárdalo en:

```
~/Falab/config/credenciales_drive.json
```

## 3. Conectar

En falab, pulsa **Drive → Conectar con Google Drive**. Se abrirá el navegador para que autorices
el acceso; al terminar, vuelve a falab.

## Qué se sincroniza

- Cada proyecto es una subcarpeta `Nombre [id]` dentro de `falab_projects`.
- Se suben `proyecto.json` (mezcla y edición), los stems en FLAC y los análisis (acordes, letras,
  notas, mapa de tempo). Las exportaciones y los picos de onda no se suben (se regeneran).
- La sincronización es incremental: se compara el MD5 de cada archivo y solo viaja lo que cambió.
  Tras editar, normalmente solo se sube `proyecto.json` (unos pocos KB).

## Privacidad

- falab pide el permiso mínimo `drive.file`: **solo puede ver y modificar los archivos que él mismo
  creó**, nunca el resto de tu Drive.
- El token se guarda en `~/Falab/config/token_drive.json` con permisos solo para tu usuario.
  «Desconectar la cuenta» lo borra.
- El análisis de audio (IA) nunca usa la red: Drive solo se usa para guardar tus proyectos.

## Limitación conocida

Mientras la pantalla de consentimiento esté en modo «Prueba», Google caduca la autorización a los
7 días y habrá que volver a pulsar «Conectar». Para evitarlo, publica la app en la pantalla de
consentimiento (con el alcance `drive.file` no requiere verificación de Google).
