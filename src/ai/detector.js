/**
 * Detector de objetos en el servidor (YOLOX + ONNX Runtime, CPU).
 *
 * Cada cámara deja su último frame en una "ranura". Un único bucle de
 * inferencia recorre las ranuras por turnos: si la IA va más lenta que las
 * cámaras, los frames viejos se sobrescriben (se descartan), nunca se acumulan.
 */
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const config = require('../config');
const yolox = require('./yolox');

const INPUT = 416;
const FRAME_BYTES = INPUT * INPUT * 3;

class Detector extends EventEmitter {
    constructor() {
        super();
        this.ort = null;
        this.session = null;
        this.modelName = null;
        this.slots = new Map(); // cameraId -> { frame, srcW, srcH, ts }
        this.busy = false;
        this.order = [];
        this.stats = { lastMs: 0, avgMs: 0, frames: 0 };
        this.input = new Float32Array(3 * INPUT * INPUT);
        this.status = 'sin cargar';
    }

    modelPath(name) {
        return path.join(config.MODELS_DIR, `${name}.onnx`);
    }

    async load(name) {
        if (this.session && this.modelName === name) return;
        const file = this.modelPath(name);
        if (!fs.existsSync(file)) {
            this.status = `falta el modelo (ejecuta: npm run model:download)`;
            this.session = null;
            throw new Error(`No existe ${file}. Ejecuta "npm run model:download".`);
        }
        this.ort = this.ort || require('onnxruntime-node');
        this.status = 'cargando';
        this.session = await this.ort.InferenceSession.create(file, {
            intraOpNumThreads: 2,          // deja núcleos libres para FFmpeg
            graphOptimizationLevel: 'all',
            // Sin espera activa entre inferencias: medido en un i3-6100U, baja
            // el consumo de ~74 % a ~26 % de un núcleo a 4 fps
            extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } }
        });
        this.modelName = name;
        this.status = 'activa';
        console.log(`[IA] Modelo ${name} cargado (ONNX Runtime, CPU).`);
    }

    /** Llamado por cada cámara con un frame BGR 416x416 (letterbox ya aplicado por FFmpeg). */
    push(cameraId, frame, srcW, srcH) {
        if (frame.length !== FRAME_BYTES) return;
        if (!this.slots.has(cameraId)) this.order.push(cameraId);
        this.slots.set(cameraId, { frame, srcW, srcH, ts: Date.now() });
        if (!this.busy) setImmediate(() => this.loop());
    }

    removeCamera(cameraId) {
        this.slots.delete(cameraId);
        this.order = this.order.filter((id) => id !== cameraId);
    }

    async loop() {
        if (this.busy || !this.session) return;
        this.busy = true;
        try {
            for (;;) {
                const id = this.order.find((cid) => this.slots.has(cid));
                if (id === undefined) break;
                // Rotar para repartir el turno entre cámaras
                this.order = [...this.order.filter((c) => c !== id), id];
                const slot = this.slots.get(id);
                this.slots.delete(id);
                const detections = await this.infer(slot);
                this.emit('detections', id, detections, slot.ts);
            }
        } catch (e) {
            console.error('[IA] Error en inferencia:', e.message);
        } finally {
            this.busy = false;
        }
    }

    async infer({ frame, srcW, srcH }) {
        const t0 = Date.now();
        const plane = INPUT * INPUT;
        const f = this.input;
        // HWC BGR uint8 -> CHW float32 (YOLOX espera BGR 0..255 sin normalizar)
        for (let i = 0, j = 0; i < plane; i++, j += 3) {
            f[i] = frame[j];
            f[plane + i] = frame[j + 1];
            f[2 * plane + i] = frame[j + 2];
        }
        const tensor = new this.ort.Tensor('float32', f, [1, 3, INPUT, INPUT]);
        const result = await this.session.run({ [this.session.inputNames[0]]: tensor });
        const out = result[this.session.outputNames[0]].data;
        const boxes = yolox.nms(yolox.decode(out, INPUT, 0.25));
        const dets = yolox.toNormalized(boxes, INPUT, srcW, srcH);

        const ms = Date.now() - t0;
        this.stats.lastMs = ms;
        this.stats.frames++;
        this.stats.avgMs = this.stats.avgMs ? this.stats.avgMs * 0.95 + ms * 0.05 : ms;
        return dets;
    }

    info() {
        return {
            status: this.status,
            model: this.modelName,
            avgMs: Math.round(this.stats.avgMs),
            frames: this.stats.frames
        };
    }
}

module.exports = new Detector();
module.exports.INPUT = INPUT;
module.exports.FRAME_BYTES = FRAME_BYTES;
