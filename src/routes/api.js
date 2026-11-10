const express = require('express');
const db = require('../db/database');
const store = require('../store');
const settings = require('../settings');
const mode = require('../mode');
const ws = require('../ws');
const core = require('../core');
const detector = require('../ai/detector');
const manager = require('../cameras/manager');
const ffmpeg = require('../cameras/ffmpeg');
const retention = require('../retention');
const telegram = require('../alerts/telegram');
const { localDate } = require('../util');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const idParam = (req) => {
    const id = parseInt(req.params.id, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
};

// ==========================================
// EVENTOS
// ==========================================

router.get('/events', wrap(async (req, res) => {
    const { page, limit, date, type, starred, camera } = req.query;
    const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    res.json(await db.getEvents({
        page, limit, date: validDate,
        eventType: typeof type === 'string' ? type.slice(0, 20) : null,
        starred: starred === 'true',
        cameraId: parseInt(camera, 10) || null
    }));
}));

router.get('/events/:id', wrap(async (req, res) => {
    const ev = await db.getEvent(idParam(req));
    if (!ev) return res.status(404).json({ success: false, error: 'Evento no encontrado' });
    res.json(ev);
}));

router.patch('/events/:id/star', wrap(async (req, res) => {
    const updated = await db.toggleStar(idParam(req));
    if (!updated) return res.status(404).json({ success: false, error: 'Evento no encontrado' });
    ws.broadcast('EVENT_STARRED', updated);
    res.json({ success: true, ...updated });
}));

router.delete('/events/:id', wrap(async (req, res) => {
    const event = await db.deleteEvent(idParam(req));
    if (!event) return res.status(404).json({ success: false, error: 'Evento no encontrado' });
    await retention.removeEventFiles(event);
    ws.broadcast('EVENT_DELETED', { id: event.id });
    res.json({ success: true });
}));

router.get('/timeline', wrap(async (req, res) => {
    res.json(await db.getTimelineEvents());
}));

router.get('/stats', wrap(async (req, res) => {
    const stats = await db.getStats(localDate());
    res.json({ ...stats, mode: mode.current(), ai: detector.info() });
}));

// ==========================================
// AJUSTES Y MODO
// ==========================================

router.get('/settings', (req, res) => {
    res.json(settings.publicView(store.raw));
});

router.post('/settings', wrap(async (req, res) => {
    const { values, errors } = settings.validate(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });
    delete values.arm_mode; // el modo se cambia por /api/mode (respeta horarios)
    await store.update(values);
    if (values.model) {
        detector.load(values.model).catch((e) => console.error('[IA]', e.message));
    }
    const view = settings.publicView(store.raw);
    ws.broadcast('SETTINGS_UPDATED', view);
    res.json({ success: true, settings: view });
}));

router.post('/settings/test-telegram', wrap(async (req, res) => {
    const token = (req.body.token || '').trim() || store.get().telegramToken;
    const chatId = (req.body.chatId || '').trim() || store.get().telegramChatId;
    res.json(await telegram.test(token, chatId));
}));

router.get('/mode', (req, res) => res.json(mode.current()));

router.post('/mode', wrap(async (req, res) => {
    const { mode: m, minutes } = req.body || {};
    if (!settings.MODES.includes(m)) return res.status(400).json({ success: false, error: 'Modo no válido' });
    const result = minutes
        ? await mode.setTemporary(m, Math.min(1440, Math.max(1, parseInt(minutes, 10) || 60)) * 60000)
        : await mode.set(m);
    res.json({ success: true, mode: result });
}));

// ==========================================
// CÁMARAS
// ==========================================

