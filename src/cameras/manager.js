/**
 * Gestor de cámaras: un CameraPipeline por cámara habilitada.
 * Conecta los frames con el detector y avisa de cambios de estado.
 */
const EventEmitter = require('events');
const db = require('../db/database');
const store = require('../store');
const detector = require('../ai/detector');
const recorder = require('./recorder');
const { CameraPipeline } = require('./pipeline');
const { maskUrl } = require('../util');

function parseRoi(json) {
    try {
        const r = JSON.parse(json || 'null');
        if (r && typeof r === 'object') return r;
    } catch (_) {}
    return { enabled: false, x: 10, y: 10, width: 80, height: 80 };
}

class CameraManager extends EventEmitter {
    constructor() {
        super();
        this.pipelines = new Map(); // id -> CameraPipeline
        this.cameras = new Map();   // id -> { ...fila, roi }
        this.pruneTimer = null;
    }

    async start() {
        const rows = await db.listCameras();
        for (const cam of rows) this.cameras.set(cam.id, { ...cam, roi: parseRoi(cam.roi_json) });
        for (const cam of this.cameras.values()) if (cam.enabled) await this.startCamera(cam.id);

        this.pruneTimer = setInterval(() => {
            for (const id of this.pipelines.keys()) recorder.prune(id).catch(() => {});
        }, 10000);

        // Cambios de ajustes que requieren reiniciar FFmpeg
        store.on('change', (keys) => {
            if (keys.some((k) => ['video_clips_enabled', 'detection_fps'].includes(k))) this.restartAll();
        });
    }

    async startCamera(id) {
        const cam = this.cameras.get(id);
        if (!cam || this.pipelines.has(id)) return;
        const s = store.get();
        let segmentPattern = null;
        if (s.clipsEnabled) {
            await recorder.clear(id);   // segmentos de una ejecución anterior ya no sirven
            await recorder.prepare(id);
            segmentPattern = recorder.patternFor(id);
        }
        const p = new CameraPipeline(cam, { segmentPattern, detectFps: s.detectionFps });
        p.on('frame', (frame, w, h) => detector.push(id, frame, w, h));
        p.on('status', (status) => this.emit('status', { ...p.info(), name: cam.name, status }));
        this.pipelines.set(id, p);
        p.start();
    }

    stopCamera(id) {
        const p = this.pipelines.get(id);
        if (!p) return;
        p.stop();
        this.pipelines.delete(id);
        detector.removeCamera(id);
    }

    async restartCamera(id) {
        this.stopCamera(id);
        const cam = this.cameras.get(id);
        if (cam && cam.enabled) await this.startCamera(id);
    }

    async restartAll() {
        for (const id of [...this.pipelines.keys()]) await this.restartCamera(id);
    }

    get(id) {
        return this.pipelines.get(Number(id));
    }

    getCamera(id) {
        return this.cameras.get(Number(id));
    }

    // ==========================================
    // CRUD (llamado desde la API)
    // ==========================================

    async create(data) {
        const row = await db.createCamera(data);
        this.cameras.set(row.id, { ...row, roi: parseRoi(row.roi_json) });
        if (row.enabled) await this.startCamera(row.id);
        return this.publicCamera(row.id);
    }

    async update(id, data) {
        const before = this.cameras.get(id);
        if (!before) return null;
        const row = await db.updateCamera(id, data);
        this.cameras.set(id, { ...row, roi: parseRoi(row.roi_json) });
        // Nombre o ROI no requieren reiniciar FFmpeg
        const needsRestart = ['type', 'source', 'transport', 'enabled'].some((k) => data[k] !== undefined && String(data[k]) !== String(before[k]));
        if (needsRestart) await this.restartCamera(id);
        else if (this.pipelines.has(id)) this.pipelines.get(id).camera = this.cameras.get(id);
        return this.publicCamera(id);
    }

    async remove(id) {
        this.stopCamera(id);
        this.cameras.delete(id);
        await recorder.clear(id);
        return db.deleteCamera(id);
    }

    /** Cámara sin credenciales (la URL RTSP se enmascara). */
    publicCamera(id) {
        const cam = this.cameras.get(Number(id));
        if (!cam) return null;
        const p = this.pipelines.get(cam.id);
        return {
            ...(p ? p.info() : { status: 'stopped', width: 0, height: 0, codec: null, lastError: '', viewers: 0 }),
            id: cam.id,
            name: cam.name,
            type: cam.type,
            source: cam.type === 'rtsp' ? maskUrl(cam.source) : cam.source,
            transport: cam.transport,
            roi: cam.roi,
            enabled: Boolean(cam.enabled)
        };
    }

    list() {
        return [...this.cameras.keys()].map((id) => this.publicCamera(id));
    }

    stopAll() {
        clearInterval(this.pruneTimer);
        for (const id of [...this.pipelines.keys()]) this.stopCamera(id);
    }
}

module.exports = new CameraManager();
