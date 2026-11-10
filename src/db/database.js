const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs-extra');
const config = require('../config');
const { runMigrations } = require('./migrations');

let db = null;

function open() {
    if (db) return db;
    fs.ensureDirSync(path.dirname(config.DB_PATH));
    db = new sqlite3.Database(config.DB_PATH);
    return db;
}

function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        open().run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        open().get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function allAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        open().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

async function init(defaultSettings = {}) {
    open();
    // WAL: lecturas y escrituras concurrentes sin bloquearse; NORMAL es seguro con WAL
    await runAsync('PRAGMA journal_mode = WAL');
    await runAsync('PRAGMA synchronous = NORMAL');
    await runAsync('PRAGMA busy_timeout = 5000');
    await runAsync('PRAGMA foreign_keys = ON');

    await runMigrations({ runAsync, getAsync, allAsync });

    for (const [k, v] of Object.entries(defaultSettings)) {
        await runAsync('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);
    }
}

function close() {
    return new Promise((resolve) => {
        if (!db) return resolve();
        db.close(() => {
            db = null;
            resolve();
        });
    });
}

// ==========================================
// EVENTOS
// ==========================================

async function insertEvent({ cameraId, timestamp, localDate, eventType, label, confidence, photoPath, thumbPath, detections, notes = '' }) {
    const createdAt = Date.now();
    const result = await runAsync(
        `INSERT INTO events (camera_id, timestamp, local_date, event_type, label, confidence,
                             photo_path, thumb_path, detections_json, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cameraId, timestamp, localDate, eventType, label, confidence, photoPath, thumbPath || null,
            detections ? JSON.stringify(detections) : null, notes, createdAt]
    );
    return getEvent(result.lastID);
}

function getEvent(id) {
    return getAsync(
        `SELECT e.*, c.name AS camera_name FROM events e
         LEFT JOIN cameras c ON c.id = e.camera_id WHERE e.id = ?`,
        [id]
    );
}

async function setEventVideo(id, videoPath) {
    await runAsync('UPDATE events SET video_path = ? WHERE id = ?', [videoPath, id]);
    return getEvent(id);
}

async function getEvents({ page = 1, limit = 20, date = null, eventType = null, starred = false, cameraId = null } = {}) {
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const where = [];
    const params = [];
    if (date) { where.push('e.local_date = ?'); params.push(date); }
    if (eventType && eventType !== 'all') {
        if (eventType === 'vehicle') {
            where.push(`e.event_type IN ('car','truck','bus','motorcycle','bicycle')`);
        } else if (eventType === 'animal') {
            where.push(`e.event_type IN ('dog','cat','bird','horse')`);
        } else {
            where.push('e.event_type = ?'); params.push(eventType);
        }
    }
    if (starred) where.push('e.is_starred = 1');
    if (cameraId) { where.push('e.camera_id = ?'); params.push(cameraId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRow = await getAsync(`SELECT COUNT(*) AS total FROM events e ${whereSql}`, params);
    const total = countRow ? countRow.total : 0;
    const events = await allAsync(
        `SELECT e.*, c.name AS camera_name FROM events e
         LEFT JOIN cameras c ON c.id = e.camera_id
         ${whereSql} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
        [...params, limit, (page - 1) * limit]
    );

    return { events, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

function getTimelineEvents(sinceMs = Date.now() - 24 * 3600 * 1000) {
    return allAsync(
        `SELECT e.id, e.camera_id, e.timestamp, e.event_type, e.label, e.confidence, e.photo_path,
                e.thumb_path, e.video_path, e.detections_json, e.is_starred, e.created_at, c.name AS camera_name
         FROM events e LEFT JOIN cameras c ON c.id = e.camera_id
         WHERE e.created_at >= ? ORDER BY e.created_at ASC`,
        [sinceMs]
    );
}

async function getStats(today) {
    const row = await getAsync(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(local_date = ?), 0) AS today,
                COALESCE(SUM(local_date = ? AND event_type = 'person'), 0) AS todayPersons,
                MAX(created_at) AS latestAt
         FROM events`,
        [today, today]
    );
    return {
        totalCount: row.total,
        todayCount: row.today,
        todayPersons: row.todayPersons,
        latestAt: row.latestAt || null
    };
}

async function deleteEvent(id) {
    const event = await getEvent(id);
    if (!event) return null;
    await runAsync('DELETE FROM events WHERE id = ?', [id]);
    return event;
}

async function toggleStar(id) {
    const event = await getAsync('SELECT is_starred FROM events WHERE id = ?', [id]);
    if (!event) return null;
    const newState = event.is_starred ? 0 : 1;
    await runAsync('UPDATE events SET is_starred = ? WHERE id = ?', [newState, id]);
    return { id: Number(id), is_starred: newState };
}

// ==========================================
// AJUSTES
// ==========================================

async function getAllSettings() {
    const rows = await allAsync('SELECT key, value FROM settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
}

async function getSetting(key) {
    const row = await getAsync('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : undefined;
}

async function setSettings(obj) {
    // Sin transacción explícita: con una sola conexión compartida, un BEGIN
    // concurrente fallaría. Cada INSERT es atómico por sí mismo.
    for (const [k, v] of Object.entries(obj)) {
        await runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);
    }
}

// ==========================================
// CÁMARAS
// ==========================================

function listCameras() {
    return allAsync('SELECT * FROM cameras ORDER BY id ASC');
}

function getCamera(id) {
    return getAsync('SELECT * FROM cameras WHERE id = ?', [id]);
}

async function createCamera({ name, type, source, transport = 'tcp', roi = null, enabled = 1 }) {
    const r = await runAsync(
        `INSERT INTO cameras (name, type, source, transport, roi_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, type, source, transport, roi ? JSON.stringify(roi) : null, enabled ? 1 : 0, Date.now()]
    );
    return getCamera(r.lastID);
}

async function updateCamera(id, fields) {
    const allowed = { name: 'name', type: 'type', source: 'source', transport: 'transport', roi: 'roi_json', enabled: 'enabled' };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(allowed)) {
        if (fields[k] === undefined) continue;
        let v = fields[k];
        if (k === 'roi') v = v ? JSON.stringify(v) : null;
        if (k === 'enabled') v = v ? 1 : 0;
        sets.push(`${col} = ?`);
        params.push(v);
    }
    if (sets.length) await runAsync(`UPDATE cameras SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return getCamera(id);
}

async function deleteCamera(id) {
    const r = await runAsync('DELETE FROM cameras WHERE id = ?', [id]);
    return r.changes > 0;
}

// ==========================================
// SESIONES
// ==========================================

function createSession({ tokenHash, expiresAt, ip, userAgent }) {
    return runAsync(
        'INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
        [tokenHash, Date.now(), expiresAt, ip || '', (userAgent || '').slice(0, 200)]
    );
}

function getSession(tokenHash) {
    return getAsync('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', [tokenHash, Date.now()]);
}

function deleteSession(tokenHash) {
    return runAsync('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

function deleteAllSessions() {
    return runAsync('DELETE FROM sessions');
}

function purgeExpiredSessions() {
    return runAsync('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
}

module.exports = {
    init, close, runAsync, getAsync, allAsync,
    insertEvent, getEvent, setEventVideo, getEvents, getTimelineEvents, getStats, deleteEvent, toggleStar,
    getAllSettings, getSetting, setSettings,
    listCameras, getCamera, createCamera, updateCamera, deleteCamera,
    createSession, getSession, deleteSession, deleteAllSessions, purgeExpiredSessions
};
