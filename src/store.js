/**
 * Caché en memoria de los ajustes. El motor de detección los consulta varias
 * veces por segundo, así que no se leen de SQLite en cada frame.
 */
const EventEmitter = require('events');
const db = require('./db/database');
const settings = require('./settings');

class SettingsStore extends EventEmitter {
    constructor() {
        super();
        this.raw = {};
        this.value = settings.parsed({});
    }

    async load() {
        this.raw = await db.getAllSettings();
        this.value = settings.parsed(this.raw);
        return this.value;
    }

    get() {
        return this.value;
    }

    /** Guarda valores ya validados y avisa de las claves que cambiaron. */
    async update(values) {
        const changed = Object.keys(values).filter((k) => this.raw[k] !== values[k]);
        if (!changed.length) return [];
        await db.setSettings(values);
        await this.load();
        this.emit('change', changed);
        return changed;
    }

    /** Claves internas (no validadas por el esquema público). */
    getInternal(key) {
        return this.raw[key];
    }

    async setInternal(key, value) {
        await db.setSettings({ [key]: value });
        this.raw[key] = String(value);
    }
}

module.exports = new SettingsStore();
