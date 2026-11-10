/**
 * Esquema de ajustes: valores por defecto, validación (lista blanca) y vista
 * pública sin secretos. Todo lo que no esté aquí no se puede escribir por la API.
 */

const CLASS_GROUPS = ['person', 'vehicle', 'animal'];
const MODES = ['armed', 'home', 'disarmed'];
const MODELS = ['yolox_nano', 'yolox_tiny'];

const bool = (v) => {
    if (v === true || v === 'true' || v === 1 || v === '1') return 'true';
    if (v === false || v === 'false' || v === 0 || v === '0') return 'false';
    throw new Error('debe ser verdadero/falso');
};
const num = (min, max, { int = false } = {}) => (v) => {
    const n = int ? parseInt(v, 10) : parseFloat(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`debe estar entre ${min} y ${max}`);
    return String(n);
};
const oneOf = (list) => (v) => {
    if (!list.includes(v)) throw new Error(`valor no permitido (${list.join(', ')})`);
    return v;
};
const str = (max, re) => (v) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw new Error(`máximo ${max} caracteres`);
    if (s && re && !re.test(s)) throw new Error('formato no válido');
    return s;
};

function validateSchedule(v) {
    const rules = typeof v === 'string' ? JSON.parse(v || '[]') : v;
    if (!Array.isArray(rules) || rules.length > 20) throw new Error('lista de horarios no válida');
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const clean = rules.map((r) => {
        if (!r || !Array.isArray(r.days) || !r.days.length) throw new Error('cada horario necesita días');
        const days = [...new Set(r.days.map((d) => parseInt(d, 10)))];
        if (days.some((d) => !(d >= 0 && d <= 6))) throw new Error('días válidos: 0 (domingo) a 6 (sábado)');
        if (!hhmm.test(r.start) || !hhmm.test(r.end)) throw new Error('horas en formato HH:MM');
        if (r.start === r.end) throw new Error('inicio y fin no pueden ser iguales');
        if (!MODES.includes(r.mode)) throw new Error('modo de horario no válido');
        return { days: days.sort(), start: r.start, end: r.end, mode: r.mode };
    });
    return JSON.stringify(clean);
}

function validateClasses(v) {
    const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new Error('elige al menos un tipo de objeto');
    for (const c of list) if (!CLASS_GROUPS.includes(c)) throw new Error(`clase no permitida: ${c}`);
    return [...new Set(list)].join(',');
}

// clave -> [valor por defecto, validador, secreto?]
const SCHEMA = {
    telegram_enabled: ['false', bool],
    telegram_bot_token: ['', str(100, /^\d+:[A-Za-z0-9_-]+$/), true],
    telegram_chat_id: ['', str(32, /^-?\d+$/)],
    telegram_send_clips: ['true', bool],
    whatsapp_enabled: ['false', bool],
    whatsapp_phone: ['', str(20, /^\+?\d{8,15}$/)],

    model: ['yolox_nano', oneOf(MODELS)],
    ai_threshold: ['0.55', num(0.25, 0.95)],
    detect_classes: ['person,vehicle,animal', validateClasses],
    detection_fps: ['4', num(1, 10)],
    min_consecutive_frames: ['2', num(1, 10, { int: true })],
    cooldown_seconds: ['15', num(3, 600, { int: true })],

    video_clips_enabled: ['true', bool],
    pre_roll_seconds: ['5', num(0, 20, { int: true })],
    post_roll_seconds: ['10', num(3, 60, { int: true })],
    max_clip_seconds: ['60', num(10, 120, { int: true })],

    retention_days: ['15', num(1, 365, { int: true })],
    max_storage_gb: ['20', num(0, 10000)],

    siren_sound_enabled: ['true', bool],
    arm_mode: ['armed', oneOf(MODES)],
    schedule_enabled: ['false', bool],
    schedule_json: ['[]', validateSchedule]
};

// Claves internas: existen en la tabla pero nunca se exponen ni se aceptan por la API
const INTERNAL_KEYS = ['admin_password_hash', 'arm_override_json'];

function defaults() {
    const out = {};
    for (const [k, [def]] of Object.entries(SCHEMA)) out[k] = def;
    return out;
}

/**
 * Valida un objeto de ajustes recibido por la API.
 * - Rechaza claves desconocidas.
 * - Un secreto vacío significa "no cambiar".
 * Devuelve { values, errors }.
 */
function validate(input) {
    const values = {};
    const errors = {};
    if (!input || typeof input !== 'object') return { values, errors: { _: 'cuerpo no válido' } };

    for (const [k, v] of Object.entries(input)) {
        const def = SCHEMA[k];
        if (!def) { errors[k] = 'clave no permitida'; continue; }
        const [, validator, secret] = def;
        if (secret && (v === '' || v === null || v === undefined)) continue;
        if (v === null || v === undefined) continue;
        try {
            values[k] = validator(v);
        } catch (e) {
            errors[k] = e.message;
        }
    }
    return { values, errors };
}

/** Vista para el navegador: sin secretos ni claves internas. */
function publicView(all) {
    const out = {};
    for (const [k, [def, , secret]] of Object.entries(SCHEMA)) {
        const v = all[k] !== undefined ? all[k] : def;
        if (secret) out[`${k}_set`] = Boolean(v);
        else out[k] = v;
    }
    return out;
}

/** Ajustes con tipos nativos para uso interno. */
function parsed(all) {
    const g = (k) => (all[k] !== undefined ? all[k] : SCHEMA[k][0]);
    let schedule = [];
    try { schedule = JSON.parse(g('schedule_json')); } catch (_) {}
    return {
        telegramEnabled: g('telegram_enabled') === 'true',
        telegramToken: g('telegram_bot_token'),
        telegramChatId: g('telegram_chat_id'),
        telegramSendClips: g('telegram_send_clips') === 'true',
        whatsappEnabled: g('whatsapp_enabled') === 'true',
        whatsappPhone: g('whatsapp_phone'),
        model: g('model'),
        threshold: parseFloat(g('ai_threshold')),
        classGroups: g('detect_classes').split(',').filter(Boolean),
        detectionFps: parseFloat(g('detection_fps')),
        minConsecutive: parseInt(g('min_consecutive_frames'), 10),
        cooldownMs: parseInt(g('cooldown_seconds'), 10) * 1000,
        clipsEnabled: g('video_clips_enabled') === 'true',
        preRollMs: parseInt(g('pre_roll_seconds'), 10) * 1000,
        postRollMs: parseInt(g('post_roll_seconds'), 10) * 1000,
        maxClipMs: parseInt(g('max_clip_seconds'), 10) * 1000,
        retentionDays: parseInt(g('retention_days'), 10),
        maxStorageGb: parseFloat(g('max_storage_gb')),
        sirenEnabled: g('siren_sound_enabled') === 'true',
        armMode: g('arm_mode'),
        scheduleEnabled: g('schedule_enabled') === 'true',
        schedule
    };
}

module.exports = { SCHEMA, INTERNAL_KEYS, CLASS_GROUPS, MODES, MODELS, defaults, validate, publicView, parsed, validateSchedule };
