# Pruebas de uso real — 15 de octubre de 2026

La integración `8a06ba4` se probó desde la aplicación Windows instalada y desde
ThingMaker Remote en un emulador Android, según lo solicitado. Se utilizaron
Codex y Claude reales a través del acceso remoto habitual. Los dos fallos
encontrados durante el uso se corrigieron, se añadieron pruebas de regresión y
se instalaron de nuevo ambos clientes con las correcciones.

## Entorno y conservación de datos

- Windows: `%LOCALAPPDATA%\ThingMaker\thingmaker-desktop.exe`, instalador NSIS x64.
- Android: AVD `Mi12TPro35`, Android 15/API 35, x86_64, pantalla 1220 × 2712,
  WebView 124; paquete `dev.thingmaker.remote`, versión 2.0.3/code 5.
- Conexión real: `https://thingmaker.jacksparrot.com`, transporte `/v2/ws`.
- Proyecto de prueba: `D:\repos\ThingMaker-Remote-Demo`. Las pruebas de escritura
  se limitaron a esta carpeta.
- El perfil habitual tenía 44 conversaciones y un proyecto. La comparación de
  sus identificadores tras instalar conserva todos; quedan 46 conversaciones y
  dos proyectos al añadir las pruebas. La copia previa está en
  `target/runtime-validation-20261015/user-profile-before.db` y el ejecutable
  anterior en `user-profile-before.exe`.
- Se comprobó la ruta del proceso real para evitar la redirección de AppData de
  MSIX. El binario instalado coincide byte a byte con la compilación al normalizar
  únicamente el marcador NSIS de tres bytes que modifica el empaquetador.

## Casos ejecutados

| Flujo | Resultado observado |
| --- | --- |
| Codex desde Windows | Creó `runtime-desktop-20261015.txt` con `DESKTOP_REAL_OK`, lo leyó y terminó correctamente. Se abrió el detalle de herramientas y el diff. |
| Claude desde Windows | Respondió a la prueba `CLAUDE_REAL_OK` usando el proveedor real. |
| Continuar Codex desde Android | Se escribió con el teclado del emulador y se envió desde la app. Leyó el archivo creado en Windows y generó `runtime-mobile-20261015.txt` con `MOBILE_REAL_OK : DESKTOP_REAL_OK`. La respuesta apareció también en Windows. |
| Teclado y pantalla móvil | El compositor y el botón de envío quedaron dentro del área visible al abrir el teclado; sin desbordamiento horizontal. |
| Pérdida de conexión | Se activó el modo avión: la app mostró la reconexión y mantuvo el historial. Al restaurar la red volvió a conectar y completó un nuevo turno `RECONNECTION_OK`, sin duplicar los envíos anteriores. |
| Imágenes de herramientas | Se solicitó abrir un PNG con `view_image`. Una imagen de 512 × 512 se mostró en ambos clientes, ajustada al ancho móvil, sin duplicados ni base64 visible. Este caso usó la ruta de imagen observada; no cubre todos los formatos posibles de salida de herramientas. |
| Reinicio y actualización del PC | Android volvió a conectar automáticamente. Se reanudaron las conversaciones de prueba y se recuperaron mensajes e imagen. |
| Historial previo de Claude | Se abrió una conversación anterior del proyecto habitual y se recuperaron sus mensajes y actividad, sin enviar un nuevo turno a ese proyecto. |
| Claude desde Android | Se reanudó la conversación de prueba y respondió a `CLAUDE_MOBILE_OK`. La respuesta y el historial se recuperaron también después de actualizar Windows. |
| Cerrar en Windows, observar Android | Android retiró la sesión abierta, volvió al proyecto y conservó la opción Resume sin un aviso de fallo obsoleto. |
| Reabrir/cerrar en Android, observar Windows | Windows incorporó la sesión reabierta, mostró su historial y retiró la sesión cuando Android la cerró. El registro siguió disponible para reanudar. |

## Correcciones encontradas durante el uso

1. **Exceso de peticiones al iniciar o reconectar Android.** La carga simultánea
   de paneles podía recibir `IO Too many simultaneous requests`. El puente
   mantiene hasta ocho peticiones en curso y encola las demás por debajo del
   límite del servidor. Una desconexión rechaza las pendientes sin reenviar
   automáticamente operaciones cuyo resultado se desconoce.
2. **Aviso de fallo después de cerrar una sesión desde otro cliente.** La
   reconciliación añadía sesiones, pero no retiraba las que el servidor ya había
   cerrado. Ahora actualiza la vista y los avisos conservando registros y
   borradores. También conserva las sesiones abiertas o reemplazadas durante
   una consulta en curso y mantiene el estado si la consulta falla.

Las regresiones cubren 40 peticiones de arranque, desconexión sin repetición
de operaciones, cierre entre clientes, una apertura concurrente y fallo de red.
La suite final pasó **352 pruebas de interfaz en 48 archivos**. La comprobación
de tipos, Vite de escritorio/relay, APK Android y NSIS Windows terminaron
correctamente. Las pruebas nativas de la integración anterior se detallan en el
[informe de integración](upstream-integration-2026-10-15.md).

## Artefactos y evidencias locales

El directorio `target/runtime-validation-20261015/` contiene capturas, logs de
compilación y pruebas, recibos de instalación, copias de recuperación y el
manifiesto `verification.json`. Es material local ignorado por Git.

| Artefacto final | SHA-256 |
| --- | --- |
| Windows instalado | `55f187984d677608651d9a15bde80b4e21b5feaac72eb6b7b3f93bfb7d544951` |
| `target/release/bundle/nsis/ThingMaker_0.0.0_x64-setup.exe` | `caae3a9974f5c69bdb79387976061fef4d2eecdaef033bf6929ceb5d90027d39` |
| `apps/android/app/build/outputs/apk/debug/app-debug.apk` | `1fb7c89a40adb8372c9e054a64a04a784db440223a52753ef06d00952d69c1b4` |

Capturas: `windows-mobile-synced.png`, `windows-image.png`,
`windows-close-synced.png`, `android-keyboard.png`, `android-offline.png`,
`android-reconnected.png`, `android-image.png` y `android-close-synced.png`.
La última instalación conserva el historial y la imagen en estas capturas:
[Windows](../target/runtime-validation-20261015/windows-final-history.png) y
[Android](../target/runtime-validation-20261015/android-final-history.png).

Esta fase de pruebas no incluyó publicación en JackApps ni envío a GitHub.
El APK local conserva la versión y firma existentes para actualizar el emulador.
Gemini no estaba instalado. El nuevo cliente `apps/phone` y su emparejamiento por
relay solo tienen la validación de compilación de la integración; no forman
parte de estas pruebas de uso. Se utilizó el emulador, sin afirmar validación en
un teléfono físico ni cobertura de todas las funciones de la aplicación.
