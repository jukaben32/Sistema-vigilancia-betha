const path = require('path');
const config = require('./config');

const pad = (n) => String(n).padStart(2, '0');

/** Fecha local YYYY-MM-DD (hora del equipo, no UTC). */
function localDate(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Hora local HHMMSS para nombres de archivo. */
function localTimeCompact(d = new Date()) {
    return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Carpeta del día dentro de captures/ y su ruta web. */
function dayDir(d = new Date()) {
    const parts = [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
    return {
        abs: path.join(config.CAPTURES_DIR, ...parts),
        web: '/captures/' + parts.join('/')
    };
}

/**
 * Convierte una ruta web /captures/... en absoluta, garantizando que no
 * se salga de la carpeta de capturas. Devuelve null si no es válida.
 */
function captureWebToAbs(webPath) {
    if (typeof webPath !== 'string' || !webPath.startsWith('/captures/')) return null;
    const rel = webPath.slice('/captures/'.length);
    const abs = path.resolve(config.CAPTURES_DIR, rel);
    const base = path.resolve(config.CAPTURES_DIR) + path.sep;
    return abs.startsWith(base) ? abs : null;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Oculta usuario:clave de una URL (para logs y para la API). */
const maskUrl = (url) => String(url || '').replace(/\/\/[^@/]*@/, '//***:***@');

module.exports = { localDate, localTimeCompact, dayDir, captureWebToAbs, escapeHtml, maskUrl, pad };
