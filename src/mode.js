/**
 * Servicio de modo de vigilancia: une ajustes + horario + excepciones y avisa
 * cuando el modo efectivo cambia (por el panel, Telegram o el reloj).
 */
const EventEmitter = require('events');
const store = require('./store');
const schedule = require('./schedule');

class ModeService extends EventEmitter {
    constructor() {
        super();
        this.lastKey = null;
        this.timer = null;
    }

    getOverride() {
        try {
            const o = JSON.parse(store.getInternal('arm_override_json') || 'null');
            return o && o.until > Date.now() ? o : null;
        } catch (_) {
            return null;
        }
    }

    current(now = new Date()) {
        return schedule.effectiveMode(store.get(), this.getOverride(), now);
    }

    /** Cambio manual desde el panel o Telegram. */
    async set(mode) {
        const change = schedule.manualChange(store.get(), mode);
        if (change.armMode) await store.update({ arm_mode: change.armMode });
        await store.setInternal('arm_override_json', JSON.stringify(change.override));
        return this.check();
    }

    /** Excepción temporal (ej. "Desarmar 1 h" desde la alerta de Telegram). */
    async setTemporary(mode, durationMs) {
        await store.setInternal('arm_override_json', JSON.stringify({ mode, until: Date.now() + durationMs }));
        return this.check();
    }

    /** Emite 'change' si el modo efectivo cambió desde la última vez. */
    check() {
        const m = this.current();
        const key = `${m.mode}|${m.source}|${m.until}`;
        if (key !== this.lastKey) {
            this.lastKey = key;
            this.emit('change', m);
        }
        return m;
    }

    start() {
        this.check();
        store.on('change', (keys) => {
            if (keys.some((k) => ['arm_mode', 'schedule_enabled', 'schedule_json'].includes(k))) this.check();
        });
        this.timer = setInterval(() => this.check(), 20 * 1000);
    }

    stop() {
        clearInterval(this.timer);
    }
}

module.exports = new ModeService();
