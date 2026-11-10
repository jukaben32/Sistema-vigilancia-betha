/**
 * Núcleo: conecta detector → motor de eventos → fotos/clips → BD → panel y alertas.
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const db = require('./db/database');
const store = require('./store');
const mode = require('./mode');
const ws = require('./ws');
const detector = require('./ai/detector');
const manager = require('./cameras/manager');
const recorder = require('./cameras/recorder');
const notifications = require('./alerts/notifications');
const { EventEngine } = require('./ai/eventEngine');
const { dayDir, localDate, localTimeCompact, captureWebToAbs } = require('./util');

const engine = new EventEngine({ getSettings: () => store.get(), getMode: () => mode.current() });
let tickTimer = null;

/** Guarda una foto (y su miniatura) en captures/AAAA/MM/DD. */
async function saveJpeg(jpeg, prefix, cameraId, when = new Date()) {
    const dir = dayDir(when);
    await fs.ensureDir(dir.abs);
    const base = `${prefix}_${localTimeCompact(when)}_c${cameraId}_${crypto.randomBytes(3).toString('hex')}`;
    const photoAbs = path.join(dir.abs, `${base}.jpg`);
    const thumbAbs = path.join(dir.abs, `${base}_t.jpg`);
    await fs.writeFile(photoAbs, jpeg);
    let thumbPath = null;
    try {
        await sharp(jpeg).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(thumbAbs);
        thumbPath = `${dir.web}/${base}_t.jpg`;
    } catch (e) {
        console.warn('[CORE] No se pudo crear la miniatura:', e.message);
    }
    return { photoAbs, photoPath: `${dir.web}/${base}.jpg`, thumbPath };
}

async function onTrigger(rec) {
    const pipeline = manager.get(rec.cameraId);
    if (!pipeline || !pipeline.latestJpeg) return;
    const when = new Date(rec.startedAt);
    const { photoAbs, photoPath, thumbPath } = await saveJpeg(pipeline.latestJpeg, 'evt', rec.cameraId, when);
    const event = await db.insertEvent({
        cameraId: rec.cameraId,
        timestamp: when.toISOString(),
        localDate: localDate(when),
        eventType: rec.best.class,
        label: rec.best.label,
        confidence: rec.best.score,
        photoPath,
        thumbPath,
        detections: rec.detections
    });
    rec.eventId = event.id;
    if (!event.camera_name) event.camera_name = (manager.getCamera(rec.cameraId) || {}).name || `Cámara ${rec.cameraId}`;
    console.log(`[EVENTO #${event.id}] ${event.label} ${Math.round(event.confidence * 100)}% en ${event.camera_name} (modo ${rec.mode})`);
    ws.broadcast('NEW_EVENT', { ...event, alert: rec.alert, siren: rec.alert && store.get().sirenEnabled });
    if (rec.alert) notifications.eventAlert(event, photoAbs);
}

async function onEnd(rec) {
    await rec.ready;
    if (!rec.eventId || !store.get().clipsEnabled) return;
    const pipeline = manager.get(rec.cameraId);
    const s = store.get();
    const event = await db.getEvent(rec.eventId);
    if (!event) return;
    const photoAbs = captureWebToAbs(event.photo_path);
    const outFile = photoAbs.replace(/\.jpg$/, '.mp4');
    const ok = await recorder.buildClip({
        cameraId: rec.cameraId,
        from: rec.startedAt - s.preRollMs,
        to: rec.endsAt,
        outFile,
        codec: pipeline ? pipeline.codec : null
    });
    if (!ok) return;
    const videoPath = event.photo_path.replace(/\.jpg$/, '.mp4');
    const updated = await db.setEventVideo(rec.eventId, videoPath);
    ws.broadcast('EVENT_UPDATED', updated);
    console.log(`[EVENTO #${rec.eventId}] Clip listo (${Math.round((rec.endsAt - rec.startedAt + s.preRollMs) / 1000)} s)`);
    if (rec.alert) notifications.clipReady(updated, outFile);
}

function start() {
    detector.on('detections', (cameraId, dets) => {
        const cam = manager.getCamera(cameraId);
        if (!cam) return;
        const valid = engine.process(cam, dets);
        ws.broadcast('DETECTIONS', { cameraId, detections: valid });
    });

    engine.on('trigger', (rec) => {
        rec.ready = onTrigger(rec).catch((e) => console.error('[CORE] Error al registrar evento:', e));
    });
    engine.on('end', (rec) => {
        onEnd(rec).catch((e) => console.error('[CORE] Error al montar clip:', e));
    });
    tickTimer = setInterval(() => engine.tick(), 500);

    manager.on('status', (info) => ws.broadcast('CAMERA_STATUS', info));
    mode.on('change', (m) => ws.broadcast('MODE', m));
}

function stop() {
    clearInterval(tickTimer);
}

/** Captura manual desde el panel (independiente del modo). */
async function manualSnapshot(cameraId) {
    const pipeline = manager.get(cameraId);
    if (!pipeline || !pipeline.latestJpeg) return null;
    const when = new Date();
    const { photoPath, thumbPath } = await saveJpeg(pipeline.latestJpeg, 'man', cameraId, when);
    const event = await db.insertEvent({
        cameraId, timestamp: when.toISOString(), localDate: localDate(when),
        eventType: 'manual', label: 'Captura manual', confidence: 1, photoPath, thumbPath, detections: null
    });
    ws.broadcast('NEW_EVENT', { ...event, alert: false, siren: false });
    return event;
}

// Acciones para el bot de Telegram
const botActions = {
    async status() {
        const stats = await db.getStats(localDate());
        const cameras = manager.list().map((c, i) => ({ index: i + 1, name: c.name, status: c.status }));
        return { mode: mode.current(), cameras, ...stats };
    },
    async snapshot(index) {
        const cam = manager.list()[index - 1];
        const p = cam && manager.get(cam.id);
        return p && p.latestJpeg ? { jpeg: p.latestJpeg, name: cam.name } : null;
    },
    setMode: (m) => mode.set(m),
    setTemporary: (m, ms) => mode.setTemporary(m, ms),
    async lastClip() {
        const ev = await db.getAsync('SELECT id FROM events WHERE video_path IS NOT NULL ORDER BY id DESC LIMIT 1');
        return ev ? botActions.eventClip(ev.id) : null;
    },
    async eventClip(id) {
        const event = await db.getEvent(id);
        if (!event || !event.video_path) return null;
        const file = captureWebToAbs(event.video_path);
        return file && (await fs.pathExists(file)) ? { event, file } : null;
    }
};

module.exports = { start, stop, engine, manualSnapshot, botActions };
