require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const moment = require('moment');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const db = require('./database');
const notifications = require('./notifications');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// Directorio base de capturas
const capturesDir = path.join(__dirname, 'captures');
fs.ensureDirSync(capturesDir);

// Configuración de Multer para subida de fotos y videos WebM
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const now = moment();
        const dest = path.join(capturesDir, now.format('YYYY'), now.format('MM'), now.format('DD'));
        await fs.ensureDir(dest);
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        const now = moment();
        const prefix = file.fieldname === 'video' ? 'clip' : 'capture';
        const ext = file.fieldname === 'video' ? '.webm' : '.jpg';
        cb(null, `${prefix}_${now.format('HHmmss')}_${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB max para video
});

// Middlewares
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/captures', express.static(capturesDir));

// WebSocket Server para notificaciones en vivo en el Dashboard
const wss = new WebSocketServer({ server });

function broadcastWs(type, data) {
    const payload = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    // Enviar mensaje de bienvenida
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Conectado al servidor de vigilancia Betha Sentinel' }));
});

// ==========================================
// RUTAS DE LA API REST
// ==========================================

// Guardar Captura (soporta multipart con video y fallback base64)
app.post('/api/save-capture', upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'video', maxCount: 1 }
]), async (req, res) => {
    try {
        let photoPath = '';
        let videoPath = null;
        let photoAbsolutePath = '';

        const timestamp = req.body.timestamp || new Date().toISOString();
        const eventType = req.body.eventType || req.body.event_type || 'person';
        const label = req.body.label || (eventType === 'person' ? 'Persona' : 'Movimiento');
        const confidence = parseFloat(req.body.confidence) || 0.85;
        const notes = req.body.notes || '';

        // Si se subió foto vía multipart
        if (req.files && req.files['photo'] && req.files['photo'][0]) {
            const file = req.files['photo'][0];
            photoAbsolutePath = file.path;
            const relative = path.relative(__dirname, file.path).replace(/\\/g, '/');
            photoPath = `/${relative}`;
        } else if (req.body.image) {
            // Fallback de Base64 existente
            const date = moment(timestamp);
            const dayDir = path.join(capturesDir, date.format('YYYY'), date.format('MM'), date.format('DD'));
            await fs.ensureDir(dayDir);
            const fileName = `capture_${date.format('HHmmss')}_${Date.now()}.jpg`;
            photoAbsolutePath = path.join(dayDir, fileName);

            const base64Data = req.body.image.replace(/^data:image\/[a-z]+;base64,/, '');
            await fs.writeFile(photoAbsolutePath, base64Data, 'base64');
            photoPath = `/captures/${date.format('YYYY')}/${date.format('MM')}/${date.format('DD')}/${fileName}`;
        }

        // Si se subió video clip
        if (req.files && req.files['video'] && req.files['video'][0]) {
            const videoFile = req.files['video'][0];
            const relativeVideo = path.relative(__dirname, videoFile.path).replace(/\\/g, '/');
            videoPath = `/${relativeVideo}`;
        }

        if (!photoPath) {
            return res.status(400).json({ success: false, error: 'No se proporcionó imagen válida' });
        }

        // Registrar en base de datos SQLite
        const savedEvent = await db.insertEvent({
            timestamp,
            eventType,
            label,
            confidence,
            photoPath,
            videoPath,
            notes
        });

        // Difundir en tiempo real a los navegadores abiertos
        broadcastWs('NEW_EVENT', savedEvent);

        // Disparar alertas externas (Telegram Bot / WhatsApp)
        notifications.dispatchAlerts(savedEvent, photoAbsolutePath);

        res.json({
            success: true,
            event: savedEvent
        });
    } catch (error) {
        console.error('[API] Error al guardar captura:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener lista paginada y filtrada de eventos
app.get('/api/events', async (req, res) => {
    try {
        const { page = 1, limit = 20, date, type, starred } = req.query;
        const result = await db.getEvents({
            page,
            limit,
            date: date || null,
            eventType: type || null,
            starred: starred === 'true'
        });
        res.json(result);
    } catch (error) {
        console.error('[API] Error al consultar eventos:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eventos para la línea de tiempo interactiva
app.get('/api/timeline', async (req, res) => {
    try {
        const { date } = req.query;
        const events = await db.getTimelineEvents(date);
        res.json(events);
    } catch (error) {
        console.error('[API] Error al obtener timeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Estadísticas del sistema
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await db.getStats();
        res.json(stats);
    } catch (error) {
        console.error('[API] Error al obtener estadísticas:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Alternar favorito/estrella para proteger evento
app.patch('/api/events/:id/star', async (req, res) => {
    try {
        const updated = await db.toggleStar(req.params.id);
        if (!updated) return res.status(404).json({ success: false, error: 'Evento no encontrado' });
        broadcastWs('EVENT_UPDATED', updated);
        res.json({ success: true, ...updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eliminar un evento y sus archivos asociados
app.delete('/api/events/:id', async (req, res) => {
    try {
        const event = await db.deleteEvent(req.params.id);
        if (!event) return res.status(404).json({ success: false, error: 'Evento no encontrado' });

        // Eliminar archivos del disco
        if (event.photo_path) {
            const p = path.join(__dirname, event.photo_path.replace(/^\//, ''));
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        if (event.video_path) {
            const v = path.join(__dirname, event.video_path.replace(/^\//, ''));
            if (fs.existsSync(v)) fs.unlinkSync(v);
        }

        broadcastWs('EVENT_DELETED', { id: event.id });
        res.json({ success: true });
    } catch (error) {
        console.error('[API] Error al eliminar evento:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener configuraciones del sistema
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await db.getAllSettings();
        // Ocultar parcialmente el token de bot por seguridad si existe
        const safeSettings = { ...settings };
        if (safeSettings.telegram_bot_token && safeSettings.telegram_bot_token.length > 8) {
            safeSettings.telegram_bot_token_masked = safeSettings.telegram_bot_token.slice(0, 4) + '••••••••' + safeSettings.telegram_bot_token.slice(-4);
        }
        res.json(safeSettings);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Guardar configuraciones
app.post('/api/settings', async (req, res) => {
    try {
        const updated = await db.updateMultipleSettings(req.body);
        broadcastWs('SETTINGS_UPDATED', updated);
        res.json({ success: true, settings: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Probar conexión de Telegram
app.post('/api/settings/test-telegram', async (req, res) => {
    try {
        const { token, chatId } = req.body;
        const result = await notifications.testTelegram(token, chatId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ejecutar limpieza manual de retención
app.post('/api/cleanup', async (req, res) => {
    try {
        const settings = await db.getAllSettings();
        const days = req.body.days || settings.retention_days || 15;
        const result = await db.cleanupOldEvents(days);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Compatibilidad con la ruta anterior /api/captures
app.get('/api/captures', async (req, res) => {
    try {
        const result = await db.getEvents({ limit: 100 });
        const legacyFormat = result.events.map(e => ({
            id: e.id,
            path: e.photo_path,
            videoPath: e.video_path,
            timestamp: e.timestamp,
            label: e.label,
            confidence: e.confidence,
            is_starred: e.is_starred
        }));
        res.json(legacyFormat);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ==========================================
// INICIALIZACIÓN Y PROGRAMADOR DE RETENCIÓN
// ==========================================

async function startServer() {
    await db.init();

    // Programar limpieza automática cada 6 horas
    setInterval(async () => {
        try {
            const settings = await db.getAllSettings();
            await db.cleanupOldEvents(settings.retention_days || 15);
        } catch (err) {
            console.error('[CRON] Error en purga de retención:', err);
        }
    }, 6 * 60 * 60 * 1000);

    server.listen(port, () => {
        console.log(`====================================================`);
        console.log(`🛡️  BETHA SENTINEL // SISTEMA DE VIGILANCIA IA ACTIVO`);
        console.log(`📡 Servidor iniciado en: http://localhost:${port}`);
        console.log(`⚡ WebSockets en tiempo real activos`);
        console.log(`💾 Base de datos SQLite inicializada`);
        console.log(`====================================================`);
    });
}

startServer();