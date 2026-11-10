const test = require('node:test');
const assert = require('node:assert');
const { EventEngine, inRoi, pickBest } = require('../src/ai/eventEngine');

const base = {
    threshold: 0.5, classGroups: ['person', 'vehicle'], minConsecutive: 2,
    cooldownMs: 10000, postRollMs: 5000, maxClipMs: 20000
};
const person = (score = 0.9, bbox = [0.4, 0.4, 0.2, 0.2]) => ({ class: 'person', label: 'Persona', score, bbox });
const dog = { class: 'dog', label: 'Perro', score: 0.95, bbox: [0.1, 0.1, 0.1, 0.1] };

function make(over = {}, modeName = 'armed') {
    const s = { ...base, ...over };
    let m = modeName;
    const e = new EventEngine({ getSettings: () => s, getMode: () => ({ mode: m }) });
    const triggers = [];
    const ends = [];
    e.on('trigger', (r) => triggers.push(r));
    e.on('end', (r) => ends.push(r));
    return { e, triggers, ends, setMode: (x) => { m = x; } };
}
const cam = { id: 1, roi: null };

test('exige N frames consecutivos', () => {
    const { e, triggers } = make();
    e.process(cam, [person()], 0);
    assert.strictEqual(triggers.length, 0);
    e.process(cam, [], 250);           // se rompe la racha
    e.process(cam, [person()], 500);
    assert.strictEqual(triggers.length, 0);
    e.process(cam, [person()], 750);
    assert.strictEqual(triggers.length, 1);
});

test('filtra umbral y clases no activadas', () => {
    const { e, triggers } = make({ minConsecutive: 1 });
    assert.deepStrictEqual(e.process(cam, [person(0.3), dog], 0), []);
    assert.strictEqual(triggers.length, 0);
});

test('el evento se alarga mientras sigue la detección, con tope', () => {
    const { e, triggers, ends } = make({ minConsecutive: 1 });
    e.process(cam, [person()], 0);
    assert.strictEqual(triggers[0].endsAt, 5000);
    e.process(cam, [person()], 3000);
    assert.strictEqual(triggers[0].endsAt, 8000);
    e.process(cam, [person()], 19000);
    assert.strictEqual(triggers[0].endsAt, 20000); // maxClipMs
    e.tick(19999);
    assert.strictEqual(ends.length, 0);
    e.tick(20000);
    assert.strictEqual(ends.length, 1);
});

test('cooldown entre eventos se cuenta desde el final', () => {
    const { e, triggers } = make({ minConsecutive: 1 });
    e.process(cam, [person()], 0);
    e.tick(5000);
    e.process(cam, [person()], 9000);
    assert.strictEqual(triggers.length, 1);
    e.process(cam, [person()], 15000);
    assert.strictEqual(triggers.length, 2);
});

test('modos: desarmado no dispara, en casa dispara sin alerta', () => {
    const { e, triggers, setMode } = make({ minConsecutive: 1 }, 'disarmed');
    e.process(cam, [person()], 0);
    assert.strictEqual(triggers.length, 0);
    setMode('home');
    e.process(cam, [person()], 100);
    assert.strictEqual(triggers.length, 1);
    assert.strictEqual(triggers[0].alert, false);
});

test('cámaras independientes', () => {
    const { e, triggers } = make({ minConsecutive: 1 });
    e.process({ id: 1 }, [person()], 0);
    e.process({ id: 2 }, [person()], 0);
    assert.strictEqual(triggers.length, 2);
});

test('ROI por el centro de la caja', () => {
    const roi = { enabled: true, x: 0, y: 0, width: 50, height: 50 };
    assert.strictEqual(inRoi(person(0.9, [0.1, 0.1, 0.2, 0.2]), roi), true);
    assert.strictEqual(inRoi(person(0.9, [0.6, 0.6, 0.2, 0.2]), roi), false);
    assert.strictEqual(inRoi(person(0.9, [0.6, 0.6, 0.2, 0.2]), { ...roi, enabled: false }), true);
});

test('la persona tiene prioridad al elegir la detección principal', () => {
    const car = { class: 'car', score: 0.99, bbox: [0, 0, 0.1, 0.1] };
    assert.strictEqual(pickBest([car, person(0.6)]).class, 'person');
    assert.strictEqual(pickBest([car]).class, 'car');
});
