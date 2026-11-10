/**
 * Prueba de extremo a extremo SIN webcam: una cámara de prueba que emite
 * test/fixtures/dog.jpg en bucle. Comprueba FFmpeg → IA → evento → foto,
 * miniatura → clip MP4 con pre-evento.
 *
 * Uso: node test/e2e.js   (usa carpetas temporales, no toca data/ ni captures/)
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betha-e2e-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.CAPTURES_DIR = path.join(tmp, 'captures');

const db = require('../src/db/database');
const settings = require('../src/settings');
const store = require('../src/store');
const mode = require('../src/mode');
const core = require('../src/core');
const detector = require('../src/ai/detector');
const manager = require('../src/cameras/manager');
const ffmpeg = require('../src/cameras/ffmpeg');
const { captureWebToAbs } = require('../src/util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`FALLO: ${msg}`); console.log(`  ✔ ${msg}`); };

(async () => {
    console.log(`Carpeta temporal: ${tmp}`);
    await db.init(settings.defaults());
    await store.load();
    // El perro nunca sale de cuadro: el evento se alarga hasta max_clip_seconds
    await store.update({ pre_roll_seconds: '3', post_roll_seconds: '3', max_clip_seconds: '10', cooldown_seconds: '60' });
    mode.start();
    core.start();
    await detector.load('yolox_nano');

    let detections = 0;
    detector.on('detections', (id, d) => { if (d.length) detections++; });

    // Cámara de prueba fuera de la BD (tipo interno 'test')
    const cam = { id: 99, name: 'Prueba', type: 'test', source: path.join(__dirname, 'fixtures', 'dog.jpg'), roi: { enabled: false } };
    manager.cameras.set(99, cam);
    await manager.startCamera(99);

    // Esperar: online → evento → fin (3 s post) → clip
    let event = null;
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        event = await db.getAsync('SELECT * FROM events WHERE camera_id = 99 ORDER BY id DESC LIMIT 1');
        if (event && event.video_path) break;
    }

    const p = manager.get(99);
    assert(p.status === 'online', `cámara online (${p.srcW}x${p.srcH})`);
    assert(detections > 0, `la IA detecta objetos (${detections} frames, ${detector.info().avgMs} ms/frame)`);
    assert(event, `se registró un evento: ${event && event.label} ${event && Math.round(event.confidence * 100)}%`);
    assert(['dog', 'car', 'bicycle', 'truck'].includes(event.event_type), 'clase esperada para dog.jpg');
    assert(fs.existsSync(captureWebToAbs(event.photo_path)), 'foto guardada');
    assert(fs.existsSync(captureWebToAbs(event.thumb_path)), 'miniatura guardada');
    assert(event.video_path && fs.existsSync(captureWebToAbs(event.video_path)), 'clip MP4 montado');

    const probe = await ffmpeg.run(['-i', captureWebToAbs(event.video_path), '-f', 'null', '-']);
    const dur = (probe.err.match(/time=(\d+):(\d+):([\d.]+)/g) || []).pop();
    console.log(`  · ffmpeg pudo leer el clip (código ${probe.code}) ${dur || ''}`);
    assert(probe.code === 0, 'el clip es un MP4 válido');

    manager.stopAll();
    core.stop();
    mode.stop();
    await db.close();
    console.log('\nE2E OK');
    process.exit(0);
})().catch(async (e) => {
    console.error(e);
    manager.stopAll();
    process.exit(1);
});
