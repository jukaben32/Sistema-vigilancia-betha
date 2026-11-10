const test = require('node:test');
const assert = require('node:assert');
const { decode, nms, toNormalized, COCO } = require('../src/ai/yolox');

const SIZE = 416;
const N = 52 * 52 + 26 * 26 + 13 * 13;

/** Construye una salida cruda con una sola caja en la celda (gx, gy) del stride 8. */
function rawWithBox({ gx, gy, dx = 0.5, dy = 0.5, logW, logH, obj, cls, clsScore }) {
    const out = new Float32Array(N * 85);
    const idx = gy * 52 + gx;
    const o = idx * 85;
    out[o] = dx; out[o + 1] = dy; out[o + 2] = logW; out[o + 3] = logH;
    out[o + 4] = obj;
    out[o + 5 + cls] = clsScore;
    return out;
}

test('decodifica rejilla, exp y puntuación obj*cls', () => {
    const person = COCO.indexOf('person');
    const out = rawWithBox({ gx: 10, gy: 20, logW: Math.log(4), logH: Math.log(8), obj: 0.9, cls: person, clsScore: 0.8 });
    const boxes = decode(out, SIZE, 0.25);
    assert.strictEqual(boxes.length, 1);
    const b = boxes[0];
    assert.strictEqual(b.classId, person);
    assert.ok(Math.abs(b.score - 0.72) < 1e-6);
    // centro = (10.5*8, 20.5*8) = (84, 164); tamaño = (32, 64)
    assert.ok(Math.abs(b.x1 - 68) < 1e-4 && Math.abs(b.x2 - 100) < 1e-4);
    assert.ok(Math.abs(b.y1 - 132) < 1e-4 && Math.abs(b.y2 - 196) < 1e-4);
});

test('ignora clases irrelevantes y puntuaciones bajas', () => {
    const tv = COCO.indexOf('tv');
    assert.strictEqual(decode(rawWithBox({ gx: 1, gy: 1, logW: 0, logH: 0, obj: 0.99, cls: tv, clsScore: 0.99 }), SIZE).length, 0);
    assert.strictEqual(decode(rawWithBox({ gx: 1, gy: 1, logW: 0, logH: 0, obj: 0.4, cls: 0, clsScore: 0.4 }), SIZE, 0.25).length, 0);
});

test('NMS por clase', () => {
    const a = { classId: 0, score: 0.9, x1: 0, y1: 0, x2: 10, y2: 10 };
    const b = { classId: 0, score: 0.8, x1: 1, y1: 1, x2: 11, y2: 11 };
    const c = { classId: 2, score: 0.7, x1: 1, y1: 1, x2: 11, y2: 11 };
    const kept = nms([b, a, c]);
    assert.deepStrictEqual(kept.map((k) => k.score), [0.9, 0.7]);
});

test('normaliza deshaciendo el letterbox', () => {
    // Imagen 832x416 → escala 0.5 → contenido 416x208 arriba a la izquierda
    const boxes = [{ classId: 0, score: 0.9, x1: 104, y1: 52, x2: 208, y2: 104 }];
    const [d] = toNormalized(boxes, SIZE, 832, 416);
    assert.strictEqual(d.class, 'person');
    assert.strictEqual(d.label, 'Persona');
    assert.deepStrictEqual(d.bbox, [0.25, 0.25, 0.25, 0.25]);
});
