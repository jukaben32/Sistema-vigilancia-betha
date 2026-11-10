/**
 * Bot de Telegram con comandos, por long polling (getUpdates): funciona
 * detrás del router de casa sin abrir puertos ni configurar webhooks.
 * Solo obedece al chat_id configurado en Ajustes.
 */
const store = require('../store');
const telegram = require('./telegram');
const { escapeHtml } = require('../util');
const { MODE_LABELS } = require('../schedule');

const COMMANDS = [
    { command: 'estado', description: 'Modo, cámaras y eventos de hoy' },
    { command: 'foto', description: 'Foto en vivo (ej. /foto 2)' },
    { command: 'armar', description: 'Activar alertas' },
    { command: 'encasa', description: 'Grabar sin alertas' },
    { command: 'desarmar', description: 'Pausar la vigilancia' },
    { command: 'clip', description: 'Último clip grabado' },
    { command: 'ayuda', description: 'Lista de comandos' }
];

class TelegramBot {
    /**
     * @param {object} actions  funciones del núcleo:
     *   status(), snapshot(index), setMode(mode), setTemporary(mode, ms), lastClip(), eventClip(id)
     */
    constructor(actions) {
        this.actions = actions;
        this.running = false;
        this.abort = null;
        this.offset = 0;
        this.cfgKey = null;
    }

    cfg() {
        const s = store.get();
        return s.telegramEnabled && s.telegramToken && s.telegramChatId
            ? { token: s.telegramToken, chatId: String(s.telegramChatId) }
            : null;
    }

    start() {
        store.on('change', (keys) => {
            if (keys.some((k) => k.startsWith('telegram_'))) this.restart();
        });
        this.restart();
    }

    restart() {
        const cfg = this.cfg();
        const key = cfg ? `${cfg.token}|${cfg.chatId}` : null;
        if (key === this.cfgKey && this.running) return;
        this.stop();
        this.cfgKey = key;
        if (!cfg) return;
        this.running = true;
        this.loop(cfg).catch((e) => console.error('[BOT] Bucle detenido:', e.message));
    }

    stop() {
        this.running = false;
        if (this.abort) this.abort.abort();
        this.abort = null;
    }

    async loop(cfg) {
        try {
            await telegram.call(cfg.token, 'setMyCommands', { commands: COMMANDS });
            console.log('[BOT] Bot de Telegram escuchando comandos.');
        } catch (e) {
            console.warn('[BOT] No se pudo registrar comandos:', e.message);
        }
        while (this.running && this.cfgKey === `${cfg.token}|${cfg.chatId}`) {
            this.abort = new AbortController();
            try {
                const updates = await telegram.call(cfg.token, 'getUpdates', {
                    offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query']
                }, { signal: this.abort.signal });
                for (const u of updates) {
                    this.offset = u.update_id + 1;
                    this.handle(cfg, u).catch((e) => console.error('[BOT] Error:', e.message));
                }
            } catch (e) {
                if (!this.running || e.name === 'AbortError') break;
                // 401 = token inválido, 409 = otro proceso usando el mismo bot
                const wait = e.code === 401 || e.code === 409 ? 60000 : 5000;
                console.warn(`[BOT] ${e.message}. Reintento en ${wait / 1000}s.`);
                await new Promise((r) => setTimeout(r, wait));
            }
        }
    }

    async handle(cfg, u) {
        if (u.callback_query) return this.handleCallback(cfg, u.callback_query);
        const msg = u.message;
        if (!msg || !msg.text) return;
        if (String(msg.chat.id) !== cfg.chatId) return; // ignorar a desconocidos

        const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
        const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
        const reply = (text, extra) => telegram.sendText(cfg, text, extra);

        switch (cmd) {
            case '/start':
            case '/ayuda':
                return reply(['<b>Betha Sentinel</b> — comandos:', ...COMMANDS.map((c) => `/${c.command} — ${c.description}`)].join('\n'));
            case '/estado': {
                const st = await this.actions.status();
                const cams = st.cameras.map((c) => `${c.status === 'online' ? '🟢' : '🔴'} ${c.index}. ${escapeHtml(c.name)}`).join('\n') || 'Sin cámaras';
                const until = st.mode.until ? ` (hasta ${new Date(st.mode.until).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })})` : '';
                return reply(`🛡️ <b>Modo:</b> ${MODE_LABELS[st.mode.mode]}${until}\n📊 <b>Eventos hoy:</b> ${st.todayCount} (${st.todayPersons} personas)\n\n${cams}`);
            }
            case '/foto': {
                const idx = parseInt(args[0], 10) || 1;
                const snap = await this.actions.snapshot(idx);
                if (!snap) return reply('No hay imagen disponible de esa cámara.');
                return telegram.sendPhotoBuffer(cfg, snap.jpeg, `📷 ${escapeHtml(snap.name)} — ${new Date().toLocaleTimeString('es-DO')}`);
            }
            case '/armar':
            case '/encasa':
            case '/desarmar': {
                const mode = { '/armar': 'armed', '/encasa': 'home', '/desarmar': 'disarmed' }[cmd];
                const m = await this.actions.setMode(mode);
                const until = m.until ? `\nCon el horario activo, vale hasta las ${new Date(m.until).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}.` : '';
                return reply(`✅ Modo: <b>${MODE_LABELS[m.mode]}</b>${until}`);
            }
            case '/clip': {
                const clip = await this.actions.lastClip();
                if (!clip) return reply('Todavía no hay clips grabados.');
                return telegram.sendClip(cfg, clip.event, clip.file);
            }
            default:
                if (cmd.startsWith('/')) return reply('Comando no reconocido. Escribe /ayuda.');
        }
    }

    async handleCallback(cfg, q) {
        const fromChat = q.message && String(q.message.chat.id);
        if (fromChat !== cfg.chatId) return;
        const answer = (text) => telegram.call(cfg.token, 'answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
        const [kind, a, b] = String(q.data || '').split(':');

        if (kind === 'tmp' && ['armed', 'home', 'disarmed'].includes(a)) {
            const secs = Math.min(24 * 3600, Math.max(60, parseInt(b, 10) || 3600));
            await this.actions.setTemporary(a, secs * 1000);
            await answer(`${MODE_LABELS[a]} durante ${Math.round(secs / 60)} min`);
            return telegram.sendText(cfg, `✅ <b>${MODE_LABELS[a]}</b> durante ${Math.round(secs / 60)} min.`);
        }
        if (kind === 'mode' && ['armed', 'home', 'disarmed'].includes(a)) {
            const m = await this.actions.setMode(a);
            await answer(`Modo: ${MODE_LABELS[m.mode]}`);
            return telegram.sendText(cfg, `✅ Modo: <b>${MODE_LABELS[m.mode]}</b>`);
        }
        if (kind === 'clip') {
            const clip = await this.actions.eventClip(parseInt(a, 10));
            if (!clip) return answer('El clip aún se está grabando o no existe. Llegará en unos segundos.');
            await answer('Enviando clip…');
            return telegram.sendClip(cfg, clip.event, clip.file);
        }
        return answer('Acción no reconocida');
    }
}

module.exports = { TelegramBot, COMMANDS };
