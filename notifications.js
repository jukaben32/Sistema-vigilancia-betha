const fs = require('fs-extra');
const path = require('path');
const db = require('./database');

/**
 * Servicio de notificaciones multicanal para Sistema de Vigilancia Betha
 */

// Formatear timestamp legible
function formatReadableTime(isoString) {
    try {
        const d = new Date(isoString);
        return d.toLocaleString('es-ES', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    } catch (_) {
        return isoString;
    }
}

/**
 * Enviar alerta con foto a Telegram
 */
async function sendTelegramAlert(event, photoAbsolutePath) {
    try {
        const settings = await db.getAllSettings();
        const enabled = settings.telegram_enabled === 'true';
        const botToken = settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
        const chatId = settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;

        if (!enabled || !botToken || !chatId) {
            return { sent: false, reason: 'Telegram no configurado o deshabilitado' };
        }

        const confidencePct = Math.round((event.confidence || 0) * 100);
        const icon = event.event_type === 'person' ? '🚨 👤' : '⚠️ 🎯';
        
        const caption = 
`${icon} *ALERTA DE VIGILANCIA - BETHA SENTINEL*
━━━━━━━━━━━━━━━━━━━━━
📍 *Detección:* ${event.label || 'Intrusión'}
📊 *Confianza IA:* ${confidencePct}%
🕒 *Hora:* ${formatReadableTime(event.timestamp)}
📹 *Cámara:* Cámara 01 (Principal)
━━━━━━━━━━━━━━━━━━━━━
_Verifica el panel de control para ver el clip de video completo._`;

        // Si existe el archivo de foto, enviamos con foto adjunta
        if (photoAbsolutePath && fs.existsSync(photoAbsolutePath)) {
            const fileBuffer = await fs.readFile(photoAbsolutePath);
            const blob = new Blob([fileBuffer], { type: 'image/jpeg' });

            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('photo', blob, 'alerta.jpg');
            formData.append('caption', caption);
            formData.append('parse_mode', 'Markdown');

            const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            if (!result.ok) {
                console.error('[TELEGRAM] Error de API:', result.description);
                return { sent: false, error: result.description };
            }

            console.log('[TELEGRAM] Alerta fotográfica enviada con éxito al chat:', chatId);
            return { sent: true };
        } else {
            // Envío en texto si no hay foto disponible
            const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: caption,
                    parse_mode: 'Markdown'
                })
            });

            const result = await response.json();
            return { sent: result.ok };
        }
    } catch (error) {
        console.error('[TELEGRAM] Error inesperado enviando notificación:', error.message);
        return { sent: false, error: error.message };
    }
}

/**
 * Probar conexión con Telegram Bot
 */
async function testTelegram(token, chatId) {
    try {
        if (!token || !chatId) {
            return { success: false, error: 'Token o Chat ID vacíos' };
        }

        const message = `🔔 *Prueba de conexión exitosa*\n\nEl sistema de vigilancia *Betha Sentinel* está correctamente vinculado a este canal de Telegram. Recibirás alertas instantáneas cada vez que la IA detecte presencia humana.`;

        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        });

        const data = await response.json();
        if (data.ok) {
            return { success: true, message: 'Mensaje de prueba enviado con éxito' };
        } else {
            return { success: false, error: data.description || 'Error al enviar mensaje' };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Enviar notificación por WhatsApp (Twilio o CallMeBot)
 */
async function sendWhatsAppAlert(event) {
    try {
        const settings = await db.getAllSettings();
        const enabled = settings.whatsapp_enabled === 'true';
        const phone = settings.whatsapp_phone || process.env.WHATSAPP_PHONE;

        if (!enabled || !phone) return { sent: false };

        const confidencePct = Math.round((event.confidence || 0) * 100);
        const text = `🚨 *ALERTA VIGILANCIA BETHA*\nSe ha detectado: ${event.label} (${confidencePct}%)\nHora: ${formatReadableTime(event.timestamp)}`;

        // Soporte Twilio si están las variables
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM) {
            const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            await twilio.messages.create({
                body: text,
                from: process.env.TWILIO_WHATSAPP_FROM,
                to: `whatsapp:${phone}`
            });
            console.log('[WHATSAPP] Alerta enviada por Twilio');
            return { sent: true };
        }

        return { sent: false, reason: 'Twilio no configurado' };
    } catch (err) {
        console.error('[WHATSAPP] Error enviando alerta:', err.message);
        return { sent: false, error: err.message };
    }
}

/**
 * Dispatcher general de notificaciones
 */
async function dispatchAlerts(event, photoPath) {
    // Ejecutar en paralelo sin bloquear
    Promise.allSettled([
        sendTelegramAlert(event, photoPath),
        sendWhatsAppAlert(event)
    ]).then(results => {
        // Log interno si fue necesario
    });
}

module.exports = {
    sendTelegramAlert,
    testTelegram,
    sendWhatsAppAlert,
    dispatchAlerts
};
