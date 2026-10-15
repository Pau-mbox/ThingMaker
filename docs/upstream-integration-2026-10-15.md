# Integración de origin/main — 15 de octubre de 2026

Base local: `4778709`. Remoto incorporado: `706a473` (17 commits).
Los seis commits locales previos se conservan. Los siete archivos modificados
y tres nuevos se guardaron primero en `bb9b0dc`, antes de resolver la integración.

## Compatibilidad conservada

- ThingMaker Remote sigue en `apps/android`, con paquete `dev.thingmaker.remote`,
  versión 2.0.3/code 5, configuración nativa y protocolo `/v2/ws` originales.
- El nuevo cliente `dev.thingmaker.phone` está en `apps/phone`; su relay,
  emparejamiento y aplicación se conservan por separado. `scripts/phone.sh`
  apunta al nuevo directorio.
- El servidor original se llama ahora `remote_legacy.rs` para convivir con el
  módulo `remote/` del remoto. El dispatcher original incorpora los nuevos
  comandos de cola, actividad y energía, y el evento de títulos persistentes.
- El renderer distingue el puente Android `postMessage` del puente emparejado
  `token/socket`. Las pruebas cubren la selección del protocolo, reconexión,
  imágenes y conservación de títulos.
- La recuperación de transcripciones de Windows se ejecuta antes del nuevo
  rellenado de títulos. Los registros archivados y realmente ausentes se conservan.
- Se mantienen las rutas Windows, ConPTY, credenciales, instalador NSIS y
  controles móviles. Se añaden las vistas Chill, documentos, cola y títulos del remoto.

## Fallos encontrados y corregidos durante la validación

- Una herramienta podía empezar antes de procesar la confirmación del envío;
  el código borraba entonces su estado y cancelaba el turno por inactividad.
  El estado se limpia antes de enviar el mensaje.
- Una respuesta inmediata podía adelantarse a la confirmación de escritura.
  Ahora ambos eventos se entregan en orden, incluso ante un rechazo inmediato.
- Las comprobaciones de versión normalizan separadores y usan el lanzador
  Windows existente. PATH usa el separador del sistema y las pruebas de procesos
  y Python funcionan en Windows.
- La nueva función de mantener despierto el equipo usa solicitudes de energía
  de Windows y libera el recurso al terminar. Se probó la creación/liberación
  del recurso real y la decisión según actividad y batería.
- Se declaran explícitamente los scripts nativos de `esbuild` y `workerd`
  requeridos por Wrangler, para instalar con pnpm 10 y pnpm 11+.

La adaptación de energía sigue [PowerCreateRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powercreaterequest)
y [PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

## Validación

- Antes de integrar: 275 pruebas de interfaz aprobadas.
- Después: 347 pruebas de interfaz y 2 de contratos aprobadas; comprobación de
  tipos aprobada para escritorio, contratos y relay.
- Suite Rust completa: 359 resultados correctos, 0 fallos y 2 ignorados.
  De esos 359, 15 son pruebas reales opcionales que retornan sin ejecutarse
  cuando sus variables de activación no están configuradas; 344 ejecutaron
  las comprobaciones locales y con proveedores simulados.
- Compilaciones Vite de escritorio y relay aprobadas.
- Ambos APK de depuración compilan: Remote 2.0.3/code 5 y Phone 0.1.0/code 1.
- La identidad y el certificado de firma de Remote coinciden con el APK anterior.
- Clippy de todo el workspace, incluidos los tests, aprobado con advertencias
  tratadas como errores. Instalador Windows NSIS x64 generado correctamente.
  Los resultados están en `merged-clippy.log` y `merged-windows-build.log`.

Evidencias locales: `target/integration-backup-20261015/`. La copia previa de
los diez archivos incluye un manifiesto SHA-256 y el diff original; la rama
`backup/before-upstream-20261015` conserva el HEAD previo.

Esta validación cubre código, pruebas y compilaciones. No instala la aplicación
en uso, no publica APKs ni consume cuotas de proveedores reales. No se ha hecho
una prueba de uso en móvil físico ni un emparejamiento real con el nuevo relay.
