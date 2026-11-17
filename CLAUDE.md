# falab — normas del proyecto

## Restricciones permanentes

- Todo el procesamiento de IA es **local**: nada de servicios de pago ni de nube para analizar.
- Interfaz, menús, identificadores, comentarios y documentación en **español**.

## Cada cambio se piensa para todos los entornos

El dueño del proyecto lo pidió expresamente (noviembre de 2026): ningún cambio se da por
terminado pensando solo en la Mac. Antes de cerrar un cambio, repasar:

| Entorno | Qué es | Qué comprobar |
|---|---|---|
| Mac (Tauri + motor Python) | Estudio | Funciona con `motor/` y `app/src-tauri` |
| Windows (Tauri + motor Python) | Estudio | Rutas con `\`, UTF-8, sin órdenes exclusivas de macOS; la compilación de GitHub (`.github/workflows/windows.yml`) pasa |
| Web de la banda (navegador) | Reproductor | Funciona sin Tauri, en Safari de iPhone y Chrome de Android |
| iPad / iPhone (Tauri iOS) | Reproductor | Sin motor Python: lo atiende `app/src/reproductor/motorLocal.ts`; CSP de `tauri.conf.json` |
| Android teléfono / tableta (Tauri Android) | Reproductor | Igual que iOS; rendimiento en equipos lentos |

Reglas prácticas:

- Una función nueva del estudio que deba verse en los reproductores necesita su parte en
  `motorLocal.ts` y, si usa datos precalculados, en `paquete.datos_para_reproductor`.
- La interfaz se revisa en cuatro tamaños: teléfono vertical, teléfono tumbado, tableta vertical
  y escritorio.
- Si un cambio no aplica a un entorno, o no se pudo probar en él, se dice explícitamente.
- Al cambiar pasos de instalación, actualizar `docs/INSTALACION.md` y la guía del entorno.
- Los reproductores llevan la interfaz empaquetada: avisar de cuáles hay que recompilar.

## Pruebas

- Motor: `cd motor && .venv/bin/python -m pytest -q`
- Interfaz: `cd app && npx vitest run && npm run build`
