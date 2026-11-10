/**
 * Política de retención:
 *  1. Borra eventos más antiguos que N días (salvo los protegidos con estrella).
 *  2. Si captures/ supera el tope de GB, borra los más antiguos no protegidos.
 *  3. Elimina archivos huérfanos (sin evento en la BD) de más de 1 día.
 */
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const db = require('./db/database');
const { captureWebToAbs } = require('./util');

const filesOf = (ev) => [ev.photo_path, ev.thumb_path, ev.video_path].map(captureWebToAbs).filter(Boolean);

async function removeEventFiles(ev) {
    let bytes = 0;
    for (const f of filesOf(ev)) {
        const st = await fs.stat(f).catch(() => null);
        if (st) {
            bytes += st.size;
            await fs.remove(f).catch(() => {});
        }
    }
    return bytes;
}

async function walk(dir, out = []) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, out);
        else if (e.isFile()) {
            const st = await fs.stat(p).catch(() => null);
            if (st) out.push({ file: p, size: st.size, mtime: st.mtimeMs });
        }
    }
    return out;
}

async function removeEmptyDirs(dir, isRoot = true) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), false);
    if (!isRoot && (await fs.readdir(dir).catch(() => ['x'])).length === 0) await fs.rmdir(dir).catch(() => {});
}

async function run({ retentionDays, maxStorageGb }) {
    const result = { byAge: 0, bySize: 0, orphans: 0, freedMb: 0 };
    let freed = 0;

    // 1. Por antigüedad
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const old = await db.allAsync(
        'SELECT id, photo_path, thumb_path, video_path FROM events WHERE created_at < ? AND is_starred = 0', [cutoff]
    );
    for (const ev of old) freed += await removeEventFiles(ev);
    if (old.length) {
        await db.runAsync('DELETE FROM events WHERE created_at < ? AND is_starred = 0', [cutoff]);
        result.byAge = old.length;
    }

    // 2. Por tamaño y 3. huérfanos
    const files = await walk(config.CAPTURES_DIR);
    let total = files.reduce((a, f) => a + f.size, 0);

    const referenced = new Set();
    for (const ev of await db.allAsync('SELECT photo_path, thumb_path, video_path FROM events')) {
        for (const f of filesOf(ev)) referenced.add(path.resolve(f));
    }
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const f of files) {
        if (!referenced.has(path.resolve(f.file)) && f.mtime < dayAgo) {
            await fs.remove(f.file).catch(() => {});
            total -= f.size;
            freed += f.size;
            result.orphans++;
        }
    }

    const cap = maxStorageGb > 0 ? maxStorageGb * 1024 ** 3 : Infinity;
    while (total > cap) {
        const batch = await db.allAsync(
            'SELECT id, photo_path, thumb_path, video_path FROM events WHERE is_starred = 0 ORDER BY created_at ASC LIMIT 100'
        );
        if (!batch.length) break; // solo quedan eventos protegidos
        for (const ev of batch) {
            const b = await removeEventFiles(ev);
            total -= b;
            freed += b;
            await db.runAsync('DELETE FROM events WHERE id = ?', [ev.id]);
            result.bySize++;
            if (total <= cap) break;
        }
    }

    await removeEmptyDirs(config.CAPTURES_DIR);
    result.freedMb = Math.round(freed / 1048576);
    result.usedMb = Math.round(Math.max(0, total) / 1048576);
    if (result.byAge || result.bySize || result.orphans) {
        console.log(`[RETENCIÓN] ${result.byAge} por antigüedad, ${result.bySize} por espacio, ${result.orphans} huérfanos. Liberados ${result.freedMb} MB.`);
    }
    return result;
}

async function usage() {
    const files = await walk(config.CAPTURES_DIR);
    return { usedMb: Math.round(files.reduce((a, f) => a + f.size, 0) / 1048576), files: files.length };
}

module.exports = { run, usage, removeEventFiles };
