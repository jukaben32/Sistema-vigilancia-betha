const test = require('node:test');
const assert = require('node:assert');
const { matchRule, effectiveMode, nextTransition, manualChange } = require('../src/schedule');

// 2026-11-09 es lunes (getDay() === 1)
const at = (day, hh, mm = 0) => new Date(2026, 10, 8 + day, hh, mm); // day 0 = domingo 8 nov
const night = { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', mode: 'armed' };
const office = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', mode: 'home' };

test('franja normal dentro del mismo día', () => {
    assert.strictEqual(matchRule([office], at(1, 9)), office);
    assert.strictEqual(matchRule([office], at(1, 17)), null);  // fin exclusivo
    assert.strictEqual(matchRule([office], at(0, 9)), null);   // domingo no está
});

test('franja que cruza medianoche', () => {
    assert.strictEqual(matchRule([night], at(1, 23)), night);  // lunes 23:00
    assert.strictEqual(matchRule([night], at(2, 5, 59)), night); // martes 05:59 (viene del lunes)
    assert.strictEqual(matchRule([night], at(1, 3)), null);    // lunes 03:00: el domingo no está
    assert.strictEqual(matchRule([night], at(6, 3)), night);   // sábado 03:00: viene del viernes
});

test('prioridad: excepción > horario > manual', () => {
    const s = { armMode: 'disarmed', scheduleEnabled: true, schedule: [night] };
    const now = at(1, 23);
    assert.strictEqual(effectiveMode(s, null, now).mode, 'armed');
    assert.strictEqual(effectiveMode(s, null, now).source, 'schedule');
    const ov = { mode: 'home', until: now.getTime() + 60000 };
    assert.strictEqual(effectiveMode(s, ov, now).mode, 'home');
    const expired = { mode: 'home', until: now.getTime() - 1 };
    assert.strictEqual(effectiveMode(s, expired, now).mode, 'armed');
    assert.strictEqual(effectiveMode({ ...s, scheduleEnabled: false }, null, now).mode, 'disarmed');
});

test('próxima transición del horario', () => {
    const t = nextTransition([night], at(1, 23));
    assert.strictEqual(new Date(t).getTime(), at(2, 6).getTime());
    assert.strictEqual(nextTransition([], at(1, 10)), null);
});

test('cambio manual: con regla activa crea excepción, sin ella cambia el modo base', () => {
    const s = { armMode: 'armed', scheduleEnabled: true, schedule: [night] };
    const during = manualChange(s, 'disarmed', at(1, 23));
    assert.strictEqual(during.armMode, undefined);
    assert.strictEqual(during.override.mode, 'disarmed');
    assert.strictEqual(during.override.until, at(2, 6).getTime());

    const outside = manualChange(s, 'home', at(1, 12));
    assert.deepStrictEqual(outside, { armMode: 'home', override: null });
});
