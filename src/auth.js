/**
 * Autenticación de un único administrador.
 * - Contraseña con hash scrypt (módulo crypto nativo, sin dependencias).
 * - Sesiones con token aleatorio; en la base de datos solo se guarda su SHA-256.
 * - Cookie HttpOnly + SameSite=Strict (+ Secure cuando llega por HTTPS).
 * - Límite de intentos de login por IP.
 */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db/database');
const store = require('./store');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 8;

function scryptAsync(password, salt, { N, r, p, keylen }) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
            err ? reject(err) : resolve(key)
        );
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(password, salt, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, keyB64] = parts;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), {
        N: Number(N), r: Number(r), p: Number(p), keylen: expected.length
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function validateNewPassword(pw) {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`;
    if (pw.length > 200) return 'Contraseña demasiado larga';
    return null;
}

const isSetup = () => Boolean(store.getInternal('admin_password_hash'));

async function setPassword(pw) {
    await store.setInternal('admin_password_hash', await hashPassword(pw));
}

/** Si hay ADMIN_PASSWORD en .env y aún no hay contraseña, la usa. */
async function ensureFromEnv() {
    if (!isSetup() && config.ADMIN_PASSWORD) {
        const err = validateNewPassword(config.ADMIN_PASSWORD);
        if (err) throw new Error(`ADMIN_PASSWORD: ${err}`);
        await setPassword(config.ADMIN_PASSWORD);
        console.log('[AUTH] Contraseña de administrador creada desde ADMIN_PASSWORD.');
    }
}

/** Petición hecha desde este mismo equipo (sin proxy delante). */
function isLocalRequest(req) {
    const a = req.socket.remoteAddress;
    const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
    return loop && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
}

// ==========================================
// LÍMITE DE INTENTOS
// ==========================================
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

function rateLimited(ip) {
    const a = attempts.get(ip);
    if (!a || a.resetAt < Date.now()) return false;
    return a.count >= MAX_ATTEMPTS;
}

function registerFailure(ip) {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    else a.count++;
    if (attempts.size > 10000) attempts.clear();
}

const clearFailures = (ip) => attempts.delete(ip);

// ==========================================
// SESIONES
// ==========================================
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cache = new Map(); // tokenHash -> { expiresAt, checkedAt }
const CACHE_MS = 30 * 1000;

async function createSession(req, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + config.SESSION_DAYS * 24 * 3600 * 1000;
    await db.createSession({ tokenHash: sha256(token), expiresAt, ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(config.COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        maxAge: config.SESSION_DAYS * 24 * 3600 * 1000,
        path: '/'
    });
}

async function destroySession(req, res) {
    const token = req.cookies && req.cookies[config.COOKIE_NAME];
    if (token) {
        const h = sha256(token);
        cache.delete(h);
        await db.deleteSession(h);
    }
    res.clearCookie(config.COOKIE_NAME, { path: '/' });
}

async function destroyAllSessions() {
    cache.clear();
    await db.deleteAllSessions();
}

async function validToken(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return false;
    const h = sha256(token);
    const c = cache.get(h);
    const now = Date.now();
    if (c && now - c.checkedAt < CACHE_MS && c.expiresAt > now) return true;
    const s = await db.getSession(h);
    if (!s) {
        cache.delete(h);
        return false;
    }
    cache.set(h, { expiresAt: s.expires_at, checkedAt: now });
    if (cache.size > 1000) cache.clear();
    return true;
}

function parseCookieHeader(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {}
    }
    return out;
}

// ==========================================
// MIDDLEWARES
// ==========================================

/** Exige sesión. API → 401 JSON; páginas → redirección al login. */
function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies[config.COOKIE_NAME];
    validToken(token)
        .then((ok) => {
            if (ok) return next();
            if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/captures/')) {
                return res.status(401).json({ success: false, error: 'No autenticado' });
            }
            res.redirect('/login.html');
        })
        .catch(next);
}

/**
 * Anti-CSRF: las peticiones que modifican algo deben llevar la cabecera
 * X-Requested-With (un formulario de otro sitio no puede añadirla).
 */
function requireCsrfHeader(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'betha') {
        return res.status(403).json({ success: false, error: 'Falta cabecera anti-CSRF' });
    }
    next();
}

/** Valida la cookie en el upgrade del WebSocket. */
function authenticateUpgrade(req) {
    const cookies = parseCookieHeader(req.headers.cookie);
    return validToken(cookies[config.COOKIE_NAME]);
}

module.exports = {
    hashPassword, verifyPassword, validateNewPassword, isSetup, setPassword, ensureFromEnv, isLocalRequest,
    rateLimited, registerFailure, clearFailures,
    createSession, destroySession, destroyAllSessions, validToken,
    requireAuth, requireCsrfHeader, authenticateUpgrade, parseCookieHeader
};
