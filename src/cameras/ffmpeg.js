/**
 * Localiza FFmpeg y construye los argumentos de cada cámara.
 * Orden: FFMPEG_PATH (.env) → ffmpeg del sistema (PATH) → ffmpeg-static (npm).
 */
const { spawn, spawnSync } = require('child_process');
const { maskUrl } = require('../util');

const DETECT_SIZE = 416;
let cachedPath = null;

function ffmpegPath() {
    if (cachedPath) return cachedPath;
    const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'];
    try { candidates.push(require('ffmpeg-static')); } catch (_) {}
    for (const c of candidates.filter(Boolean)) {
        const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 5000, windowsHide: true });
        if (r.status === 0) {
            cachedPath = c;
            console.log(`[FFMPEG] Usando: ${c === 'ffmpeg' ? 'ffmpeg del sistema' : c}`);
            return c;
        }
    }
    throw new Error('No se encontró FFmpeg. Ejecuta "npm install" o instala FFmpeg (winget install Gyan.FFmpeg).');
}

function inputArgs(camera) {
    if (camera.type === 'rtsp') {
        return [
            '-rtsp_transport', camera.transport === 'udp' ? 'udp' : 'tcp',
            '-timeout', '10000000',          // 10 s sin datos = desconexión (microsegundos)
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-i', camera.source
        ];
    }
    if (camera.type === 'test') {
        // Solo para pruebas internas (la API únicamente acepta rtsp/dshow): imagen fija en bucle
        return ['-re', '-loop', '1', '-framerate', '10', '-i', camera.source];
    }
    // Webcam USB / integrada en Windows (DirectShow)
    return ['-f', 'dshow', '-rtbufsize', '100M', '-i', `video=${camera.source}`];
}

/**
 * Un solo proceso FFmpeg por cámara con hasta tres salidas:
 *  1. segmentos .ts de 2 s para el búfer de grabación (opcional)
 *  2. frames BGR 416x416 con letterbox para la IA → stdout (pipe:1)
 *  3. JPEG para la vista en vivo y las fotos de evento → pipe:3
 */
function buildArgs(camera, { segmentPattern = null, detectFps = 4, liveFps = 10 } = {}) {
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...inputArgs(camera)];

    if (segmentPattern) {
        const seg = ['-f', 'segment', '-segment_time', '2', '-reset_timestamps', '1', '-strftime', '1', segmentPattern];
        if (camera.type === 'rtsp') {
            // Copia directa del H.264/H.265 de la cámara: casi 0 % de CPU
            args.push('-map', '0:v:0', '-c:v', 'copy', '-an', ...seg);
        } else {
            args.push(
                '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p', '-r', '15', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...seg
            );
        }
    }

    const S = DETECT_SIZE;
    args.push(
        '-map', '0:v:0',
        '-vf', `fps=${detectFps},scale=${S}:${S}:force_original_aspect_ratio=decrease,pad=${S}:${S}:0:0:color=0x727272`,
        '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'
    );

    args.push(
        '-map', '0:v:0',
        '-vf', `fps=${liveFps},scale='min(1280,iw)':-2`,
        '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '5', '-f', 'image2pipe', 'pipe:3'
    );
    return args;
}

/** Prueba una URL RTSP: intenta leer un frame en menos de 8 s. */
function testRtsp(url, transport = 'tcp') {
    return new Promise((resolve) => {
        if (typeof url !== 'string' || !url.startsWith('rtsp://') || url.length > 500) {
            return resolve({ success: false, error: 'La URL debe comenzar con rtsp://' });
        }
        console.log(`[RTSP] Probando conexión a: ${maskUrl(url)} (${transport})`);
        let proc;
        try {
            proc = spawn(ffmpegPath(), [
                '-hide_banner', '-rtsp_transport', transport === 'udp' ? 'udp' : 'tcp',
                '-timeout', '6000000', '-i', url, '-frames:v', '1', '-f', 'null', '-'
            ], { windowsHide: true });
        } catch (e) {
            return resolve({ success: false, error: e.message });
        }
        let err = '';
        let done = false;
        const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (_) {}
            finish({ success: false, error: 'Tiempo agotado. Verifica la IP y que la cámara esté encendida.' });
        }, 8000);
        proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
        proc.on('error', (e) => finish({ success: false, error: `Error al ejecutar FFmpeg: ${e.message}` }));
        proc.on('close', (code) => {
            const m = err.match(/Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/);
            if (code === 0 || m) {
                return finish({ success: true, message: m ? `Conectada: ${m[1].toUpperCase()} ${m[2]}x${m[3]}` : 'Conectada' });
            }
            let e = 'No se pudo conectar a la cámara.';
            if (/401|Unauthorized|authorization failed/i.test(err)) e = 'Usuario o contraseña incorrectos.';
            else if (/Connection refused/i.test(err)) e = 'Conexión rechazada: puerto cerrado o IP incorrecta.';
            else if (/No route to host|Host is down|timed out/i.test(err)) e = 'Cámara no encontrada en la red.';
            else if (/404|Not Found/i.test(err)) e = 'La ruta del stream no existe (revisa /stream1, /h264Preview...).';
            finish({ success: false, error: e });
        });
    });
}

/** Lista las cámaras DirectShow (Windows). */
function listDshowDevices() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve([]);
        let out = '';
        let proc;
        try {
            proc = spawn(ffmpegPath(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
        } catch (_) {
            return resolve([]);
        }
        proc.stderr.on('data', (d) => (out += d.toString()));
        proc.on('error', () => resolve([]));
        proc.on('close', () => {
            const devices = [];
            const re = /"([^"]+)" \(video\)/g;
            let m;
            while ((m = re.exec(out))) devices.push(m[1]);
            resolve(devices);
        });
    });
}

/** Ejecuta FFmpeg y resuelve con el código de salida (para concat de clips). */
function run(args, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
        let err = '';
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-4000); });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });
}

module.exports = { ffmpegPath, buildArgs, testRtsp, listDshowDevices, run, DETECT_SIZE };
