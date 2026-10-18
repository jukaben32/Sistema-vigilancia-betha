const { spawn } = require('child_process');
const EventEmitter = require('events');

// Oculta usuario:clave de la URL para no escribirlos en los logs
const maskUrl = (url) => String(url).replace(/\/\/[^@/]*@/, '//***:***@');

/**
 * Puente RTSP automático para cámaras Wi-Fi / IP (Tapo, Reolink, Ezviz, etc.)
 * Transcodifica el stream RTSP H.264/H.265 a un flujo MJPEG de baja latencia
 * directamente compatible con cualquier navegador web sin plugins ni software externo.
 */
class RtspBridge extends EventEmitter {
    constructor() {
        super();
        this.ffmpegProcess = null;
        this.currentUrl = null;
        this.transport = 'tcp';
        this.activeClients = new Set();
        this.isRunning = false;
        this.stopTimeout = null;
    }

    /**
     * Probar si una URL RTSP responde y es válida
     */
    testConnection(url, transport = 'tcp') {
        return new Promise((resolve) => {
            if (!url || !url.startsWith('rtsp://')) {
                return resolve({ success: false, error: 'La URL debe comenzar con rtsp://' });
            }

            console.log(`[RTSP] Probando conexión a: ${maskUrl(url)} (transporte: ${transport})`);

            const args = [
                '-rtsp_transport', transport,
                '-i', url,
                '-vframes', '1',
                '-f', 'null',
                '-'
            ];

            const proc = spawn('ffmpeg', args);
            let stderrOutput = '';
            let resolved = false;

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { proc.kill('SIGKILL'); } catch (_) {}
                    resolve({
                        success: false,
                        error: 'Tiempo de espera agotado (Timeout). Verifica la IP y que la cámara esté encendida en la red.'
                    });
                }
            }, 6000);

            proc.stderr.on('data', (data) => {
                stderrOutput += data.toString();
            });

            proc.on('close', (code) => {
                clearTimeout(timeout);
                if (resolved) return;
                resolved = true;

                if (code === 0 || stderrOutput.includes('video:') || stderrOutput.includes('Stream #0:0')) {
                    resolve({
                        success: true,
                        message: '¡Conexión establecida con éxito con la cámara Wi-Fi!'
                    });
                } else {
                    let friendlyError = 'No se pudo conectar a la cámara Wi-Fi.';
                    if (stderrOutput.includes('401 Unauthorized') || stderrOutput.includes('Authentication')) {
                        friendlyError = 'Error de autenticación: Usuario o contraseña incorrectos.';
                    } else if (stderrOutput.includes('Connection refused')) {
                        friendlyError = 'Conexión rechazada: El puerto 554 no está abierto o la IP es incorrecta.';
                    } else if (stderrOutput.includes('Host is down') || stderrOutput.includes('No route to host')) {
                        friendlyError = 'Cámara no encontrada: Verifica que la cámara esté conectada al Wi-Fi.';
                    }

                    resolve({ success: false, error: friendlyError, raw: stderrOutput.slice(-300) });
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                if (resolved) return;
                resolved = true;
                resolve({ success: false, error: `Error al ejecutar FFmpeg: ${err.message}` });
            });
        });
    }

    /**
     * Iniciar el proceso de transcodificación FFmpeg
     */
    start(url, transport = 'tcp') {
        if (this.isRunning && this.currentUrl === url && this.transport === transport) {
            return;
        }

        this.stop();

        this.currentUrl = url;
        this.transport = transport;
        this.isRunning = true;

        console.log(`[RTSP] Iniciando puente FFmpeg para: ${maskUrl(url)}`);

        const args = [
            '-rtsp_transport', transport,
            '-i', url,
            '-an',                      // Sin audio para máxima velocidad
            '-c:v', 'mjpeg',            // Formato MJPEG universal
            '-q:v', '5',                // Calidad balanceada
            '-r', '15',                 // 15 FPS fluido
            '-f', 'mpjpeg',             // Multipart JPEG
            '-boundary_tag', 'ffserver', // Debe coincidir con el boundary de la cabecera HTTP
            '-'                         // Salida a stdout
        ];

        this.ffmpegProcess = spawn('ffmpeg', args);

        this.ffmpegProcess.stdout.on('data', (chunk) => {
            for (const res of this.activeClients) {
                try {
                    res.write(chunk);
                } catch (e) {
                    this.activeClients.delete(res);
                }
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            // Logs de depuración en caso de advertencias
            const msg = data.toString();
            if (msg.includes('Error') || msg.includes('fatal')) {
                console.warn('[RTSP FFmpeg]', msg.trim());
            }
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[RTSP] Proceso FFmpeg cerrado con código ${code}`);
            this.isRunning = false;
            this.ffmpegProcess = null;
        });

        this.ffmpegProcess.on('error', (err) => {
            console.error('[RTSP] Error en proceso FFmpeg:', err);
            this.isRunning = false;
        });
    }

    /**
     * Detener el proceso
     */
    stop() {
        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill('SIGTERM');
            } catch (_) {}
            this.ffmpegProcess = null;
        }
        this.isRunning = false;
        console.log('[RTSP] Puente FFmpeg detenido.');
    }

    /**
     * Conectar un cliente HTTP al stream MJPEG
     */
    handleClient(req, res, url, transport = 'tcp') {
        if (!url) {
            return res.status(400).send('URL RTSP no configurada');
        }

        // Cancelar apagado por inactividad si estaba programado
        if (this.stopTimeout) {
            clearTimeout(this.stopTimeout);
            this.stopTimeout = null;
        }

        // Iniciar FFmpeg si no está corriendo o cambió la URL
        if (!this.isRunning || this.currentUrl !== url) {
            this.start(url, transport);
        }

        // Cabeceras HTTP para streaming MJPEG continuo
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=ffserver',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Connection': 'close'
        });

        this.activeClients.add(res);
        console.log(`[RTSP] Cliente conectado al stream en vivo (Total: ${this.activeClients.size})`);

        req.on('close', () => {
            this.activeClients.delete(res);
            console.log(`[RTSP] Cliente desconectado (Restantes: ${this.activeClients.size})`);

            // Si no quedan clientes viendo la cámara, apagar FFmpeg tras 20 segundos para ahorrar CPU
            if (this.activeClients.size === 0) {
                this.stopTimeout = setTimeout(() => {
                    if (this.activeClients.size === 0) {
                        this.stop();
                    }
                }, 20000);
            }
        });
    }
}

module.exports = new RtspBridge();
