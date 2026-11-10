/**
 * Descarga los modelos YOLOX (Apache-2.0, Megvii) y verifica su SHA-256.
 * Uso: npm run model:download   (o: node scripts/download-model.js yolox_tiny)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0';
const MODELS = {
    yolox_nano: 'c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d',
    yolox_tiny: '427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7'
};
const DIR = path.join(__dirname, '..', 'models');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download(name) {
    const file = path.join(DIR, `${name}.onnx`);
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === MODELS[name]) {
        console.log(`✔ ${name} ya está descargado.`);
        return;
    }
    console.log(`↓ Descargando ${name}...`);
    const res = await fetch(`${BASE}/${name}.onnx`);
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${name}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = sha256(buf);
    if (hash !== MODELS[name]) throw new Error(`Hash incorrecto para ${name} (${hash}). No se guarda.`);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    console.log(`✔ ${name} (${(buf.length / 1048576).toFixed(1)} MB) verificado.`);
}

// --soft: usado en postinstall; un fallo de red no debe romper "npm install"
const soft = process.argv.includes('--soft');

(async () => {
    const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const names = wanted.length ? wanted : Object.keys(MODELS);
    for (const n of names) {
        if (!MODELS[n]) throw new Error(`Modelo desconocido: ${n}. Opciones: ${Object.keys(MODELS).join(', ')}`);
        await download(n);
    }
})().catch((e) => {
    console.error('✖', e.message);
    if (soft) console.error('  Ejecuta "npm run model:download" más tarde.');
    process.exit(soft ? 0 : 1);
});
