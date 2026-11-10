# 🛡️ BETHA SENTINEL v3 — Vigilancia IA 24/7

Sistema de videovigilancia que corre en tu propio PC. La **IA analiza las cámaras en el servidor**, así que sigue vigilando aunque cierres el navegador. Graba clips con los segundos **anteriores** a la detección, avisa por **Telegram** y se controla desde el móvil, también fuera de casa.

## Qué hace

| | |
|---|---|
| 🧠 **IA en el servidor** | YOLOX-Nano/Tiny (ONNX Runtime, CPU). Detecta personas, vehículos y animales. Pide 2 frames seguidos para confirmar, lo que reduce las falsas alarmas. |
| 📹 **Multi-cámara** | Webcam USB/integrada (DirectShow) y cámaras Wi-Fi/IP por RTSP (Tapo, Reolink, Ezviz…). Hasta 8. |
| 🎬 **Clips con pre-evento** | Búfer continuo de segmentos: cada clip MP4 incluye los N segundos de antes y se alarga mientras dura la detección. |
| 🛡️ **Modos y horarios** | Armado (graba y alerta) · En casa (graba sin alertas) · Desarmado. Horarios semanales automáticos. |
| 🤖 **Bot de Telegram** | Alertas con foto y después el clip. Botones "Desarmar 1 h" / "Ver clip". Comandos `/estado` `/foto` `/armar` `/encasa` `/desarmar` `/clip`. |
| 🎯 **Zona ROI por cámara** | Se dibuja arrastrando sobre el vídeo; se ignora lo que queda fuera. |
| 💾 **SQLite + retención** | Purga por días y por espacio máximo en disco. Los eventos protegidos con ⭐ nunca se borran. |
| 🔒 **Seguro por defecto** | Login con contraseña (scrypt), sesiones HttpOnly, anti-CSRF, cabeceras CSP. Solo escucha en este PC salvo que tú lo cambies. |

## Requisitos

- **Windows 10/11** (las webcams usan DirectShow; con RTSP también funciona en Linux/macOS)
- **Node.js 20 o superior**
- FFmpeg **no hace falta instalarlo**: viene incluido (`ffmpeg-static`). Si tienes uno en el PATH, se usa ese.

## Instalación

```bash
cd Sistema-vigilancia-betha
npm install          # instala dependencias y descarga el modelo YOLOX-Nano (3,5 MB)
npm start
```

1. Abre **http://localhost:3000** en ese mismo PC y crea la contraseña de administrador.
2. **Ajustes → Cámaras → Añadir cámara**: elige la webcam o pega la URL RTSP y pulsa *Probar*.
3. Listo: la vigilancia funciona aunque cierres el navegador.

> Si `npm install` no pudo descargar el modelo (sin internet), ejecuta `npm run model:download` más tarde.

### URLs RTSP habituales

| Marca | URL |
|---|---|
| TP-Link Tapo | `rtsp://usuario:clave@IP:554/stream1` (activa "Cuenta de cámara" en la app Tapo) |
| Reolink | `rtsp://admin:clave@IP:554/h264Preview_01_main` |
| Ezviz / Hikvision | `rtsp://admin:CÓDIGO@IP:554/H.264` |

## Telegram

1. En Telegram, habla con **@BotFather** → `/newbot` → copia el token.
2. Habla con **@userinfobot** para saber tu Chat ID.
3. Abre tu bot y pulsa **Iniciar**.
4. En el panel: **Ajustes → Alertas**. Pega el token y el Chat ID, pulsa *Probar envío* y luego *Guardar*.

El bot funciona por *long polling*: **no hace falta abrir puertos**. Solo obedece al Chat ID configurado.

## Acceso desde fuera de casa (seguro)

**No abras puertos en el router.** Usa una de estas opciones:

**Tailscale (recomendado, gratis)**
1. Instala Tailscale en el PC y en el móvil, con la misma cuenta.
2. En `.env` pon `HOST=0.0.0.0` y reinicia.
3. Desde el móvil abre `http://<IP-Tailscale-del-PC>:3000`. Solo tus dispositivos pueden llegar.
4. Fuera de casa, pulsa **Alta → Baja** en el panel para gastar menos datos.

**Cloudflare Tunnel** (si quieres una URL https pública)
`cloudflared tunnel --url http://localhost:3000`, deja `HOST=127.0.0.1` y pon `TRUST_PROXY=true`. El login protege el panel.

> La contraseña inicial solo se puede crear desde el propio PC (o con `ADMIN_PASSWORD` en `.env`). Así nadie puede "reclamar" un servidor recién expuesto.

## Funcionamiento 24/7

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

Para que arranque al encender Windows: crea una tarea en el **Programador de tareas** con el disparador *Al iniciar sesión* y la acción `pm2 resurrect`. Otra opción es `npm install -g pm2-windows-startup && pm2-startup install`.

Configura también Windows para que **no suspenda** el equipo (Configuración → Sistema → Energía).

## Rendimiento (medido en un Intel i3-6100U)

| | |
|---|---|
| Inferencia YOLOX-Nano | ~35–45 ms por frame |
| 1 webcam 720p, 4 análisis/s, grabación activa | ~7 % CPU Node + ~10–18 % FFmpeg |
| Cámaras RTSP | La grabación copia el vídeo sin recodificar (casi 0 % CPU extra) |

Si tienes varias cámaras y el CPU va justo, baja *Análisis por segundo* en **Ajustes → IA**. YOLOX-Tiny es más preciso, pero gasta unas 3 veces más.

## Estructura

```
server.js               Arranque (Express, seguridad, apagado ordenado)
src/
  config.js             Variables de entorno
  auth.js               Contraseña scrypt, sesiones, límite de intentos, anti-CSRF
  settings.js / store.js Esquema validado de ajustes + caché
  schedule.js / mode.js Modos Armado/En casa/Desarmado y horarios
  core.js               Detección → evento → foto → clip → alertas
  retention.js          Purga por días, por espacio y de archivos huérfanos
  ws.js                 WebSocket autenticado
  db/                   SQLite (WAL) + migraciones versionadas
  ai/                   Detector ONNX, post-proceso YOLOX, motor de eventos
  cameras/              FFmpeg por cámara, reinicio automático, búfer y clips
  alerts/               Telegram (alertas + bot de comandos) y WhatsApp
  routes/               API REST
public/                 Panel web (único directorio servido)
scripts/                Descarga y verificación del modelo
test/                   Pruebas (npm test) y prueba completa sin cámara (npm run test:e2e)
```

## Pruebas

```bash
npm test           # unitarias: horarios, motor de eventos, YOLOX, seguridad
npm run test:e2e   # extremo a extremo con una imagen de prueba (no usa tu webcam)
```

## Créditos y licencias

- Modelos **YOLOX** de Megvii — Apache-2.0 (descargados desde los releases oficiales, con verificación SHA-256).
- `test/fixtures/dog.jpg` procede del repositorio de YOLOX (Apache-2.0).
- Este proyecto: MIT.
