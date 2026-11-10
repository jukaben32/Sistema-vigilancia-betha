const test = require('node:test');
const assert = require('node:assert');
const auth = require('../src/auth');
const settings = require('../src/settings');
const { captureWebToAbs, escapeHtml, maskUrl } = require('../src/util');
const { selectSegments, parseName } = require('../src/cameras/recorder');

test('hash scrypt: verifica la correcta y rechaza la incorrecta', async () => {
    const h = await auth.hashPassword('una-clave-larga');
    assert.ok(h.startsWith('scrypt$'));
    assert.strictEqual(await auth.verifyPassword('una-clave-larga', h), true);
    assert.strictEqual(await auth.verifyPassword('otra-clave', h), false);
    assert.strictEqual(await auth.verifyPassword('x', 'basura'), false);
});

test('contraseña mínima', () => {
    assert.ok(auth.validateNewPassword('corta'));
    assert.strictEqual(auth.validateNewPassword('suficiente123'), null);
});

test('límite de intentos por IP', () => {
    const ip = 'test-ip';
    for (let i = 0; i < 5; i++) auth.registerFailure(ip);
    assert.strictEqual(auth.rateLimited(ip), true);
    auth.clearFailures(ip);
    assert.strictEqual(auth.rateLimited(ip), false);
});

test('ajustes: lista blanca, rangos y secretos', () => {
    const { values, errors } = settings.validate({
        ai_threshold: '0.7', admin_password_hash: 'x', cooldown_seconds: '1',
        telegram_bot_token: '', detect_classes: 'person,vehicle', schedule_json: '[{"days":[1],"start":"22:00","end":"06:00","mode":"armed"}]'
    });
    assert.strictEqual(values.ai_threshold, '0.7');
    assert.strictEqual(values.detect_classes, 'person,vehicle');
    assert.ok(errors.admin_password_hash);
    assert.ok(errors.cooldown_seconds);
    assert.ok(!('telegram_bot_token' in values), 'un secreto vacío no se sobrescribe');
    assert.ok(settings.validate({ telegram_bot_token: 'no-es-token' }).errors.telegram_bot_token);
    assert.ok(settings.validate({ detect_classes: 'person,tv' }).errors.detect_classes);
    assert.ok(settings.validate({ schedule_json: '[{"days":[9],"start":"1","end":"2","mode":"x"}]' }).errors.schedule_json);
});

test('la vista pública nunca incluye secretos', () => {
    const view = settings.publicView({ telegram_bot_token: '123:ABC', admin_password_hash: 'scrypt$...' });
    assert.strictEqual(view.telegram_bot_token, undefined);
    assert.strictEqual(view.telegram_bot_token_set, true);
    assert.strictEqual(view.admin_password_hash, undefined);
});

test('rutas de capturas no pueden salirse de la carpeta', () => {
    assert.ok(captureWebToAbs('/captures/2026/11/10/a.jpg'));
    assert.strictEqual(captureWebToAbs('/captures/../data/vigilancia.sqlite'), null);
    assert.strictEqual(captureWebToAbs('/captures/..\\..\\server.js'), null);
    assert.strictEqual(captureWebToAbs('/etc/passwd'), null);
});

test('escape HTML y máscara de URL', () => {
    assert.strictEqual(escapeHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
    assert.strictEqual(maskUrl('rtsp://admin:clave@192.168.1.5:554/s1'), 'rtsp://***:***@192.168.1.5:554/s1');
});

test('selección de segmentos para el clip', () => {
    const t0 = parseName('seg_20261110-101500.ts');
    assert.strictEqual(new Date(t0).getHours(), 10);
    const segs = [0, 2000, 4000, 6000].map((d, i, a) => ({ start: t0 + d, end: i + 1 < a.length ? t0 + a[i + 1] : Infinity }));
    const chosen = selectSegments(segs, t0 + 2500, t0 + 4500);
    assert.deepStrictEqual(chosen.map((s) => s.start - t0), [2000, 4000]);
    assert.strictEqual(parseName('otro.ts'), null);
});
