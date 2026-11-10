/**
 * Envío de alertas por todos los canales configurados (Telegram, WhatsApp).
 * Nunca lanza: los fallos se registran y no bloquean la detección.
 */
const store = require('../store');
const telegram = require('./telegram');

function telegramCfg() {
    const s = store.get();
    const token = s.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = s.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    return s.telegramEnabled && token && chatId ? { token, chatId } : null;
}

async function sendWhatsApp(event) {
    const s = store.get();
    const phone = s.whatsappPhone || process.env.WHATSAPP_PHONE;
    if (!s.whatsappEnabled || !phone) return;
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) return;
    const pct = Math.round((event.confidence || 0) * 100);
    const twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    await twilio.messages.create({
        body: `🚨 ALERTA BETHA SENTINEL\n${event.label} (${pct}%) en ${event.camera_name || 'cámara ' + event.camera_id}\n${new Date(event.timestamp).toLocaleString('es-DO')}`,
        from: TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${phone}`
    });
}

function eventAlert(event, photoAbs) {
    const tg = telegramCfg();
    Promise.allSettled([
        tg ? telegram.sendEventAlert(tg, event, photoAbs) : null,
        sendWhatsApp(event)
    ]).then((results) => {
        results.forEach((r, i) => {
            if (r.status === 'rejected') console.error(`[ALERTA] ${i === 0 ? 'Telegram' : 'WhatsApp'}: ${r.reason.message}`);
        });
    });
}

async function clipReady(event, videoAbs) {
    const tg = telegramCfg();
    if (!tg || !store.get().telegramSendClips) return;
    try {
        await telegram.sendClip(tg, event, videoAbs);
    } catch (e) {
        console.error('[ALERTA] Telegram (clip):', e.message);
    }
}

module.exports = { eventAlert, clipReady, telegramCfg };
