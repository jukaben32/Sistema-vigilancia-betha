# 🛡️ BETHA SENTINEL // Sistema de Vigilancia IA (v2.0)

Sistema de vigilancia web inteligente de grado profesional impulsado por **Redes Neuronales (TensorFlow.js / COCO-SSD)** en tiempo real, clips de video en búfer, base de datos SQLite indexada, alertas fotográficas instantáneas por **Telegram Bot** y un **Dashboard CCTV Cyberpunk** de alta tecnología.

---

## ⚡ Nuevas Características (v2.0)

### 1. 🧠 Visión por Computadora e Inteligencia Artificial
* **Detección de Objetos en Tiempo Real**: Utiliza el modelo neural **COCO-SSD** acelerado por WebGL directamente en el navegador.
* **Eliminación Total de Falsos Positivos**: Ya no se detecta ruido por simples cambios de luz o sombras; el sistema clasifica de forma certera **Personas**, **Vehículos** y **Mascotas**.
* **Bounding Boxes Tácticos en Vivo**: Resalta visualmente al sujeto detectado con cuadros de borde cian/esmeralda y el porcentaje exacto de confianza (ej. `👤 PERSONA 94%`).
* **Zona de Vigilancia ROI (Region of Interest)**: Puedes definir y dibujar un cuadrante de vigilancia en pantalla para ignorar áreas fuera de interés (como calles transitadas o ventanas).

### 2. 📹 Grabación de Video Clips + Fotos en Alta Resolución
* **Grabación de Video Clips WebM**: Cuando se detecta un intruso, no solo captura una foto con la caja delimitadora; graba automáticamente un clip de video de 6 a 10 segundos.
* **Visor Forense Integrado**: Modal interactivo que permite alternar con un solo clic entre la foto HD y la reproducción del video clip capturado.
* **Cooldown Anti-Spam Inteligente**: Evita saturar el disco con cientos de fotos si una persona permanece caminando en el encuadre (tiempo configurable entre 5s y 30s).

### 3. 💾 Base de Datos SQLite Indexada & Purga Automática
* **Indexación Instantánea**: Sustituye la lectura manual de carpetas en disco por una base de datos **SQLite** optimizada (`data/vigilancia.sqlite`).
* **Paginación y Filtros Rápidos**: Búsqueda instantánea por fecha, categoría de detección y eventos destacados.
* **Línea de Tiempo Interactiva (24h Scrubber)**: Barra visual que marca todos los eventos del día con pines interactivos para saltar a cualquier momento con un clic.
* **Política de Retención Automática**: Programador automático que purga grabaciones con más de *N* días (configurable de 3 a 60 días).
* **Protección de Evidencia (Favoritos / Estrella)**: Puedes marcar cualquier captura con una estrella (<i class="bi bi-star-fill text-warning"></i>) para evitar que la purga automática la elimine jamás.

### 4. 🚨 Alertas Instantáneas en Telegram Bot & Alarma Sonora
* **Notificaciones con Foto en Telegram**: Cada vez que se detecta a una persona, el servidor envía una alerta a tu móvil con la foto adjunta, fecha y porcentaje de confianza.
* **WebSockets Bidireccionales**: El panel de control se actualiza en tiempo real sin recargar la página cuando se detecta un evento.
* **Sirena Sonora Disuasoria**: Alarma acústica sintetizada en el navegador (Web Audio API) que avisa instantáneamente ante cualquier intrusión.

---

## 🚀 Requisitos e Instalación

### Requisitos:
* **Node.js** (versión 18 o superior, probado en Node 24)
* **Navegador web moderno** (Chrome, Edge, Firefox, Brave, Safari) con soporte WebRTC y cámara web.

### Instalación:

1. Ingresa a la carpeta del proyecto:
```bash
cd "Sistema-vigilancia-betha"
```

2. Instala las dependencias:
```bash
npm install
```

3. Inicia el servidor:
```bash
npm start
```
*(Para desarrollo con auto-reload puedes usar `npm run dev`)*.

4. Abre tu navegador en:
```
http://localhost:3000
```

5. Otorga permiso a la cámara y haz clic en **"Iniciar Sistema"**.

---

## 📲 Configuración del Bot de Telegram (Alertas Móviles)

El sistema incluye integración nativa con Telegram para avisos en tiempo real:

1. Abre Telegram y busca a **`@BotFather`**.
2. Envía el comando `/newbot` y sigue las instrucciones para crear tu bot. Al finalizar, copia el **HTTP API Token** (ej. `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
3. Busca al bot **`@userinfobot`** en Telegram y pulsa Iniciar para conocer tu **ID numérico** (ej. `987654321`).
4. Abre tu bot recién creado y pulsa **Iniciar / Start** para permitirle enviarte mensajes.
5. En el panel de Betha Sentinel, haz clic en **Ajustes** (<i class="bi bi-gear-fill"></i>):
   - Activa el interruptor **"Activar Alertas por Telegram Bot"**.
   - Pega tu **Token** y tu **Chat ID**.
   - Haz clic en **"Probar Envío"** para comprobar la conexión.
   - Pulsa **"Guardar Ajustes"**.

---

## 📁 Estructura del Proyecto

```
Sistema-vigilancia-betha/
├── index.html          # Dashboard CCTV con estética Cyberpunk / Dark Ops
├── styles.css          # Estilos modernos con CSS variables, glow y HUD táctico
├── app.js             # Motor neural TensorFlow.js, WebSockets, grabador y controles
├── server.js          # Servidor Express, WebSocket Server, Multer y API REST
├── database.js        # Módulo SQLite con índices, estadísticas y retención
├── notifications.js   # Notificaciones multicanal (Telegram Bot API con fotos)
├── data/              # Base de datos SQLite (vigilancia.sqlite)
├── captures/          # Capturas organizadas por YYYY/MM/DD/ (fotos y clips WebM)
├── .env.example       # Plantilla de variables de entorno
└── package.json       # Dependencias y scripts del proyecto
```

---

## 🔒 Privacidad y Seguridad
* Todas las grabaciones y la base de datos residen localmente en tu propio equipo.
* Ningún fotograma de video se envía a servidores de terceros para procesamiento; la IA se ejecuta en local mediante aceleración WebGL.
* Los tokens de bot y credenciales se guardan localmente en SQLite y `.env`.

---

© 2026 Betha Sentinel Security Hub. Licencia MIT.
