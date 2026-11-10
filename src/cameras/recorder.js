/**
 * Búfer de grabación por segmentos y montaje de clips con pre-evento.
 *
 * FFmpeg escribe segmentos de ~2 s llamados seg_YYYYMMDD-HHMMSS.ts (hora local
 * de inicio). Al terminar un evento se unen, sin recodificar, los segmentos que
 * cubren [inicio - pre_roll, fin] en un MP4 con faststart.
 */
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

const KEEP_MS = 3 * 60 * 1000; // 3 min de búfer: cubre clip máximo + pre-roll + margen
const NAME_RE = /^seg_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ts$/;

const dirFor = (cameraId) => path.join(config.BUFFER_DIR, `cam${cameraId}`);
const patternFor = (cameraId) => path.join(dirFor(cameraId), 'seg_%Y%m%d-%H%M%S.ts');

function parseName(name) {
    const m = name.match(NAME_RE);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Segmentos ordenados con su inicio y fin (el último está en curso: fin = Infinity). */
async function listSegments(cameraId) {
    const dir = dirFor(cameraId);
    let names = [];
    try { names = await fs.readdir(dir); } catch (_) { return []; }
    const segs = names
        .map((name) => ({ name, file: path.join(dir, name), start: parseName(name) }))
        .filter((s) => s.start !== null)
        .sort((a, b) => a.start - b.start);
    segs.forEach((s, i) => { s.end = i + 1 < segs.length ? segs[i + 1].start : Infinity; });
    return segs;
}

/** Selecciona los segmentos que se solapan con [from, to]. Pura (se prueba aparte). */
function selectSegments(segs, from, to) {
    return segs.filter((s) => s.end > from && s.start < to);
}

async function prepare(cameraId) {
    await fs.ensureDir(dirFor(cameraId));
}

async function prune(cameraId, now = Date.now()) {
    const segs = await listSegments(cameraId);
    for (const s of segs) {
        if (s.end !== Infinity && s.end < now - KEEP_MS) {
            await fs.remove(s.file).catch(() => {});
        }
    }
}

async function clear(cameraId) {
    await fs.remove(dirFor(cameraId)).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Monta el clip [from, to] en outFile (.mp4).
 * Espera a que exista un segmento que empiece después de `to` (así el tramo
 * final ya está cerrado); si tarda más de 20 s usa también el segmento en curso.
 * @returns {Promise<boolean>}
 */
async function buildClip({ cameraId, from, to, outFile, codec }) {
    const deadline = Date.now() + 20000;
    let segs = await listSegments(cameraId);
    while (!segs.some((s) => s.start > to) && Date.now() < deadline) {
        await sleep(1000);
        segs = await listSegments(cameraId);
    }
    const chosen = selectSegments(segs, from, to);
    if (!chosen.length) {
        console.warn(`[CLIP] Cámara ${cameraId}: no hay segmentos para el clip.`);
        return false;
    }

    await fs.ensureDir(path.dirname(outFile));
    const listFile = `${outFile}.txt`;
    const lines = chosen.map((s) => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listFile, lines.join('\n'));

    // H.265 no se reproduce en todos los navegadores: se convierte a H.264
    const videoCodec = codec === 'hevc' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'] : ['-c:v', 'copy'];
    const r = await ffmpeg.run([
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        ...videoCodec, '-an', '-movflags', '+faststart', outFile
    ]);
    await fs.remove(listFile).catch(() => {});
    if (r.code !== 0) {
        console.error(`[CLIP] Error al montar clip: ${r.err.trim().split('\n').pop()}`);
        await fs.remove(outFile).catch(() => {});
        return false;
    }
    return true;
}

module.exports = { dirFor, patternFor, parseName, listSegments, selectSegments, prepare, prune, clear, buildClip, KEEP_MS };
