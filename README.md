# Sistema de Vigilancia Web

Un sistema de vigilancia web que utiliza la cámara del dispositivo para detectar movimiento y capturar imágenes automáticamente. Las capturas se organizan por fecha y se muestran en una galería en tiempo real.

## Características

- Activación automática de la cámara al iniciar
- Detección de movimiento en tiempo real
- Captura automática cuando se detecta movimiento
- Organización de imágenes por fecha (año/mes/día)
- Galería de visualización en tiempo real
- Interfaz moderna y responsive con Bootstrap 5
- Almacenamiento local de capturas

## Requisitos

- Node.js (versión 14 o superior)
- Navegador web moderno con soporte para WebRTC
- Cámara web conectada al dispositivo

## Instalación

1. Clona este repositorio:
```bash
git clone https://github.com/Cristiancano1236/Sistema-vigilancia.git
cd vigilancia1
```

2. Instala las dependencias:
```bash
npm install
```

## Uso

1. Inicia el servidor:
```bash
node server.js
```

2. Abre tu navegador y visita:
```
http://localhost:3000
```

3. Permite el acceso a la cámara cuando el navegador lo solicite

4. El sistema comenzará a monitorear automáticamente

## Estructura de Archivos

```
vigilancia1/
├── index.html          # Interfaz principal
├── styles.css          # Estilos CSS
├── app.js             # Lógica del cliente
├── server.js          # Servidor Node.js
├── captures/          # Directorio de capturas
└── README.md          # Documentación
```

## Configuración

Puedes ajustar la sensibilidad de la detección de movimiento y el intervalo de captura en el archivo `app.js`:

```javascript
const MOTION_THRESHOLD = 30;  // Menor = más sensible
const CAPTURE_INTERVAL = 500; // Milisegundos entre comprobaciones
```

## Seguridad

- Las imágenes se almacenan localmente en el servidor
- Se utiliza HTTPS para la transmisión de datos (recomendado en producción)
- No se almacena información personal

## Contribuir

1. Haz un Fork del proyecto
2. Crea una rama para tu característica (`git checkout -b feature/AmazingFeature`)
3. Haz commit de tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

