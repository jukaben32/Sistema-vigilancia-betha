const express = require('express');
const auth = require('../auth');
const store = require('../store');

const router = express.Router();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

router.get('/status', async (req, res, next) => {
    try {
        const token = req.cookies && req.cookies[require('../config').COOKIE_NAME];
        res.json({
            setupRequired: !auth.isSetup(),
            canSetup: !auth.isSetup() && auth.isLocalRequest(req),
            authenticated: await auth.validToken(token)
        });
    } catch (e) { next(e); }
});

// Crear la contraseña inicial: solo desde este PC, para que nadie la "reclame" por internet
router.post('/setup', async (req, res, next) => {
    try {
        if (auth.isSetup()) return res.status(409).json({ success: false, error: 'La contraseña ya está creada' });
        if (!auth.isLocalRequest(req)) {
            return res.status(403).json({
                success: false,
                error: 'La contraseña inicial solo se puede crear desde este PC (http://localhost) o con ADMIN_PASSWORD en .env'
            });
        }
        const err = auth.validateNewPassword(req.body.password);
        if (err) return res.status(400).json({ success: false, error: err });
        await auth.setPassword(req.body.password);
        await auth.createSession(req, res);
        res.json({ success: true });
    } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
    try {
        const ip = req.ip;
        if (auth.rateLimited(ip)) {
            return res.status(429).json({ success: false, error: 'Demasiados intentos. Espera un minuto.' });
        }
        const ok = auth.isSetup() && (await auth.verifyPassword(req.body.password, store.getInternal('admin_password_hash')));
        if (!ok) {
            auth.registerFailure(ip);
            await delay(400);
            return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
        }
        auth.clearFailures(ip);
        await auth.createSession(req, res);
        res.json({ success: true });
    } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
    try {
        await auth.destroySession(req, res);
        res.json({ success: true });
    } catch (e) { next(e); }
});

// Cambiar contraseña: cierra todas las sesiones abiertas (incluidas las de otros dispositivos)
router.post('/password', auth.requireAuth, async (req, res, next) => {
    try {
        const { current, next: nextPw } = req.body || {};
        if (auth.rateLimited(req.ip)) return res.status(429).json({ success: false, error: 'Demasiados intentos' });
        if (!(await auth.verifyPassword(current, store.getInternal('admin_password_hash')))) {
            auth.registerFailure(req.ip);
            return res.status(401).json({ success: false, error: 'La contraseña actual no es correcta' });
        }
        const err = auth.validateNewPassword(nextPw);
        if (err) return res.status(400).json({ success: false, error: err });
        await auth.setPassword(nextPw);
        await auth.destroyAllSessions();
        await auth.createSession(req, res);
        res.json({ success: true });
    } catch (e) { next(e); }
});

module.exports = router;
