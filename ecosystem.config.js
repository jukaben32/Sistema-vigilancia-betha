// Arranque permanente con PM2 (se reinicia solo si falla).
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save
// Arranque automático al encender Windows: ver README ("Funcionamiento 24/7").
module.exports = {
    apps: [{
        name: 'betha-sentinel',
        script: 'server.js',
        cwd: __dirname,
        autorestart: true,
        max_restarts: 50,
        restart_delay: 5000,
        kill_timeout: 10000,
        max_memory_restart: '800M',
        env: { NODE_ENV: 'production' }
    }]
};
