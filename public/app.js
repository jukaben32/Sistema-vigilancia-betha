/**
 * BETHA SENTINEL v3 — Panel de control.
 * La IA corre en el servidor; aquí solo se muestra el vídeo, se dibujan las
 * detecciones que llegan por WebSocket y se gestionan eventos y ajustes.
 * Todo el texto dinámico se inserta con textContent (sin innerHTML con datos).
 */
(function () {
    'use strict';

    // ==========================================
    // UTILIDADES
    // ==========================================
    const $ = (id) => document.getElementById(id);
    const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

    function el(tag, attrs = {}, ...children) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k === 'dataset') Object.assign(n.dataset, v);
            else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c);
        return n;
    }
    const icon = (name, extra = '') => el('i', { class: `bi bi-${name} ${extra}`.trim() });

    async function api(method, url, body) {
        const opts = { method, headers: { 'X-Requested-With': 'betha' } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(url, opts);
        if (res.status === 401) {
            location.href = '/login.html';
            throw new Error('Sesión caducada');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data.error || (data.errors ? Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join(' · ') : `Error ${res.status}`);
            throw new Error(msg);
        }
        return data;
    }

    function toast(text, kind = 'secondary') {
        const t = el('div', { class: `toast align-items-center text-bg-${kind} border-0`, role: 'status' },
            el('div', { class: 'd-flex' },
                el('div', { class: 'toast-body', text }),
                el('button', { type: 'button', class: 'btn-close btn-close-white me-2 m-auto', 'data-bs-dismiss': 'toast', 'aria-label': 'Cerrar' })));
        $('toastContainer').append(t);
        const bt = new bootstrap.Toast(t, { delay: 3500 });
        t.addEventListener('hidden.bs.toast', () => t.remove());
        bt.show();
    }

    const store = {
        get(k, def) { try { const v = localStorage.getItem(`betha.${k}`); return v === null ? def : JSON.parse(v); } catch (_) { return def; } },
        set(k, v) { try { localStorage.setItem(`betha.${k}`, JSON.stringify(v)); } catch (_) {} }
    };

    const fmtTime = (iso) => new Date(iso).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const fmtDateTime = (iso) => new Date(iso).toLocaleString('es-DO', { hour12: false });
    const MODE_LABELS = { armed: 'ARMADO', home: 'EN CASA', disarmed: 'DESARMADO' };
    const TYPE_ICONS = { person: 'person-fill', manual: 'camera', car: 'car-front-fill', truck: 'truck', bus: 'bus-front', motorcycle: 'bicycle', bicycle: 'bicycle', dog: 'bug-fill', cat: 'bug-fill', bird: 'feather', horse: 'bug-fill' };

    // ==========================================
    // ESTADO
    // ==========================================
    const state = {
        settings: {},
        cameras: new Map(),      // id -> { data, tile, img, canvas, roiEl, dets, detTs, roiEdit }
        mode: null,
        page: 1,
        filter: 'all',
        cameraFilter: '',
        selected: null,
        layout: store.get('layout', 2),
        quality: store.get('quality', 'high'),
        sound: store.get('sound', true),
        storage: null
    };

    const imageModal = new bootstrap.Modal($('imagePreviewModal'));
    const settingsModal = new bootstrap.Modal($('settingsModal'));

    // ==========================================
    // SIRENA (Web Audio, sin archivos)
    // ==========================================
    let audioCtx = null;
    function playSiren() {
        if (!state.sound) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            for (let i = 0; i < 3; i++) {
                const t = audioCtx.currentTime + i * 0.4;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(880, t);
                osc.frequency.exponentialRampToValueAtTime(1760, t + 0.15);
                osc.frequency.exponentialRampToValueAtTime(880, t + 0.3);
                gain.gain.setValueAtTime(0.12, t);
                gain.gain.exponentialRampToValueAtTime(0.01, t + 0.35);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(t);
                osc.stop(t + 0.36);
            }
        } catch (_) { /* el navegador bloquea audio hasta la primera interacción */ }
    }
    document.addEventListener('click', () => {
        if (!audioCtx) try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }, { once: true });

    function renderSound() {
        $('btnToggleSound').className = `btn btn-sm ${state.sound ? 'btn-outline-cyan' : 'btn-outline-secondary'}`;
        $('soundIcon').className = `bi ${state.sound ? 'bi-volume-up' : 'bi-volume-mute'}`;
    }
    $('btnToggleSound').addEventListener('click', () => {
        state.sound = !state.sound;
        store.set('sound', state.sound);
        renderSound();
    });

    // ==========================================
    // RELOJ, STATS, MODO
    // ==========================================
    setInterval(() => {
        $('hudClock').textContent = new Date().toLocaleTimeString('es-DO', { hour12: false });
    }, 1000);

    async function loadStats() {
        try {
            const s = await api('GET', '/api/stats');
            $('statTodayPersons').textContent = s.todayPersons;
            $('statTodayEvents').textContent = s.todayCount;
            if (s.latestAt) {
                const min = Math.round((Date.now() - s.latestAt) / 60000);
                $('statLatestAlert').textContent = min < 1 ? 'Hace un instante' : min < 60 ? `Hace ${min} min` : `Hace ${Math.round(min / 60)} h`;
            } else {
                $('statLatestAlert').textContent = 'Ninguna';
            }
            renderAi(s.ai);
            renderMode(s.mode);
        } catch (e) { console.warn(e); }
    }

    function renderAi(ai) {
        const elAi = $('aiEngineStatus');
        if (!ai) return;
        if (ai.status === 'activa') {
            const model = (ai.model || '').replace('yolox_', 'YOLOX-').replace('nano', 'Nano').replace('tiny', 'Tiny');
            elAi.textContent = `IA: ${model}${ai.avgMs ? ` · ${ai.avgMs} ms` : ''}`;
            elAi.className = 'text-emerald';
        } else {
            elAi.textContent = `IA: ${ai.status}`;
            elAi.className = 'text-warning';
        }
    }

    async function loadStorage() {
        try {
            const info = await api('GET', '/api/system/info');
            state.storage = info.storage;
            renderStorage();
            renderAi(info.ai);
        } catch (_) {}
    }
    function renderStorage() {
        if (!state.storage) return;
        const used = state.storage.usedMb >= 1024 ? `${(state.storage.usedMb / 1024).toFixed(1)} GB` : `${state.storage.usedMb} MB`;
        const cap = parseFloat(state.settings.max_storage_gb || 0);
        $('statStorage').textContent = cap > 0 ? `${used} / ${cap} GB` : used;
        $('storageInfo').textContent = `En uso: ${used} en ${state.storage.files} archivos · retención ${state.settings.retention_days || '?'} días`;
    }

    function renderMode(m) {
        if (!m) return;
        state.mode = m;
        qsa('.btn-mode').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === m.mode);
            b.dataset.active = b.dataset.mode === m.mode ? m.mode : '';
        });
        const hint = $('modeHint');
        let text = '';
        if (m.source === 'schedule') text = `Modo ${MODE_LABELS[m.mode]} por horario`;
        if (m.source === 'override' && m.until) {
            text = `Modo ${MODE_LABELS[m.mode]} temporal hasta las ${new Date(m.until).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`;
        }
        hint.textContent = text;
        hint.className = `mode-hint small text-center font-mono mode-${m.mode}${text ? ' show' : ''}`;
        document.body.dataset.mode = m.mode;
    }

    qsa('.btn-mode').forEach((b) => b.addEventListener('click', async () => {
        try {
            const r = await api('POST', '/api/mode', { mode: b.dataset.mode });
            renderMode(r.mode);
        } catch (e) { toast(e.message, 'danger'); }
    }));

    $('btnLogout').addEventListener('click', async () => {
        try { await api('POST', '/api/auth/logout'); } catch (_) {}
        location.href = '/login.html';
    });

    // ==========================================
    // CÁMARAS EN VIVO
    // ==========================================
    function streamUrl(id) {
        return `/api/cameras/${id}/stream${state.quality === 'low' ? '?q=low' : ''}`;
    }

    function setLayout(n) {
        state.layout = n;
        store.set('layout', n);
        $('cameraGrid').dataset.layout = String(n);
        qsa('[data-layout]').forEach((b) => b.tagName === 'BUTTON' && b.classList.toggle('active', b.dataset.layout === String(n)));
    }
    qsa('button[data-layout]').forEach((b) => b.addEventListener('click', () => setLayout(parseInt(b.dataset.layout, 10))));

    function renderQuality() {
        $('qualityText').textContent = state.quality === 'low' ? 'Baja' : 'Alta';
        $('btnQuality').classList.toggle('active', state.quality === 'low');
    }
    $('btnQuality').addEventListener('click', () => {
        state.quality = state.quality === 'low' ? 'high' : 'low';
        store.set('quality', state.quality);
        renderQuality();
        for (const [id, c] of state.cameras) if (c.data.enabled) c.img.src = streamUrl(id);
    });

    async function loadCameras() {
        const list = await api('GET', '/api/cameras');
        renderCameras(list);
    }

    function renderCameras(list) {
        const grid = $('cameraGrid');
        const ids = new Set(list.map((c) => c.id));
        for (const [id, c] of state.cameras) {
            if (!ids.has(id)) {
                c.img.src = '';
                c.tile.remove();
                state.cameras.delete(id);
            }
        }
        for (const cam of list) {
            const existing = state.cameras.get(cam.id);
            if (existing) {
                const wasEnabled = existing.data.enabled;
                existing.data = cam;
                if (cam.enabled && !wasEnabled) existing.img.src = streamUrl(cam.id);
                if (!cam.enabled) existing.img.src = '';
                updateTile(existing);
            } else {
                const c = createTile(cam);
                state.cameras.set(cam.id, c);
                grid.append(c.tile);
            }
        }
        $('cameraEmpty').classList.toggle('d-none', list.length > 0);
        $('camCountBadge').textContent = list.length;
        renderCameraFilter(list);
        renderCameraList(list);
    }

    function createTile(cam) {
        const tile = $('cameraTileTemplate').content.firstElementChild.cloneNode(true);
        const c = {
            data: cam, tile,
            img: tile.querySelector('.tile-img'),
            canvas: tile.querySelector('.tile-canvas'),
            roiEl: tile.querySelector('.tile-roi'),
            view: tile.querySelector('.tile-view'),
            dets: [], detTs: 0, roiEdit: null
        };
        tile.dataset.id = cam.id;
        if (cam.enabled && document.visibilityState === 'visible') c.img.src = streamUrl(cam.id);
        c.img.addEventListener('error', () => {
            // El stream se corta si el servidor se reinicia: reintentar
            setTimeout(() => { if (c.data.enabled && document.visibilityState === 'visible') c.img.src = streamUrl(cam.id) + (state.quality === 'low' ? '&' : '?') + 'r=' + Date.now(); }, 3000);
        });

        tile.querySelector('[data-act="snapshot"]').addEventListener('click', async () => {
            try {
                await api('POST', `/api/cameras/${cam.id}/snapshot`);
                toast('Captura guardada', 'success');
            } catch (e) { toast(e.message, 'danger'); }
        });
        tile.querySelector('[data-act="fullscreen"]').addEventListener('click', () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else c.view.requestFullscreen().catch(() => {});
        });
        tile.querySelector('[data-act="roi"]').addEventListener('click', () => startRoiEdit(c));
        tile.querySelector('[data-roi="save"]').addEventListener('click', () => saveRoi(c, true));
        tile.querySelector('[data-roi="disable"]').addEventListener('click', () => saveRoi(c, false));
        tile.querySelector('[data-roi="cancel"]').addEventListener('click', () => endRoiEdit(c));
        setupRoiDrag(c);
        updateTile(c);
        return c;
    }

    function updateTile(c) {
        const cam = c.data;
        const t = c.tile;
        t.querySelector('.tile-name').textContent = cam.name;
        const badge = t.querySelector('.tile-status');
        const status = cam.enabled ? cam.status : 'disabled';
        const labels = { online: 'EN VIVO', starting: 'CONECTANDO', offline: 'SIN SEÑAL', stopped: 'DETENIDA', disabled: 'DESACTIVADA' };
        badge.textContent = labels[status] || status;
        badge.className = `tile-status badge ${status === 'online' ? 'bg-danger' : status === 'starting' ? 'bg-warning text-dark' : 'bg-secondary'}`;
        if (status === 'online') badge.prepend(el('span', { class: 'blink-dot' }));
        const codec = ['h264', 'hevc'].includes(cam.codec) ? ` ${cam.codec === 'hevc' ? 'H.265' : 'H.264'}` : '';
        t.querySelector('.tile-info').textContent = cam.width ? `${cam.width}×${cam.height}${codec}` : '';
        const off = t.querySelector('.tile-offline');
        off.classList.toggle('show', status !== 'online');
        t.querySelector('.tile-offline-text').textContent =
            status === 'disabled' ? 'Cámara desactivada' :
            status === 'offline' ? (cam.lastError ? `Sin señal: ${cam.lastError}` : 'Sin señal, reintentando…') :
            'Conectando…';
        const roiBtn = t.querySelector('[data-act="roi"]');
        roiBtn.classList.toggle('btn-outline-cyan', Boolean(cam.roi && cam.roi.enabled));
        roiBtn.classList.toggle('btn-outline-secondary', !(cam.roi && cam.roi.enabled));
    }

    // Pausar los streams cuando la pestaña no se ve (ahorra datos móviles)
    document.addEventListener('visibilitychange', () => {
        for (const [id, c] of state.cameras) {
            if (document.visibilityState === 'visible') { if (c.data.enabled) c.img.src = streamUrl(id); }
            else c.img.src = '';
        }
    });

    /** Rectángulo real de la imagen dentro del contenedor (object-fit: contain). */
    function contentRect(img, box) {
        const nw = img.naturalWidth || 16;
        const nh = img.naturalHeight || 9;
        const cw = box.clientWidth;
        const ch = box.clientHeight;
        const s = Math.min(cw / nw, ch / nh);
        const w = nw * s;
        const h = nh * s;
        return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    }

    // Bucle de dibujo de detecciones y ROI (~12 fps)
    let lastDraw = 0;
    function drawLoop(ts) {
        requestAnimationFrame(drawLoop);
        if (ts - lastDraw < 80) return;
        lastDraw = ts;
        const now = Date.now();
        for (const c of state.cameras.values()) {
            const { canvas, img, view } = c;
            const W = view.clientWidth;
            const H = view.clientHeight;
            if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, W, H);
            const r = contentRect(img, view);
            positionRoi(c, r);
            if (now - c.detTs > 1500 || !c.dets.length) continue;
            for (const d of c.dets) drawBox(ctx, d, r);
        }
    }
    requestAnimationFrame(drawLoop);

    function drawBox(ctx, d, r) {
        const [bx, by, bw, bh] = d.bbox;
        const x = r.x + bx * r.w;
        const y = r.y + by * r.h;
        const w = bw * r.w;
        const h = bh * r.h;
        const isPerson = d.class === 'person';
        const color = isPerson ? '#10b981' : '#06b6d4';
        const text = `${d.label.toUpperCase()} ${Math.round(d.score * 100)}%`;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.strokeRect(x, y, w, h);
        ctx.shadowBlur = 0;
        ctx.font = 'bold 11px "JetBrains Mono", monospace';
        const tw = ctx.measureText(text).width;
        const ty = y - 18 < r.y ? y : y - 18;
        ctx.fillStyle = color;
        ctx.fillRect(x, ty, tw + 10, 18);
        ctx.fillStyle = '#022c22';
        ctx.fillText(text, x + 5, ty + 13);
        ctx.restore();
    }

    // ==========================================
    // EDITOR DE ZONA ROI (arrastrar y redimensionar)
    // ==========================================
    function currentRoi(c) {
        return c.roiEdit || c.data.roi || { enabled: false, x: 10, y: 10, width: 80, height: 80 };
    }

    function positionRoi(c, r) {
        const roi = currentRoi(c);
        const visible = Boolean(c.roiEdit) || Boolean(roi.enabled);
        c.roiEl.classList.toggle('show', visible);
        c.roiEl.classList.toggle('editing', Boolean(c.roiEdit));
        if (!visible) return;
        c.roiEl.style.left = `${r.x + (roi.x / 100) * r.w}px`;
        c.roiEl.style.top = `${r.y + (roi.y / 100) * r.h}px`;
        c.roiEl.style.width = `${(roi.width / 100) * r.w}px`;
        c.roiEl.style.height = `${(roi.height / 100) * r.h}px`;
    }

    function startRoiEdit(c) {
        const r = c.data.roi || {};
        c.roiEdit = { enabled: true, x: r.x ?? 10, y: r.y ?? 10, width: r.width ?? 80, height: r.height ?? 80 };
        c.tile.classList.add('roi-editing');
    }

    function endRoiEdit(c) {
        c.roiEdit = null;
        c.tile.classList.remove('roi-editing');
    }

    async function saveRoi(c, enabled) {
        const roi = { ...currentRoi(c), enabled };
        try {
            const r = await api('PATCH', `/api/cameras/${c.data.id}`, { roi });
            c.data = { ...c.data, ...r.camera };
            endRoiEdit(c);
            updateTile(c);
            toast(enabled ? 'Zona de detección guardada' : 'Zona desactivada: se vigila toda la imagen', 'success');
        } catch (e) { toast(e.message, 'danger'); }
    }

    function setupRoiDrag(c) {
        let drag = null;
        c.roiEl.addEventListener('pointerdown', (e) => {
            if (!c.roiEdit) return;
            e.preventDefault();
            c.roiEl.setPointerCapture(e.pointerId);
            drag = {
                mode: e.target.classList.contains('roi-handle') ? 'resize' : 'move',
                sx: e.clientX, sy: e.clientY, start: { ...c.roiEdit },
                rect: contentRect(c.img, c.view)
            };
        });
        c.roiEl.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = ((e.clientX - drag.sx) / drag.rect.w) * 100;
            const dy = ((e.clientY - drag.sy) / drag.rect.h) * 100;
            const s = drag.start;
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
            if (drag.mode === 'move') {
                c.roiEdit.x = clamp(s.x + dx, 0, 100 - s.width);
                c.roiEdit.y = clamp(s.y + dy, 0, 100 - s.height);
            } else {
                c.roiEdit.width = clamp(s.width + dx, 5, 100 - s.x);
                c.roiEdit.height = clamp(s.height + dy, 5, 100 - s.y);
            }
        });
        const end = () => { drag = null; };
        c.roiEl.addEventListener('pointerup', end);
        c.roiEl.addEventListener('pointercancel', end);
    }

    function flashAlert(cameraId, text) {
        const c = state.cameras.get(cameraId);
        if (!c) return;
        const banner = c.tile.querySelector('.tile-alert');
        banner.querySelector('span').textContent = text;
        banner.classList.add('show');
        c.tile.classList.add('alerting');
        setTimeout(() => { banner.classList.remove('show'); c.tile.classList.remove('alerting'); }, 4000);
    }

    // ==========================================
    // WEBSOCKET
    // ==========================================
    let ws = null;
    let wsRetry = 1000;
    function connectWs() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/ws`);
        ws.onopen = () => {
            wsRetry = 1000;
            $('wsStatus').textContent = 'EN LÍNEA';
            $('wsIndicator').className = 'pulse-dot active';
            refreshAll();
        };
        ws.onclose = () => {
            $('wsStatus').textContent = 'RECONECTANDO…';
            $('wsIndicator').className = 'pulse-dot';
            setTimeout(async () => {
                // Si la sesión caducó, ir al login en vez de reintentar sin fin
                try { await api('GET', '/api/mode'); } catch (_) { return; }
                connectWs();
            }, wsRetry);
            wsRetry = Math.min(wsRetry * 2, 15000);
        };
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }
            const d = msg.data;
            switch (msg.type) {
                case 'DETECTIONS': {
                    const c = state.cameras.get(d.cameraId);
                    if (c) { c.dets = d.detections; c.detTs = Date.now(); }
                    break;
                }
                case 'NEW_EVENT':
                    onNewEvent(d);
                    break;
                case 'EVENT_UPDATED':
                    onEventUpdated(d);
                    break;
                case 'EVENT_STARRED':
                    onEventStarred(d);
                    break;
                case 'EVENT_DELETED':
                    qsa(`.capture-card[data-id="${Number(d.id)}"]`).forEach((n) => n.remove());
                    loadStats(); loadTimeline();
                    break;
                case 'CAMERA_STATUS': {
                    const c = state.cameras.get(d.id);
                    if (c) { c.data = { ...c.data, ...d, name: c.data.name }; updateTile(c); }
                    break;
                }
                case 'CAMERAS_CHANGED':
                    renderCameras(d);
                    break;
                case 'MODE':
                    renderMode(d);
                    break;
                case 'SETTINGS_UPDATED':
                    state.settings = d;
                    renderStorage();
                    break;
            }
        };
    }

    function onNewEvent(event) {
        if (state.page === 1 && matchesFilter(event)) {
            $('captureGallery').querySelector('.gallery-empty')?.remove();
            $('captureGallery').prepend(createEventCard(event));
        }
        if (event.event_type !== 'manual') {
            flashAlert(event.camera_id, `${event.label.toUpperCase()} ${Math.round(event.confidence * 100)}%`);
            if (event.siren) playSiren();
        }
        loadStats();
        loadTimeline();
    }

    function onEventUpdated(event) {
        const card = document.querySelector(`.capture-card[data-id="${Number(event.id)}"]`);
        if (card) card.replaceWith(createEventCard(event));
        if (state.selected && state.selected.id === event.id) {
            state.selected = event;
            renderModalMedia(event, !$('videoViewerContainer').classList.contains('d-none'));
        }
    }

    function onEventStarred(d) {
        const btn = document.querySelector(`.star-btn-card[data-id="${Number(d.id)}"]`);
        if (btn) {
            btn.classList.toggle('starred', Boolean(d.is_starred));
            btn.replaceChildren(icon(d.is_starred ? 'star-fill' : 'star'));
        }
        if (state.selected && state.selected.id === d.id) {
            state.selected.is_starred = d.is_starred;
            renderStar(d.is_starred);
        }
    }

    // ==========================================
    // GALERÍA
    // ==========================================
    const GROUPS = { vehicle: ['car', 'truck', 'bus', 'motorcycle', 'bicycle'], animal: ['dog', 'cat', 'bird', 'horse'] };
    function matchesFilter(ev) {
        if (state.cameraFilter && String(ev.camera_id) !== state.cameraFilter) return false;
        if ($('dateFilter').value) return false; // con fecha fijada no se insertan eventos en vivo
        switch (state.filter) {
            case 'all': return true;
            case 'starred': return Boolean(ev.is_starred);
            case 'vehicle':
            case 'animal': return GROUPS[state.filter].includes(ev.event_type);
            default: return ev.event_type === state.filter;
        }
    }

    async function loadEvents() {
        const params = new URLSearchParams({ page: state.page, limit: 12 });
        if (state.filter === 'starred') params.set('starred', 'true');
        else if (state.filter !== 'all') params.set('type', state.filter);
        if ($('dateFilter').value) params.set('date', $('dateFilter').value);
        if (state.cameraFilter) params.set('camera', state.cameraFilter);
        try {
            const data = await api('GET', `/api/events?${params}`);
            const gallery = $('captureGallery');
            gallery.replaceChildren();
            $('galleryCountBadge').textContent = data.total;
            $('pageIndicator').textContent = `Página ${data.page} / ${data.totalPages}`;
            $('btnPrevPage').disabled = data.page <= 1;
            $('btnNextPage').disabled = data.page >= data.totalPages;
            if (!data.events.length) {
                gallery.append(el('div', { class: 'gallery-empty text-center py-5 text-secondary' },
                    icon('inbox', 'display-6 d-block mb-2'),
                    el('p', { class: 'small mb-0', text: 'No hay eventos para esta selección.' })));
                return;
            }
            data.events.forEach((ev) => gallery.append(createEventCard(ev)));
        } catch (e) { console.warn(e); }
    }

    function createEventCard(ev) {
        const isPerson = ev.event_type === 'person';
        const thumb = el('img', { class: 'capture-thumb', src: ev.thumb_path || ev.photo_path, alt: '', loading: 'lazy' });
        const star = el('button', {
            class: `star-btn-card${ev.is_starred ? ' starred' : ''}`, dataset: { id: ev.id }, title: 'Proteger del borrado automático',
            'aria-label': 'Proteger',
            onclick: async (e) => {
                e.stopPropagation();
                try { await api('PATCH', `/api/events/${ev.id}/star`); } catch (err) { toast(err.message, 'danger'); }
            }
        }, icon(ev.is_starred ? 'star-fill' : 'star'));
        const card = el('div', { class: 'capture-card', dataset: { id: ev.id }, tabindex: '0', role: 'button' },
            el('div', { class: 'capture-thumb-box' }, thumb,
                ev.video_path ? el('span', { class: 'video-indicator-badge' }, icon('play-circle-fill', 'me-1'), 'CLIP') : null),
            el('div', { class: 'capture-details' },
                el('span', { class: `capture-event-title ${isPerson ? 'text-emerald' : 'text-cyan'}` },
                    icon(TYPE_ICONS[ev.event_type] || 'bullseye'),
                    el('span', { text: ev.label }),
                    ev.event_type !== 'manual' ? el('span', { class: 'badge bg-dark border border-secondary text-secondary font-mono', text: `${Math.round(ev.confidence * 100)}%` }) : null),
                el('span', { class: 'capture-time' }, icon('clock', 'me-1'), fmtTime(ev.timestamp)),
                el('span', { class: 'capture-cam', text: ev.camera_name || `Cámara ${ev.camera_id}` })),
            star);
        const open = () => showEvent(ev);
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        return card;
    }

    qsa('[data-filter]').forEach((b) => b.addEventListener('click', () => {
        qsa('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
        state.filter = b.dataset.filter;
        state.page = 1;
        loadEvents();
    }));
    $('cameraFilter').addEventListener('change', () => { state.cameraFilter = $('cameraFilter').value; state.page = 1; loadEvents(); });
    $('dateFilter').addEventListener('change', () => { state.page = 1; loadEvents(); });
    $('clearFilter').addEventListener('click', () => { $('dateFilter').value = ''; state.page = 1; loadEvents(); });
    $('btnPrevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadEvents(); } });
    $('btnNextPage').addEventListener('click', () => { state.page++; loadEvents(); });

    function renderCameraFilter(list) {
        const sel = $('cameraFilter');
        const current = sel.value;
        sel.replaceChildren(el('option', { value: '', text: 'Todas las cámaras' }),
            ...list.map((c) => el('option', { value: String(c.id), text: c.name })));
        sel.value = list.some((c) => String(c.id) === current) ? current : '';
    }

    // ==========================================
    // VISOR FORENSE
    // ==========================================
    async function showEvent(evIn) {
        let ev = evIn;
        if (!ev.photo_path || ev.detections_json === undefined) {
            try { ev = await api('GET', `/api/events/${evIn.id}`); } catch (e) { return toast(e.message, 'danger'); }
        }
        state.selected = ev;
        $('modalTitle').textContent = `Evento #${ev.id}`;
        $('modalEventBadge').textContent = ev.label.toUpperCase();
        $('modalEventBadge').className = ev.event_type === 'person' ? 'badge bg-danger' : 'badge bg-info text-dark';
        $('modalConfidence').textContent = ev.event_type === 'manual' ? '—' : `${Math.round(ev.confidence * 100)}%`;
        $('imageTimestamp').textContent = fmtDateTime(ev.timestamp);
        $('modalCamera').textContent = ev.camera_name || `Cámara ${ev.camera_id}`;
        renderStar(ev.is_starred);
        renderModalMedia(ev, false);
        imageModal.show();
    }

    function renderModalMedia(ev, showVideo) {
        const img = $('previewImage');
        img.onload = () => drawPreviewBoxes(ev);
        img.src = ev.photo_path;
        $('btnViewVideo').disabled = ev.event_type === 'manual';
        const video = $('previewVideo');
        if (ev.video_path) {
            if (!video.src.endsWith(ev.video_path)) video.src = ev.video_path;
            video.classList.remove('d-none');
            $('clipPending').classList.add('d-none');
        } else {
            video.removeAttribute('src');
            video.classList.add('d-none');
            $('clipPending').classList.remove('d-none');
        }
        setViewer(showVideo);
    }

    function drawPreviewBoxes(ev) {
        const img = $('previewImage');
        const canvas = $('previewCanvas');
        canvas.width = img.clientWidth;
        canvas.height = img.clientHeight;
        canvas.style.left = `${img.offsetLeft}px`;
        canvas.style.top = `${img.offsetTop}px`;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let dets = [];
        try { dets = JSON.parse(ev.detections_json || '[]') || []; } catch (_) {}
        const r = { x: 0, y: 0, w: canvas.width, h: canvas.height };
        dets.forEach((d) => drawBox(ctx, d, r));
    }

    function setViewer(video) {
        $('photoViewerContainer').classList.toggle('d-none', video);
        $('videoViewerContainer').classList.toggle('d-none', !video);
        $('btnViewPhoto').classList.toggle('active', !video);
        $('btnViewVideo').classList.toggle('active', video);
        const ev = state.selected;
        const url = video && ev && ev.video_path ? ev.video_path : ev && ev.photo_path;
        $('downloadLink').href = url || '#';
        $('downloadLink').setAttribute('download', url ? url.split('/').pop() : '');
        const v = $('previewVideo');
        if (video && ev && ev.video_path) v.play().catch(() => {});
        else v.pause();
    }
    $('btnViewPhoto').addEventListener('click', () => setViewer(false));
    $('btnViewVideo').addEventListener('click', () => setViewer(true));
    $('imagePreviewModal').addEventListener('hidden.bs.modal', () => { $('previewVideo').pause(); state.selected = null; });
    $('imagePreviewModal').addEventListener('shown.bs.modal', () => state.selected && drawPreviewBoxes(state.selected));

    function renderStar(on) {
        $('modalProtectedStatus').textContent = on ? 'PROTEGIDO' : 'NORMAL';
        $('modalProtectedStatus').className = on ? 'text-warning fw-bold' : 'text-emerald';
        $('starIcon').className = on ? 'bi bi-star-fill text-warning me-1' : 'bi bi-star me-1';
        $('starText').textContent = on ? 'Protegido' : 'Proteger';
    }
    $('btnModalStar').addEventListener('click', async () => {
        if (!state.selected) return;
        try { await api('PATCH', `/api/events/${state.selected.id}/star`); } catch (e) { toast(e.message, 'danger'); }
    });
    $('btnModalDelete').addEventListener('click', async () => {
        if (!state.selected) return;
        if (!confirm('¿Eliminar definitivamente este evento, su foto y su clip?')) return;
        try {
            await api('DELETE', `/api/events/${state.selected.id}`);
            imageModal.hide();
            toast('Evento eliminado', 'secondary');
        } catch (e) { toast(e.message, 'danger'); }
    });

    // ==========================================
    // LÍNEA DE TIEMPO
    // ==========================================
    function renderTimelineMarkers() {
        const now = Date.now();
        const marks = [];
        for (let i = 6; i >= 0; i--) {
            const t = new Date(now - i * 4 * 3600 * 1000);
            marks.push(el('span', { text: i === 0 ? 'Ahora' : t.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: false }) }));
        }
        $('timelineMarkers').replaceChildren(...marks);
    }

    async function loadTimeline() {
        try {
            const events = await api('GET', '/api/timeline');
            renderTimelineMarkers();
            const track = $('timelineTrack');
            track.replaceChildren();
            $('timelineStats').textContent = `${events.length} evento(s)`;
            const start = Date.now() - 24 * 3600 * 1000;
            for (const ev of events) {
                const pct = Math.max(0, Math.min(100, ((ev.created_at - start) / (24 * 3600 * 1000)) * 100));
                const pin = el('button', {
                    class: `timeline-pin ${ev.event_type === 'person' ? '' : 'type-motion'}`,
                    title: `${ev.label} · ${ev.camera_name || ''} · ${fmtTime(ev.timestamp)}`,
                    'aria-label': `${ev.label} ${fmtTime(ev.timestamp)}`,
                    onclick: () => showEvent(ev)
                });
                pin.style.left = `${pct}%`;
                track.append(pin);
            }
        } catch (e) { console.warn(e); }
    }

    // ==========================================
    // AJUSTES
    // ==========================================
    async function loadSettings() {
        state.settings = await api('GET', '/api/settings');
        renderStorage();
    }

    function fillSettings() {
        const s = state.settings;
        qsa('[data-setting]').forEach((input) => {
            const v = s[input.dataset.setting];
            if (v === undefined) return;
            if (input.type === 'checkbox') input.checked = v === 'true';
            else if (input.dataset.scale) input.value = Math.round(parseFloat(v) * parseFloat(input.dataset.scale));
            else input.value = v;
            updateRangeLabel(input);
        });
        $('telegramToken').value = '';
        $('telegramToken').placeholder = s.telegram_bot_token_set ? '•••••••• (guardado; escribe uno nuevo para cambiarlo)' : '123456789:ABCdef…';
        $('telegramTokenHint').textContent = s.telegram_bot_token_set ? 'Token guardado en el servidor. Por seguridad no se muestra.' : '';
        const groups = (s.detect_classes || '').split(',');
        qsa('.class-group').forEach((cb) => { cb.checked = groups.includes(cb.value); });
        let rules = [];
        try { rules = JSON.parse(s.schedule_json || '[]'); } catch (_) {}
        renderRules(rules);
        $('settingsError').textContent = '';
    }

    function updateRangeLabel(input) {
        const label = document.querySelector(`[data-label-for="${input.id}"]`);
        if (label) label.textContent = `${input.value}${input.dataset.suffix || ''}`;
    }
    qsa('input[type="range"][data-setting]').forEach((r) => r.addEventListener('input', () => updateRangeLabel(r)));

    function collectSettings() {
        const out = {};
        qsa('[data-setting]').forEach((input) => {
            const k = input.dataset.setting;
            if (input.type === 'checkbox') out[k] = input.checked ? 'true' : 'false';
            else if (input.dataset.scale) out[k] = String(parseFloat(input.value) / parseFloat(input.dataset.scale));
            else out[k] = String(input.value).trim();
        });
        const token = $('telegramToken').value.trim();
        if (token) out.telegram_bot_token = token;
        out.detect_classes = qsa('.class-group').filter((c) => c.checked).map((c) => c.value).join(',');
        out.schedule_json = JSON.stringify(collectRules());
        return out;
    }

    $('btnSaveSettings').addEventListener('click', async () => {
        $('settingsError').textContent = '';
        try {
            const r = await api('POST', '/api/settings', collectSettings());
            state.settings = r.settings;
            fillSettings();
            renderStorage();
            toast('Ajustes guardados', 'success');
        } catch (e) {
            $('settingsError').textContent = e.message;
        }
    });

    function openSettings(tab) {
        fillSettings();
        hideCameraForm();
        loadStorage();
        settingsModal.show();
        if (tab) bootstrap.Tab.getOrCreateInstance(document.querySelector(`[data-bs-target="#${tab}"]`)).show();
    }
    $('btnOpenSettings').addEventListener('click', () => openSettings());
    $('btnAddFirstCamera').addEventListener('click', () => { openSettings('tabCameras'); showCameraForm(null); });

    $('btnTestTelegram').addEventListener('click', async () => {
        const out = $('telegramTestResult');
        out.textContent = 'Enviando…';
        out.className = 'small text-warning';
        try {
            const r = await api('POST', '/api/settings/test-telegram', { token: $('telegramToken').value.trim(), chatId: $('telegramChatId').value.trim() });
            out.textContent = r.success ? '¡Mensaje enviado!' : `Error: ${r.error}`;
            out.className = r.success ? 'small text-emerald fw-bold' : 'small text-danger';
        } catch (e) {
            out.textContent = e.message;
            out.className = 'small text-danger';
        }
    });

    $('btnManualCleanup').addEventListener('click', async () => {
        if (!confirm('¿Aplicar ahora la retención (días y espacio máximo)? Los eventos protegidos se conservan.')) return;
        try {
            const r = await api('POST', '/api/cleanup');
            toast(`Purga: ${r.byAge + r.bySize} evento(s), ${r.orphans} archivo(s) huérfano(s), ${r.freedMb} MB liberados`, 'success');
            loadEvents(); loadStats(); loadTimeline(); loadStorage();
        } catch (e) { toast(e.message, 'danger'); }
    });

    $('passwordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const out = $('pwResult');
        try {
            await api('POST', '/api/auth/password', { current: $('pwCurrent').value, next: $('pwNext').value });
            out.textContent = 'Contraseña cambiada';
            out.className = 'small ms-2 text-emerald';
            e.target.reset();
        } catch (err) {
            out.textContent = err.message;
            out.className = 'small ms-2 text-danger';
        }
    });

    // ---------- Horario ----------
    const DAY_NAMES = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    function ruleRow(rule = { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', mode: 'armed' }) {
        const days = el('div', { class: 'btn-group btn-group-sm rule-days', role: 'group' },
            ...DAY_NAMES.map((n, i) => el('button', {
                type: 'button', class: `btn btn-filter${rule.days.includes(i) ? ' active' : ''}`, dataset: { day: i }, text: n,
                onclick: (e) => e.currentTarget.classList.toggle('active')
            })));
        const mode = el('select', { class: 'form-select form-select-sm bg-dark border-secondary text-white rule-mode', 'aria-label': 'Modo' },
            ...Object.entries({ armed: 'Armado', home: 'En casa', disarmed: 'Desarmado' }).map(([v, t]) => el('option', { value: v, text: t, selected: v === rule.mode })));
        return el('div', { class: 'rule-row d-flex flex-wrap align-items-center gap-2 p-2 rounded border border-secondary' },
            days,
            el('input', { type: 'time', class: 'form-control form-control-sm bg-dark border-secondary text-white rule-start', value: rule.start, 'aria-label': 'Desde' }),
            el('span', { class: 'small text-secondary', text: 'a' }),
            el('input', { type: 'time', class: 'form-control form-control-sm bg-dark border-secondary text-white rule-end', value: rule.end, 'aria-label': 'Hasta' }),
            mode,
            el('button', { type: 'button', class: 'btn btn-sm btn-outline-danger ms-auto', title: 'Quitar', 'aria-label': 'Quitar franja', onclick: (e) => e.currentTarget.closest('.rule-row').remove() }, icon('x-lg')));
    }
    function renderRules(rules) { $('scheduleRules').replaceChildren(...rules.map(ruleRow)); }
    function collectRules() {
        return qsa('.rule-row').map((row) => ({
            days: qsa('[data-day].active', row).map((b) => parseInt(b.dataset.day, 10)),
            start: row.querySelector('.rule-start').value,
            end: row.querySelector('.rule-end').value,
            mode: row.querySelector('.rule-mode').value
        }));
    }
    $('btnAddRule').addEventListener('click', () => $('scheduleRules').append(ruleRow()));

    // ---------- Cámaras ----------
    function renderCameraList(list) {
        const box = $('cameraList');
        box.replaceChildren(...list.map((cam) => {
            const dot = cam.enabled ? (cam.status === 'online' ? 'text-emerald' : cam.status === 'starting' ? 'text-warning' : 'text-danger') : 'text-secondary';
            const toggle = el('input', {
                class: 'form-check-input', type: 'checkbox', role: 'switch', checked: cam.enabled, 'aria-label': 'Activa',
                onchange: async (e) => {
                    try { await api('PATCH', `/api/cameras/${cam.id}`, { enabled: e.target.checked }); }
                    catch (err) { toast(err.message, 'danger'); e.target.checked = !e.target.checked; }
                }
            });
            return el('div', { class: 'camera-row d-flex align-items-center gap-2 p-2 rounded border border-secondary' },
                icon('circle-fill', `${dot} small`),
                icon(cam.type === 'rtsp' ? 'wifi' : 'webcam', 'text-secondary'),
                el('div', { class: 'flex-grow-1 min-w-0' },
                    el('div', { class: 'small fw-semibold text-truncate', text: cam.name }),
                    el('div', { class: 'small text-secondary font-mono text-truncate', text: cam.source })),
                el('div', { class: 'form-check form-switch mb-0' }, toggle),
                el('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Editar', 'aria-label': 'Editar', onclick: () => showCameraForm(cam) }, icon('pencil')),
                el('button', {
                    class: 'btn btn-sm btn-outline-danger', title: 'Eliminar', 'aria-label': 'Eliminar',
                    onclick: async () => {
                        if (!confirm(`¿Eliminar la cámara "${cam.name}"? Sus eventos ya grabados se conservan.`)) return;
                        try { await api('DELETE', `/api/cameras/${cam.id}`); } catch (e) { toast(e.message, 'danger'); }
                    }
                }, icon('trash3')));
        }));
    }

    function camTypeSelected() { return $('camTypeRtsp').checked ? 'rtsp' : 'dshow'; }
    function renderCamType() {
        const rtsp = camTypeSelected() === 'rtsp';
        $('rtspSection').classList.toggle('d-none', !rtsp);
        $('dshowSection').classList.toggle('d-none', rtsp);
    }
    $('camTypeDshow').addEventListener('change', renderCamType);
    $('camTypeRtsp').addEventListener('change', renderCamType);

    async function loadDevices(selected) {
        const sel = $('camDevice');
        sel.replaceChildren(el('option', { value: '', text: 'Buscando…' }));
        try {
            const { devices } = await api('GET', '/api/system/devices');
            sel.replaceChildren(...(devices.length ? devices.map((d) => el('option', { value: d, text: d, selected: d === selected }))
                : [el('option', { value: '', text: 'No se encontraron webcams' })]));
        } catch (e) {
            sel.replaceChildren(el('option', { value: '', text: e.message }));
        }
    }
    $('btnRefreshDevices').addEventListener('click', () => loadDevices($('camDevice').value));

    function showCameraForm(cam) {
        $('cameraForm').classList.remove('d-none');
        $('btnNewCamera').classList.add('d-none');
        $('cameraFormError').textContent = '';
        $('rtspTestResult').textContent = '';
        $('camId').value = cam ? cam.id : '';
        $('cameraFormTitle').textContent = cam ? `Editar: ${cam.name}` : 'Nueva cámara';
        $('camName').value = cam ? cam.name : '';
        (cam && cam.type === 'rtsp' ? $('camTypeRtsp') : $('camTypeDshow')).checked = true;
        $('camUrl').value = cam && cam.type === 'rtsp' ? cam.source : '';
        $('camTransport').value = cam ? cam.transport : 'tcp';
        $('camEnabled').checked = cam ? cam.enabled : true;
        renderCamType();
        loadDevices(cam && cam.type === 'dshow' ? cam.source : null);
        $('camName').focus();
    }
    function hideCameraForm() {
        $('cameraForm').classList.add('d-none');
        $('btnNewCamera').classList.remove('d-none');
    }
    $('btnNewCamera').addEventListener('click', () => showCameraForm(null));
    $('btnCancelCamera').addEventListener('click', hideCameraForm);

    $('cameraForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = $('camId').value;
        const type = camTypeSelected();
        const body = {
            name: $('camName').value.trim(),
            type,
            source: type === 'rtsp' ? $('camUrl').value.trim() : $('camDevice').value,
            transport: $('camTransport').value,
            enabled: $('camEnabled').checked
        };
        try {
            if (id) await api('PATCH', `/api/cameras/${id}`, body);
            else await api('POST', '/api/cameras', body);
            hideCameraForm();
            toast('Cámara guardada', 'success');
        } catch (err) {
            $('cameraFormError').textContent = err.message;
        }
    });

    $('btnTestRtsp').addEventListener('click', async () => {
        const out = $('rtspTestResult');
        out.textContent = 'Probando… (hasta 8 s)';
        out.className = 'small text-warning';
        try {
            const r = await api('POST', '/api/cameras/test-rtsp', { url: $('camUrl').value.trim(), transport: $('camTransport').value, cameraId: $('camId').value || undefined });
            out.textContent = r.success ? r.message : r.error;
            out.className = r.success ? 'small text-emerald fw-bold' : 'small text-danger';
        } catch (err) {
            out.textContent = err.message;
            out.className = 'small text-danger';
        }
    });

    // ==========================================
    // ARRANQUE
    // ==========================================
    async function refreshAll() {
        await Promise.allSettled([loadCameras(), loadStats(), loadEvents(), loadTimeline()]);
    }

    (async function init() {
        setLayout(state.layout);
        renderQuality();
        renderSound();
        renderTimelineMarkers();
        try {
            await loadSettings();
        } catch (_) { return; }
        await refreshAll();
        loadStorage();
        connectWs();
        setInterval(loadStats, 60000);
        setInterval(loadStorage, 5 * 60000);
    })();
})();
