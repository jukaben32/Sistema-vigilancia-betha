/**
 * Modos de vigilancia y horarios semanales (funciones puras, sin E/S).
 *
 *  armed    → registra eventos, graba clips y envía alertas
 *  home     → registra y graba, sin alertas ni sirena
 *  disarmed → no registra nada (la vista en vivo sigue funcionando)
 *
 * Prioridad: excepción temporal (override) > regla de horario > modo manual.
 */

const MODE_LABELS = { armed: 'Armado', home: 'En casa', disarmed: 'Desarmado' };

const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

/** Regla de horario que aplica en `date`, o null. Soporta franjas que cruzan medianoche. */
function matchRule(rules, date) {
    if (!Array.isArray(rules)) return null;
    const day = date.getDay();
    const prevDay = (day + 6) % 7;
    const t = date.getHours() * 60 + date.getMinutes();
    for (const r of rules) {
        const s = toMin(r.start);
        const e = toMin(r.end);
        if (s < e) {
            if (r.days.includes(day) && t >= s && t < e) return r;
        } else {
            // Cruza medianoche: p.ej. 22:00 → 06:00
            if ((r.days.includes(day) && t >= s) || (r.days.includes(prevDay) && t < e)) return r;
        }
    }
    return null;
}

/**
 * Modo efectivo.
 * @param {object} s  { armMode, scheduleEnabled, schedule }
 * @param {object|null} override { mode, until }
 */
function effectiveMode(s, override, now = new Date()) {
    if (override && override.until > now.getTime()) {
        return { mode: override.mode, source: 'override', until: override.until };
    }
    if (s.scheduleEnabled) {
        const r = matchRule(s.schedule, now);
        if (r) return { mode: r.mode, source: 'schedule', until: null };
    }
    return { mode: s.armMode, source: 'manual', until: null };
}

/**
 * Próximo instante (ms) en que cambia la regla de horario que aplica.
 * Busca minuto a minuto hasta 7 días; devuelve null si nunca cambia.
 */
function nextTransition(rules, now = new Date()) {
    const key = (r) => (r ? `${r.mode}|${r.start}|${r.end}|${r.days.join(',')}` : 'none');
    const current = key(matchRule(rules, now));
    const t = new Date(now);
    t.setSeconds(0, 0);
    for (let i = 1; i <= 7 * 24 * 60; i++) {
        t.setMinutes(t.getMinutes() + 1);
        if (key(matchRule(rules, t)) !== current) return t.getTime();
    }
    return null;
}

/**
 * Cuando el usuario cambia de modo a mano (panel o Telegram):
 * - si ninguna regla de horario está mandando ahora → cambia el modo manual
 * - si una regla está mandando → excepción hasta el próximo cambio del horario
 * Devuelve { armMode?, override } con lo que hay que guardar.
 */
function manualChange(s, mode, now = new Date()) {
    if (!s.scheduleEnabled || !matchRule(s.schedule, now)) return { armMode: mode, override: null };
    const until = nextTransition(s.schedule, now) || now.getTime() + 24 * 3600 * 1000;
    return { override: { mode, until } };
}

module.exports = { MODE_LABELS, matchRule, effectiveMode, nextTransition, manualChange };
