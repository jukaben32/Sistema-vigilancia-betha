/**
 * Cliente mínimo de la API de Telegram Bot (fetch nativo, sin dependencias).
 * Los mensajes usan parse_mode HTML con escape, que no se rompe con
 * caracteres como _ * [ que sí rompían el Markdown anterior.
 */
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const { escapeHtml } = require('../util');

const MAX_VIDEO_BYTES = 49 * 1024 * 1024; // límite de bots: 50 MB

async function call(token, method, params = {}, { files = null, signal } = {}) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    let body;
    let headers;
    if (files) {
        body = new FormData();
        for (const [k, v] of Object.entries(params)) {
            body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        for (const [field, { buffer, filename, type }] of Object.entries(files)) {
            body.append(field, new Blob([buffer], { type }), filename);
        }
    } else {
        body = JSON.stringify(params);
        headers = { 'Content-Type': 'application/json' };
    }
    const res = await fetch(url, { method: 'POST', body, headers, signal });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) {
        const err = new Error(data.description || 'Error de Telegram');
        err.code = data.error_code || res.status;
        throw err;
    }
    return data.result;
}

function formatTime(iso) {
    try {
        return new Date(iso).toLocaleString('es-DO', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
    } catch (_) {
        return iso;
    }
}

function eventCaption(event) {
    const pct = Math.round((event.confidence || 0) * 100);
    const icon = event.event_type === 'person' ? '🚨' : '⚠️';
    return [
        `${icon} <b>ALERTA — BETHA SENTINEL</b>`,
        `📍 <b>Detección:</b> ${escapeHtml(event.label)} (${pct}%)`,
        `📹 <b>Cámara:</b> ${escapeHtml(event.camera_name || `Cámara ${event.camera_id}`)}`,
        `🕒 <b>Hora:</b> ${escapeHtml(formatTime(event.timestamp))}`,
        `🆔 Evento #${event.id}`
    ].join('\n');
}

function alertKeyboard(eventId) {
    return {
        inline_keyboard: [
            [
                { text: '🔕 Desarmar 1 h', callback_data: 'tmp:disarmed:3600' },
                { text: '🏠 Modo En casa', callback_data: 'mode:home' }
            ],
            [{ text: '🎬 Ver clip', callback_data: `clip:${eventId}` }]
        ]
    };
}

async function sendEventAlert({ token, chatId }, event, photoAbs) {
    const caption = eventCaption(event);
    const reply_markup = alertKeyboard(event.id);
    if (photoAbs && (await fs.pathExists(photoAbs))) {
        const buffer = await fs.readFile(photoAbs);
        return call(token, 'sendPhoto', { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup }, {
            files: { photo: { buffer, filename: 'alerta.jpg', type: 'image/jpeg' } }
        });
    }
    return call(token, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup });
}

async function sendClip({ token, chatId }, event, videoAbs) {
    const stat = await fs.stat(videoAbs).catch(() => null);
    if (!stat) return null;
    const caption = `🎬 Clip del evento #${event.id} — ${escapeHtml(event.label)} (${escapeHtml(event.camera_name || '')})`;
    if (stat.size > MAX_VIDEO_BYTES) {
        const link = config.PUBLIC_URL ? `\n${config.PUBLIC_URL}${event.video_path}` : '';
        return call(token, 'sendMessage', {
            chat_id: chatId, parse_mode: 'HTML',
            text: `${caption}\nEl clip pesa ${Math.round(stat.size / 1048576)} MB (más de 50 MB): míralo en el panel.${escapeHtml(link)}`
        });
    }
    const buffer = await fs.readFile(videoAbs);
    return call(token, 'sendVideo', { chat_id: chatId, caption, parse_mode: 'HTML', supports_streaming: true }, {
        files: { video: { buffer, filename: path.basename(videoAbs), type: 'video/mp4' } }
    });
}

function sendPhotoBuffer({ token, chatId }, buffer, caption) {
    return call(token, 'sendPhoto', { chat_id: chatId, caption, parse_mode: 'HTML' }, {
        files: { photo: { buffer, filename: 'foto.jpg', type: 'image/jpeg' } }
    });
}

function sendText({ token, chatId }, text, extra = {}) {
    return call(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

async function test(token, chatId) {
    try {
        if (!token || !chatId) return { success: false, error: 'Token o Chat ID vacíos' };
        await sendText({ token, chatId },
            '🔔 <b>Prueba de conexión correcta</b>\nBetha Sentinel está vinculado a este chat. Escribe /ayuda para ver los comandos.');
        return { success: true, message: 'Mensaje de prueba enviado' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = { call, sendEventAlert, sendClip, sendPhotoBuffer, sendText, test, eventCaption, MAX_VIDEO_BYTES };
