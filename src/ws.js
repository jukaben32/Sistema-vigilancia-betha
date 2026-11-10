/**
 * WebSocket del panel. El upgrade solo se acepta con una sesión válida.
 */
const { WebSocketServer } = require('ws');
const auth = require('./auth');

let wss = null;

function init(server) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    server.on('upgrade', (req, socket, head) => {
        if (req.url !== '/ws') return socket.destroy();
        auth.authenticateUpgrade(req)
            .then((ok) => {
                if (!ok) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                    return socket.destroy();
                }
                wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
            })
            .catch(() => socket.destroy());
    });

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', () => {}); // el panel no envía nada por WS
        ws.send(JSON.stringify({ type: 'CONNECTED' }));
    });

    // Cerrar conexiones muertas (móviles que pierden cobertura)
    const ping = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) { ws.terminate(); continue; }
            ws.isAlive = false;
            try { ws.ping(); } catch (_) {}
        }
    }, 30000);
    wss.on('close', () => clearInterval(ping));
}

function broadcast(type, data) {
    if (!wss) return;
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    for (const c of wss.clients) {
        if (c.readyState === 1 && c.bufferedAmount < 1024 * 1024) c.send(payload);
    }
}

function close() {
    if (!wss) return;
    for (const c of wss.clients) c.terminate();
    wss.close();
}

module.exports = { init, broadcast, close };
