/**
 * Proceso FFmpeg de una cámara: lo arranca, lo vigila y lo reinicia solo.
 *
 * Eventos:
 *   'frame'  (bgrBuffer, srcW, srcH)  frame 416x416 para la IA
 *   'status' (status)                 starting | online | offline | stopped
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');
const ffmpeg = require('./ffmpeg');
const { maskUrl } = require('../util');

const FRAME_BYTES = ffmpeg.DETECT_SIZE * ffmpeg.DETECT_SIZE * 3;
const BOUNDARY = 'bethaframe';
const STALL_MS = 20000;
const MAX_JPEG_BUFFER = 8 * 1024 * 1024;

class CameraPipeline extends EventEmitter {
    /**
     * @param {object} camera  fila de la tabla cameras
     * @param {object} opts    { segmentPattern, detectFps }
     */
    constructor(camera, opts) {
        super();
        this.camera = camera;
        this.opts = opts;
        this.proc = null;
        this.status = 'stopped';
        this.stopped = true;
        this.backoff = 1000;
        this.restartTimer = null;
        this.watchdog = null;
        this.onlineSince = 0;
        this.lastFrameAt = 0;
        this.srcW = 0;
        this.srcH = 0;
        this.codec = null;
        this.lastError = '';
        this.latestJpeg = null;
        this.latestJpegAt = 0;
        this.clients = new Set();
        this.resetBuffers();
    }

    resetBuffers() {
        this.raw = Buffer.allocUnsafe(FRAME_BYTES);
        this.rawLen = 0;
        this.jbuf = Buffer.alloc(0);
        this.jscan = 0;
    }

    setStatus(s) {
        if (this.status === s) return;
        this.status = s;
        this.emit('status', s);
    }

    start() {
        this.stopped = false;
        this.spawn();
        clearInterval(this.watchdog);
        this.watchdog = setInterval(() => this.checkStall(), 5000);
    }

    spawn() {
        clearTimeout(this.restartTimer);
        this.resetBuffers();
        this.srcW = 0;
        this.srcH = 0;
        this.lastFrameAt = Date.now();
        this.setStatus('starting');

        let args;
        try {
            args = ffmpeg.buildArgs(this.camera, this.opts);
            this.proc = spawn(ffmpeg.ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) {
            this.lastError = e.message;
            this.onExit();
            return;
        }
        const label = this.camera.type === 'rtsp' ? maskUrl(this.camera.source) : this.camera.source;
        console.log(`[CAM ${this.camera.id}] FFmpeg iniciado (${label})`);

        const proc = this.proc;
        proc.stdout.on('data', (chunk) => this.onRaw(chunk));
        proc.stdio[3].on('data', (chunk) => this.onJpegData(chunk));
        proc.stderr.on('data', (d) => this.onStderr(d.toString()));
        proc.on('error', (e) => { this.lastError = e.message; });
        proc.on('close', (code) => {
            if (this.proc === proc) this.proc = null;
            console.log(`[CAM ${this.camera.id}] FFmpeg terminó (código ${code})${this.lastError ? ': ' + this.lastError.split('\n').pop() : ''}`);
            this.onExit();
        });
    }

    onExit() {
        if (this.stopped) {
            this.setStatus('stopped');
            return;
        }
        this.setStatus('offline');
        // Si estuvo estable más de 60 s, reiniciar rápido; si no, espera creciente hasta 30 s
        if (this.onlineSince && Date.now() - this.onlineSince > 60000) this.backoff = 1000;
        this.onlineSince = 0;
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 30000);
        this.restartTimer = setTimeout(() => !this.stopped && this.spawn(), wait);
    }

    checkStall() {
        if (this.stopped || !this.proc) return;
        if (Date.now() - this.lastFrameAt > STALL_MS) {
            console.warn(`[CAM ${this.camera.id}] Sin imagen durante ${STALL_MS / 1000}s, reiniciando FFmpeg.`);
            this.lastError = 'sin imagen (stream congelado)';
            try { this.proc.kill('SIGKILL'); } catch (_) {}
        }
    }

    onStderr(text) {
        if (!this.srcW) {
            const m = text.match(/Stream #0:\d+[^\n]*?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/);
            if (m) {
                this.codec = m[1];
                this.srcW = parseInt(m[2], 10);
                this.srcH = parseInt(m[3], 10);
            }
        }
        const lines = text.split(/\r?\n/).filter((l) => /error|failed|refused|unauthorized|not found|invalid/i.test(l));
        if (lines.length) this.lastError = maskUrl(lines[lines.length - 1]).slice(0, 300);
    }

    onRaw(chunk) {
        let off = 0;
        while (off < chunk.length) {
            const n = Math.min(FRAME_BYTES - this.rawLen, chunk.length - off);
            chunk.copy(this.raw, this.rawLen, off, off + n);
            this.rawLen += n;
            off += n;
            if (this.rawLen === FRAME_BYTES) {
                const frame = this.raw;
                this.raw = Buffer.allocUnsafe(FRAME_BYTES);
                this.rawLen = 0;
                if (this.srcW) this.emit('frame', frame, this.srcW, this.srcH);
            }
        }
    }

    /** Separa JPEG completos (FFD8 … FFD9) del flujo image2pipe. */
    onJpegData(chunk) {
        this.jbuf = this.jbuf.length ? Buffer.concat([this.jbuf, chunk]) : chunk;
        for (;;) {
            // El búfer debe empezar por SOI (FF D8); si no, descartar hasta el siguiente
            if (!(this.jbuf.length >= 2 && this.jbuf[0] === 0xff && this.jbuf[1] === 0xd8)) {
                const soi = this.findMarker(0xd8, 0);
                if (soi < 0) {
                    const last = this.jbuf[this.jbuf.length - 1];
                    this.jbuf = last === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0);
                    this.jscan = 0;
                    return;
                }
                this.jbuf = this.jbuf.subarray(soi);
                this.jscan = 0;
            }
            const eoi = this.findMarker(0xd9, Math.max(2, this.jscan));
            if (eoi < 0) {
                this.jscan = Math.max(2, this.jbuf.length - 1);
                if (this.jbuf.length > MAX_JPEG_BUFFER) { this.jbuf = Buffer.alloc(0); this.jscan = 0; }
                return;
            }
            const jpeg = Buffer.from(this.jbuf.subarray(0, eoi + 2));
            this.jbuf = this.jbuf.subarray(eoi + 2);
            this.jscan = 0;
            this.onJpeg(jpeg);
        }
    }

    findMarker(marker, from) {
        let i = from;
        for (;;) {
            i = this.jbuf.indexOf(0xff, i);
            if (i < 0 || i + 1 >= this.jbuf.length) return -1;
            if (this.jbuf[i + 1] === marker) return i;
            i++;
        }
    }

    onJpeg(jpeg) {
        const now = Date.now();
        this.latestJpeg = jpeg;
        this.latestJpegAt = now;
        this.lastFrameAt = now;
        if (this.status !== 'online') {
            this.onlineSince = now;
            this.lastError = '';
            this.setStatus('online');
        }
        for (const c of this.clients) this.sendFrame(c, jpeg);
    }

    // ==========================================
    // CLIENTES MJPEG (vista en vivo)
    // ==========================================

    addClient(req, res, { low = false } = {}) {
        res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Connection: 'close',
            'X-Accel-Buffering': 'no'
        });
        const client = { res, low, waiting: false, n: 0 };
        this.clients.add(client);
        // Mostrar algo al instante en vez de esperar al siguiente frame
        if (this.latestJpeg) this.sendFrame(client, this.latestJpeg, true);
        req.on('close', () => this.clients.delete(client));
    }

    sendFrame(client, jpeg, force = false) {
        // Backpressure: si el cliente no ha vaciado el anterior, se salta este frame
        if (client.waiting) return;
        // Calidad baja (uso remoto): 1 de cada 3 frames
        if (!force && client.low && client.n++ % 3 !== 0) return;
        const { res } = client;
        try {
            res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
            const ok = res.write(jpeg);
            res.write('\r\n');
            if (!ok) {
                client.waiting = true;
                res.once('drain', () => { client.waiting = false; });
            }
        } catch (_) {
            this.clients.delete(client);
        }
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.restartTimer);
        clearInterval(this.watchdog);
        for (const c of this.clients) { try { c.res.end(); } catch (_) {} }
        this.clients.clear();
        if (this.proc) {
            try { this.proc.kill('SIGKILL'); } catch (_) {}
        } else {
            this.setStatus('stopped');
        }
    }

    info() {
        return {
            id: this.camera.id,
            status: this.status,
            width: this.srcW,
            height: this.srcH,
            codec: this.codec,
            lastError: this.status === 'online' ? '' : this.lastError,
            viewers: this.clients.size
        };
    }
}

module.exports = { CameraPipeline };
