/**
 * Post-proceso de YOLOX (salida cruda [1, N, 85] sin decodificar).
 * Funciones puras: se prueban con test/yolox.test.js.
 */

const COCO = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
    'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
    'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
    'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
    'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
    'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
    'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
    'scissors', 'teddy bear', 'hair drier', 'toothbrush'
];

// Grupos que el usuario puede activar en Ajustes
const GROUPS = {
    person: ['person'],
    vehicle: ['car', 'truck', 'bus', 'motorcycle', 'bicycle'],
    animal: ['dog', 'cat', 'bird', 'horse']
};

const LABELS_ES = {
    person: 'Persona', car: 'Coche', truck: 'Camión', bus: 'Autobús', motorcycle: 'Motocicleta',
    bicycle: 'Bicicleta', dog: 'Perro', cat: 'Gato', bird: 'Pájaro', horse: 'Caballo'
};

/** Solo nos interesan estas clases: se descarta el resto antes del NMS. */
const RELEVANT = new Set(Object.values(GROUPS).flat().map((n) => COCO.indexOf(n)));

/**
 * Decodifica la salida de YOLOX.
 * @param {Float32Array} out   datos [N*85]
 * @param {number} size        lado de entrada (416)
 * @param {number} minScore    umbral mínimo (obj * cls)
 * @returns {Array<{classId, score, x1, y1, x2, y2}>} en píxeles de la entrada
 */
function decode(out, size, minScore = 0.25, strides = [8, 16, 32]) {
    const boxes = [];
    let idx = 0;
    for (const s of strides) {
        const g = size / s;
        for (let gy = 0; gy < g; gy++) {
            for (let gx = 0; gx < g; gx++, idx++) {
                const o = idx * 85;
                const obj = out[o + 4];
                if (obj < minScore) continue;
                let best = 0;
                let cls = -1;
                for (const c of RELEVANT) {
                    const v = out[o + 5 + c];
                    if (v > best) { best = v; cls = c; }
                }
                const score = obj * best;
                if (cls < 0 || score < minScore) continue;
                const cx = (out[o] + gx) * s;
                const cy = (out[o + 1] + gy) * s;
                const w = Math.exp(out[o + 2]) * s;
                const h = Math.exp(out[o + 3]) * s;
                boxes.push({ classId: cls, score, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 });
            }
        }
    }
    return boxes;
}

function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const inter = ix * iy;
    const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return union > 0 ? inter / union : 0;
}

/** NMS por clase. */
function nms(boxes, iouThr = 0.45) {
    const sorted = [...boxes].sort((a, b) => b.score - a.score);
    const keep = [];
    for (const b of sorted) {
        if (keep.every((k) => k.classId !== b.classId || iou(k, b) < iouThr)) keep.push(b);
    }
    return keep;
}

/**
 * Pasa de coordenadas de la imagen con letterbox (relleno abajo/derecha)
 * a coordenadas normalizadas 0..1 de la imagen original.
 */
function toNormalized(boxes, size, srcW, srcH) {
    const r = Math.min(size / srcW, size / srcH);
    const cw = srcW * r;
    const ch = srcH * r;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    return boxes.map((b) => {
        const x1 = clamp(b.x1 / cw);
        const y1 = clamp(b.y1 / ch);
        const x2 = clamp(b.x2 / cw);
        const y2 = clamp(b.y2 / ch);
        const name = COCO[b.classId];
        return {
            class: name,
            label: LABELS_ES[name] || name,
            score: Math.round(b.score * 1000) / 1000,
            bbox: [x1, y1, x2 - x1, y2 - y1].map((v) => Math.round(v * 10000) / 10000)
        };
    }).filter((d) => d.bbox[2] > 0.005 && d.bbox[3] > 0.005);
}

function groupOf(className) {
    for (const [g, list] of Object.entries(GROUPS)) if (list.includes(className)) return g;
    return null;
}

module.exports = { COCO, GROUPS, LABELS_ES, decode, nms, iou, toNormalized, groupOf };
