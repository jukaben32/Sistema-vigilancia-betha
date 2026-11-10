require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

module.exports = {
    ROOT,
    PORT: parseInt(process.env.PORT, 10) || 3000,
    // Por defecto solo escucha en este equipo. Para Tailscale/LAN usar HOST=0.0.0.0
    HOST: process.env.HOST || '127.0.0.1',
    // Activar si el servidor está detrás de un proxy/túnel HTTPS (Cloudflare Tunnel, Caddy...)
    TRUST_PROXY: process.env.TRUST_PROXY === 'true',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
    // URL pública opcional para enlaces en Telegram (ej. https://betha.tu-tailnet.ts.net)
    PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

    DATA_DIR,
    DB_PATH: process.env.DB_PATH || path.join(DATA_DIR, 'vigilancia.sqlite'),
    BUFFER_DIR: path.join(DATA_DIR, 'buffer'),
    CAPTURES_DIR: process.env.CAPTURES_DIR ? path.resolve(process.env.CAPTURES_DIR) : path.join(ROOT, 'captures'),
    PUBLIC_DIR: path.join(ROOT, 'public'),
    MODELS_DIR: path.join(ROOT, 'models'),

    SESSION_DAYS: 30,
    COOKIE_NAME: 'betha_sid'
};
