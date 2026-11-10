/**
 * Motor de eventos: decide cuándo una detección se convierte en un evento.
 *
 * - Filtra por umbral, tipo de objeto y zona ROI de cada cámara.
 * - Exige N frames consecutivos con detección (menos falsos positivos).
 * - Mientras la detección continúa, alarga el evento (y su clip) hasta un máximo.
 * - Respeta el cooldown entre eventos y el modo (armado / en casa / desarmado).
 *
 * No hace E/S: emite 'trigger' (empieza un evento) y 'end' (termina). El
 * tiempo se inyecta, así que se prueba sin esperar (test/eventEngine.test.js).
 */
const EventEmitter = require('events');
const { GROUPS } = require('./yolox');

function inRoi(det, roi) {
    if (!roi || !roi.enabled) return true;
    const [x, y, w, h] = det.bbox;
    const cx = (x + w / 2) * 100;
    const cy = (y + h / 2) * 100;
    return cx >= roi.x && cx <= roi.x + roi.width && cy >= roi.y && cy <= roi.y + roi.height;
}

/** La persona tiene prioridad; si no hay, la de mayor confianza. */
function pickBest(dets) {
    const persons = dets.filter((d) => d.class === 'person');
    const pool = persons.length ? persons : dets;
    return pool.reduce((a, b) => (b.score > a.score ? b : a));
}

class EventEngine extends EventEmitter {
    /**
     * @param {() => object} getSettings  ajustes parseados (store.get())
     * @param {() => {mode: string}} getMode
     */
    constructor({ getSettings, getMode }) {
        super();
        this.getSettings = getSettings;
        this.getMode = getMode;
        this.state = new Map();
    }

    st(cameraId) {
        let s = this.state.get(cameraId);
        if (!s) {
            s = { hits: 0, active: null, lastEndAt: -Infinity };
            this.state.set(cameraId, s);
        }
        return s;
    }

    filter(dets, roi) {
        const s = this.getSettings();
        const allowed = new Set(s.classGroups.flatMap((g) => GROUPS[g] || []));
        return dets.filter((d) => d.score >= s.threshold && allowed.has(d.class) && inRoi(d, roi));
    }

    /**
     * Procesa las detecciones de un frame.
     * @param {{id: number, roi?: object}} camera
     * @returns {Array} detecciones válidas (para dibujarlas en el panel)
     */
    process(camera, dets, now = Date.now()) {
        const s = this.getSettings();
        const mode = this.getMode().mode;
        const st = this.st(camera.id);
        const valid = this.filter(dets, camera.roi);

        if (mode === 'disarmed') {
            st.hits = 0;
            return valid;
        }

        st.hits = valid.length ? st.hits + 1 : 0;

        if (st.active) {
            if (valid.length) {
                st.active.endsAt = Math.min(now + s.postRollMs, st.active.maxEndsAt);
                const best = pickBest(valid);
                if (best.score > st.active.best.score && (best.class === 'person' || st.active.best.class !== 'person')) {
                    st.active.best = best;
                }
            }
            return valid;
        }

        if (st.hits >= s.minConsecutive && now - st.lastEndAt >= s.cooldownMs) {
            st.active = {
                cameraId: camera.id,
                startedAt: now,
                endsAt: now + s.postRollMs,
                maxEndsAt: now + s.maxClipMs,
                best: pickBest(valid),
                detections: valid,
                mode,
                alert: mode === 'armed',
                eventId: null
            };
            this.emit('trigger', st.active);
        }
        return valid;
    }

    /** Cierra los eventos cuyo tiempo terminó. Llamar periódicamente. */
    tick(now = Date.now()) {
        for (const [, st] of this.state) {
            if (st.active && st.active.endsAt <= now) {
                const rec = st.active;
                st.active = null;
                st.lastEndAt = now;
                st.hits = 0;
                this.emit('end', rec);
            }
        }
    }

    hasActive(cameraId) {
        const st = this.state.get(cameraId);
        return Boolean(st && st.active);
    }

    removeCamera(cameraId) {
        this.state.delete(cameraId);
    }
}

module.exports = { EventEngine, inRoi, pickBest };
