const config = require('./src/config');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const db = require('./src/db/database');
const settings = require('./src/settings');
const store = require('./src/store');
const auth = require('./src/auth');
const mode = require('./src/mode');
const ws = require('./src/ws');
const core = require('./src/core');
const detector = require('./src/ai/detector');
const manager = require('./src/cameras/manager');
const retention = require('./src/retention');
const { TelegramBot } = require('./src/alerts/telegramBot');

const app = express();
const server = http.createServer(app);
if (config.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    hsts: false,                      // se accede por http en LAN/Tailscale; HTTPS lo pone el túnel
    crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ==========================================
// RUTAS PÚBLICAS (login y recursos estáticos sin datos)
// ==========================================
app.get(['/', '/index.html'], auth.requireAuth, (req, res) => {
    res.sendFile(path.join(config.PUBLIC_DIR, 'index.html'));
});
// Sin maxAge: el navegador revalida con ETag y recibe las actualizaciones al instante
app.use(express.static(config.PUBLIC_DIR, { index: false }));

app.use('/api', auth.requireCsrfHeader);
app.use('/api/auth', require('./src/routes/auth'));

// ==========================================
// RUTAS PROTEGIDAS
// ==========================================
app.use('/api', auth.requireAuth, require('./src/routes/api'));
app.use('/captures', auth.requireAuth, express.static(config.CAPTURES_DIR, {
    index: false,
    dotfiles: 'deny',
    immutable: true,
    maxAge: '365d',
    setHeaders: (res) => res.set('Cache-Control', 'private, max-age=31536000, immutable')
}));

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Ruta no encontrada' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'JSON no válido' });
    console.error('[API] Error:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
});

// ==========================================
// ARRANQUE
// ==========================================
let bot = null;
let retentionTimer = null;

async function startServer() {
    await fs.ensureDir(config.CAPTURES_DIR);
    await db.init(settings.defaults());
    await store.load();
    await auth.ensureFromEnv();
    await db.purgeExpiredSessions();

    mode.start();
    ws.init(server);
    core.start();

    try {
        await detector.load(store.get().model);
    } catch (e) {
        console.error(`[IA] ${e.message}`);
    }

    await manager.start();

    bot = new TelegramBot(core.botActions);
    bot.start();

    const runRetention = () => retention.run(store.get()).catch((e) => console.error('[RETENCIÓN]', e.message));
    setTimeout(runRetention, 60 * 1000);
    retentionTimer = setInterval(runRetention, 6 * 3600 * 1000);

    server.listen(config.PORT, config.HOST, () => {
        const shown = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
        console.log('====================================================');
        console.log('🛡️  BETHA SENTINEL v3 // VIGILANCIA IA 24/7');
        console.log(`📡 Panel: http://${shown}:${config.PORT}`);
        console.log(`📹 Cámaras: ${manager.list().length} | 🧠 IA: ${detector.info().status}`);
        if (!auth.isSetup()) console.log(`🔑 Abre http://localhost:${config.PORT} en ESTE PC para crear la contraseña.`);
        if (config.HOST !== '127.0.0.1' && config.HOST !== 'localhost') {
            console.log(`🌐 Escuchando en ${config.HOST}: accesible desde la red. No abras puertos del router; usa Tailscale.`);
        }
        console.log('====================================================');
    });
}

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SISTEMA] ${signal}: cerrando de forma ordenada...`);
    const force = setTimeout(() => process.exit(1), 8000);
    try {
        clearInterval(retentionTimer);
        if (bot) bot.stop();
        mode.stop();
        core.stop();
        manager.stopAll();
        ws.close();
        await new Promise((r) => server.close(r));
        await db.close();
    } finally {
        clearTimeout(force);
        process.exit(0);
    }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer().catch((e) => {
    console.error('[SISTEMA] No se pudo arrancar:', e);
    process.exit(1);
});
