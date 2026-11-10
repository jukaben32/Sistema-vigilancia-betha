/**
 * Migraciones versionadas con PRAGMA user_version.
 * v1 = esquema original (v2.x del proyecto). v2 = Betha Sentinel v3.
 */
const { localDate } = require('../util');

const migrations = [
    // v1: esquema original (idempotente para bases ya existentes)
    async ({ runAsync }) => {
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
            )`);
        await runAsync(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    },

    // v2: multi-cámara, sesiones, fecha local, miniaturas y detecciones
    async ({ runAsync, allAsync, getAsync }) => {
        const cols = (await allAsync('PRAGMA table_info(events)')).map((c) => c.name);
        const addCol = async (name, def) => {
            if (!cols.includes(name)) await runAsync(`ALTER TABLE events ADD COLUMN ${name} ${def}`);
        };
        await addCol('camera_id', 'INTEGER DEFAULT 1');
        await addCol('local_date', 'TEXT');
        await addCol('thumb_path', 'TEXT');
        await addCol('detections_json', 'TEXT');

        // Rellenar local_date de eventos antiguos (antes se filtraba por fecha UTC)
        const rows = await allAsync('SELECT id, timestamp, created_at FROM events WHERE local_date IS NULL');
        for (const r of rows) {
            const d = new Date(r.created_at || r.timestamp);
            await runAsync('UPDATE events SET local_date = ? WHERE id = ?', [localDate(isNaN(d) ? new Date() : d), r.id]);
        }

        await runAsync('DROP INDEX IF EXISTS idx_events_timestamp');
        await runAsync('CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC)');
        await runAsync('CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)');
        await runAsync('CREATE INDEX IF NOT EXISTS idx_events_local_date ON events(local_date)');
        await runAsync('CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id, created_at DESC)');
        await runAsync('CREATE INDEX IF NOT EXISTS idx_events_starred ON events(is_starred, created_at)');

        await runAsync(`
            CREATE TABLE IF NOT EXISTS cameras (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('rtsp', 'dshow')),
                source TEXT NOT NULL,
                transport TEXT NOT NULL DEFAULT 'tcp',
                roi_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            )`);

        await runAsync(`
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                ip TEXT,
                user_agent TEXT
            )`);
        await runAsync('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)');

        // Migrar la cámara Wi-Fi configurada en v2.1 como cámara 1
        const rtsp = await getAsync(`SELECT value FROM settings WHERE key = 'rtsp_url'`);
        const camCount = await getAsync('SELECT COUNT(*) AS n FROM cameras');
        if (rtsp && rtsp.value && rtsp.value.startsWith('rtsp://') && camCount.n === 0) {
            const tr = await getAsync(`SELECT value FROM settings WHERE key = 'rtsp_transport'`);
            const roi = await getAsync(`SELECT value FROM settings WHERE key = 'roi_zone'`);
            await runAsync(
                `INSERT INTO cameras (id, name, type, source, transport, roi_json, enabled, created_at)
                 VALUES (1, 'Cámara Wi-Fi', 'rtsp', ?, ?, ?, 1, ?)`,
                [rtsp.value, tr && tr.value === 'udp' ? 'udp' : 'tcp', roi ? roi.value : null, Date.now()]
            );
        }

        // Claves obsoletas: ahora viven en la tabla cameras
        await runAsync(`DELETE FROM settings WHERE key IN ('rtsp_url', 'rtsp_transport', 'video_source', 'roi_zone', 'target_classes')`);
    }
];

async function runMigrations(dbh) {
    const { user_version: current } = await dbh.getAsync('PRAGMA user_version');
    for (let v = current; v < migrations.length; v++) {
        await migrations[v](dbh);
        await dbh.runAsync(`PRAGMA user_version = ${v + 1}`);
        console.log(`[DB] Migración aplicada: v${v + 1}`);
    }
}

module.exports = { runMigrations, SCHEMA_VERSION: migrations.length };
