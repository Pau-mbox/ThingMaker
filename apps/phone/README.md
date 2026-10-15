# ThingMaker Phone

Cliente Android del remoto, con identidad `dev.thingmaker.phone`. Se conserva
en un proyecto independiente de `../android`, que contiene ThingMaker Remote
(`dev.thingmaker.remote`) y su interfaz empaquetada. Cada aplicación mantiene
su configuración y su protocolo de conexión.

Este cliente se empareja desde **Settings → Phone** y carga la interfaz
`dist-remote` servida por el escritorio a través del relay.

En macOS, `pnpm phone` compila este proyecto y, si hay un dispositivo conectado,
ofrece el flujo de instalación definido en `scripts/phone.sh`.

En Windows, con Java 17 y el SDK de Android configurados:

```powershell
Set-Location apps/phone
.\gradlew.bat assembleDebug
```

El resultado queda en `app/build/outputs/apk/debug/app-debug.apk`.
