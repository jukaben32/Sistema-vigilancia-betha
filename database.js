const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');

const DB_PATH = path.join(__dirname, 'data', 'vigilancia.sqlite');

// Asegurar directorio data
fs.ensureDirSync(path.join(__dirname, 'data'));

let db = null;

function getDb() {
    if (!db) {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[DB] Error al conectar con SQLite:', err);
            } else {
                console.log('[DB] Conexión establecida con SQLite en:', DB_PATH);
            }
        });
    }
    return db;
}

function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

// Inicializar esquema
async function init() {
    getDb();
    
    // Tabla de eventos
    await runAsync(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL DEFAULT 'person',
            label TEXT NOT NULL DEFAULT 'Persona',
            confidence REAL DEFAULT 0.0,
            photo_path TEXT NOT NULL,
            video_path TEXT,
            notes TEXT,
            is_starred INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    `);

    // Índices para optimizar consultas de galería y dashboard
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`);

    // Tabla de configuración persistente
    await runAsync(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // Valores por defecto de configuración
    const defaultSettings = [
        ['telegram_enabled', 'false'],
        ['telegram_bot_token', ''],
        ['telegram_chat_id', ''],
        ['whatsapp_enabled', 'false'],
        ['whatsapp_phone', ''],
        ['ai_threshold', '0.65'],
        ['target_classes', 'person,car,dog,cat'],
        ['cooldown_seconds', '8'],
        ['retention_days', '15'],
        ['siren_sound_enabled', 'true'],
        ['video_clips_enabled', 'true'],
        ['roi_zone', '{"enabled":false,"x":0,"y":0,"width":100,"height":100}']
    ];

    for (const [k, v] of defaultSettings) {
        await runAsync(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
    }

    console.log('[DB] Base de datos y tablas inicializadas con éxito.');
}

// Insertar evento
async function insertEvent({ timestamp, eventType = 'person', label = 'Persona', confidence = 0.0, photoPath, videoPath = null, notes = '' }) {
    const createdAt = Date.now();
    const result = await runAsync(
        `INSERT INTO events (timestamp, event_type, label, confidence, photo_path, video_path, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [timestamp, eventType, label, confidence, photoPath, videoPath, notes, createdAt]
    );

    return getAsync(`SELECT * FROM events WHERE id = ?`, [result.lastID]);
}

// Obtener eventos con paginación y filtros
async function getEvents({ page = 1, limit = 20, date = null, eventType = null, starred = false }) {
    let whereClauses = [];
    let params = [];

    if (date) {
        whereClauses.push(`timestamp LIKE ?`);
        params.push(`${date}%`);
    }

    if (eventType && eventType !== 'all') {
        whereClauses.push(`event_type = ?`);
        params.push(eventType);
    }

    if (starred) {
        whereClauses.push(`is_starred = 1`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = await getAsync(`SELECT COUNT(*) as total FROM events ${whereSql}`, params);
    const total = countRow ? countRow.total : 0;

    const offset = (page - 1) * limit;
    const events = await allAsync(
        `SELECT * FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return {
        events,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit) || 1
    };
}

// Obtener eventos de las últimas 24h para la línea de tiempo
async function getTimelineEvents(date = null) {
    let sql = `SELECT id, timestamp, event_type, label, confidence, photo_path, is_starred 
               FROM events WHERE created_at >= ? ORDER BY created_at ASC`;
    const since24hAgo = Date.now() - (24 * 60 * 60 * 1000);
    let params = [since24hAgo];

    if (date) {
        sql = `SELECT id, timestamp, event_type, label, confidence, photo_path, is_starred 
               FROM events WHERE timestamp LIKE ? ORDER BY created_at ASC`;
        params = [`${date}%`];
    }

    return allAsync(sql, params);
}

// Obtener estadísticas globales del sistema
async function getStats() {
    const today = new Date().toISOString().split('T')[0];
    
    const todayEvents = await getAsync(
        `SELECT COUNT(*) as count FROM events WHERE timestamp LIKE ?`,
        [`${today}%`]
    );

    const todayPersons = await getAsync(
        `SELECT COUNT(*) as count FROM events WHERE timestamp LIKE ? AND event_type = 'person'`,
        [`${today}%`]
    );

    const totalEvents = await getAsync(`SELECT COUNT(*) as count FROM events`);

    const latestEvent = await getAsync(`SELECT * FROM events ORDER BY id DESC LIMIT 1`);

    return {
        todayCount: todayEvents ? todayEvents.count : 0,
        todayPersons: todayPersons ? todayPersons.count : 0,
        totalCount: totalEvents ? totalEvents.count : 0,
        latestEvent: latestEvent || null
    };
}

// Eliminar evento
async function deleteEvent(id) {
    const event = await getAsync(`SELECT * FROM events WHERE id = ?`, [id]);
    if (!event) return null;

    await runAsync(`DELETE FROM events WHERE id = ?`, [id]);
    return event;
}

// Alternar favorito/estrella
async function toggleStar(id) {
    const event = await getAsync(`SELECT is_starred FROM events WHERE id = ?`, [id]);
    if (!event) return null;

    const newState = event.is_starred ? 0 : 1;
    await runAsync(`UPDATE events SET is_starred = ? WHERE id = ?`, [newState, id]);
    return { id, is_starred: newState };
}

// Configuración
async function getAllSettings() {
    const rows = await allAsync(`SELECT key, value FROM settings`);
    const settings = {};
    rows.forEach(r => {
        settings[r.key] = r.value;
    });
    return settings;
}

async function updateSetting(key, value) {
    await runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, String(value)]);
    return { key, value };
}

async function updateMultipleSettings(obj) {
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null) {
            await updateSetting(k, v);
        }
    }
    return getAllSettings();
}

// Purgar grabaciones antiguas respetando la política de retención
async function cleanupOldEvents(retentionDays = 15) {
    const days = parseInt(retentionDays) || 15;
    const cutoffTimestamp = Date.now() - (days * 24 * 60 * 60 * 1000);

    // No borrar eventos marcados con estrella (favoritos protegidos)
    const oldEvents = await allAsync(
        `SELECT id, photo_path, video_path FROM events WHERE created_at < ? AND is_starred = 0`,
        [cutoffTimestamp]
    );

    let deletedFiles = 0;
    for (const ev of oldEvents) {
        if (ev.photo_path) {
            const fullPhoto = path.join(__dirname, ev.photo_path.replace(/^\//, ''));
            if (fs.existsSync(fullPhoto)) {
                try { fs.unlinkSync(fullPhoto); deletedFiles++; } catch (_) {}
            }
        }
        if (ev.video_path) {
            const fullVideo = path.join(__dirname, ev.video_path.replace(/^\//, ''));
            if (fs.existsSync(fullVideo)) {
                try { fs.unlinkSync(fullVideo); deletedFiles++; } catch (_) {}
            }
        }
    }

    const res = await runAsync(`DELETE FROM events WHERE created_at < ? AND is_starred = 0`, [cutoffTimestamp]);
    console.log(`[RETENCIÓN] Purgados ${res.changes} eventos antiguos (> ${days} días) y ${deletedFiles} archivos.`);
    return { purgedCount: res.changes, deletedFiles };
}

module.exports = {
    init,
    insertEvent,
    getEvents,
    getTimelineEvents,
    getStats,
    deleteEvent,
    toggleStar,
    getAllSettings,
    updateSetting,
    updateMultipleSettings,
    cleanupOldEvents
};