function validRoi(r) {
    if (!r || typeof r !== 'object') return null;
    const n = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    const roi = { enabled: Boolean(r.enabled), x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
    if (roi.width < 5 || roi.height < 5) throw new Error('La zona ROI es demasiado pequeña');
    roi.width = Math.min(roi.width, 100 - roi.x);
    roi.height = Math.min(roi.height, 100 - roi.y);
    return roi;
}

async function validateCamera(body, existing = null) {
    const out = {};
    if (body.name !== undefined || !existing) {
        const name = String(body.name || '').trim();
        if (!name || name.length > 40) throw new Error('El nombre debe tener entre 1 y 40 caracteres');
        out.name = name;
    }
    const type = body.type !== undefined ? body.type : existing && existing.type;
    if (!['rtsp', 'dshow'].includes(type)) throw new Error('Tipo de cámara no válido');
    if (body.type !== undefined) out.type = type;

    // Si el panel devuelve la URL enmascarada (***), se conserva la guardada
    const src = body.source !== undefined ? String(body.source).trim() : undefined;
    if (src !== undefined && !(existing && src.includes('***'))) {
        if (type === 'rtsp') {
            if (!src.startsWith('rtsp://') || src.length > 500 || /\s/.test(src)) throw new Error('La URL debe empezar por rtsp:// y no tener espacios');
        } else {
            const devices = await ffmpeg.listDshowDevices();
            if (!devices.includes(src)) throw new Error('Esa webcam no está conectada a este PC');
        }
        out.source = src;
    } else if (!existing) {
        throw new Error('Falta la URL o el dispositivo de la cámara');
    }
    if (body.transport !== undefined) out.transport = body.transport === 'udp' ? 'udp' : 'tcp';
    if (body.roi !== undefined) out.roi = validRoi(body.roi);
    if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
    return out;
}

router.get('/cameras', (req, res) => res.json(manager.list()));

router.post('/cameras', wrap(async (req, res) => {
    if (manager.list().length >= 8) return res.status(400).json({ success: false, error: 'Máximo 8 cámaras' });
    let data;
    try { data = await validateCamera(req.body || {}); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
    const cam = await manager.create({ transport: 'tcp', enabled: true, ...data });
    ws.broadcast('CAMERAS_CHANGED', manager.list());
    res.json({ success: true, camera: cam });
}));

router.patch('/cameras/:id', wrap(async (req, res) => {
    const id = idParam(req);
    const existing = manager.getCamera(id);
    if (!existing) return res.status(404).json({ success: false, error: 'Cámara no encontrada' });
    let data;
    try { data = await validateCamera(req.body || {}, existing); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
    const cam = await manager.update(id, data);
    ws.broadcast('CAMERAS_CHANGED', manager.list());
    res.json({ success: true, camera: cam });
}));

router.delete('/cameras/:id', wrap(async (req, res) => {
    const ok = await manager.remove(idParam(req));
    if (!ok) return res.status(404).json({ success: false, error: 'Cámara no encontrada' });
    ws.broadcast('CAMERAS_CHANGED', manager.list());
    res.json({ success: true });
}));

router.get('/cameras/:id/stream', (req, res) => {
    const p = manager.get(idParam(req));
    if (!p) return res.status(404).send('Cámara no activa');
    p.addClient(req, res, { low: req.query.q === 'low' });
});

router.get('/cameras/:id/snapshot.jpg', (req, res) => {
    const p = manager.get(idParam(req));
    if (!p || !p.latestJpeg) return res.status(404).send('Sin imagen');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(p.latestJpeg);
});

router.post('/cameras/:id/snapshot', wrap(async (req, res) => {
    const event = await core.manualSnapshot(idParam(req));
    if (!event) return res.status(409).json({ success: false, error: 'La cámara no tiene imagen ahora mismo' });
    res.json({ success: true, event });
}));

router.post('/cameras/test-rtsp', wrap(async (req, res) => {
    let url = String((req.body && req.body.url) || '').trim();
    const cam = req.body && req.body.cameraId ? manager.getCamera(parseInt(req.body.cameraId, 10)) : null;
    if (url.includes('***') && cam && cam.type === 'rtsp') url = cam.source;
    res.json(await ffmpeg.testRtsp(url, req.body && req.body.transport));
}));

// ==========================================
// SISTEMA
// ==========================================

router.get('/system/devices', wrap(async (req, res) => {
    res.json({ devices: await ffmpeg.listDshowDevices() });
}));

router.get('/system/info', wrap(async (req, res) => {
    res.json({
        version: require('../../package.json').version,
        ai: detector.info(),
        storage: await retention.usage(),
        uptimeSec: Math.round(process.uptime())
    });
}));

router.post('/cleanup', wrap(async (req, res) => {
    const s = store.get();
    res.json({ success: true, ...(await retention.run(s)) });
}));

module.exports = router;
