const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');

const app = express();
const port = process.env.PORT || 3000;

// Middleware para parsear JSON y servir archivos estáticos
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/captures', express.static(path.join(__dirname, 'captures')));

// Asegurar que existe el directorio de capturas
const capturesDir = path.join(__dirname, 'captures');
fs.ensureDirSync(capturesDir);

// Función auxiliar para extraer timestamp del nombre del archivo
function getTimestampFromFilename(year, month, day, filename) {
    // El formato del archivo es: capture_HHMMSS_timestamp.jpg
    const timeMatch = filename.match(/capture_(\d{2})(\d{2})(\d{2})_/);
    if (timeMatch) {
        const [, hours, minutes, seconds] = timeMatch;
        return moment(`${year}-${month}-${day} ${hours}:${minutes}:${seconds}`, 'YYYY-MM-DD HH:mm:ss').toISOString();
    }
    return null;
}

// Función auxiliar para obtener todas las capturas
async function getAllCaptures() {
    const captures = [];
    const years = await fs.readdir(capturesDir);
    
    for (const year of years) {
        const yearPath = path.join(capturesDir, year);
        const yearStat = await fs.stat(yearPath);
        if (!yearStat.isDirectory()) continue;
        
        const months = await fs.readdir(yearPath);
        for (const month of months) {
            const monthPath = path.join(yearPath, month);
            const monthStat = await fs.stat(monthPath);
            if (!monthStat.isDirectory()) continue;
            
            const days = await fs.readdir(monthPath);
            for (const day of days) {
                const dayPath = path.join(monthPath, day);
                const dayStat = await fs.stat(dayPath);
                if (!dayStat.isDirectory()) continue;
                
                const files = await fs.readdir(dayPath);
                for (const file of files) {
                    if (!file.endsWith('.jpg')) continue;
                    
                    const filePath = path.join(dayPath, file);
                    const stats = await fs.stat(filePath);
                    const timestamp = getTimestampFromFilename(year, month, day, file);
                    
                    if (timestamp) {
                        captures.push({
                            path: `/captures/${year}/${month}/${day}/${file}`,
                            timestamp: timestamp,
                            size: stats.size,
                            created: stats.birthtime
                        });
                    }
                }
            }
        }
    }
    
    return captures.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Ruta para guardar capturas
app.post('/api/save-capture', async (req, res) => {
    try {
        const { image, timestamp } = req.body;
        
        // Crear estructura de directorios por fecha
        const date = moment(timestamp);
        const yearDir = path.join(capturesDir, date.format('YYYY'));
        const monthDir = path.join(yearDir, date.format('MM'));
        const dayDir = path.join(monthDir, date.format('DD'));
        
        await fs.ensureDir(dayDir);
        
        // Crear nombre de archivo único con la hora exacta
        const fileName = `capture_${date.format('HHmmss')}_${Date.now()}.jpg`;
        const filePath = path.join(dayDir, fileName);
        
        // Convertir base64 a archivo
        const base64Data = image.replace(/^data:image\/jpeg;base64,/, '');
        await fs.writeFile(filePath, base64Data, 'base64');
        
        res.json({ 
            success: true, 
            path: `/captures/${date.format('YYYY')}/${date.format('MM')}/${date.format('DD')}/${fileName}`,
            timestamp: date.toISOString()
        });
    } catch (error) {
        console.error('Error al guardar la captura:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ruta para obtener lista de capturas
app.get('/api/captures', async (req, res) => {
    try {
        const captures = await getAllCaptures();
        res.json(captures);
    } catch (error) {
        console.error('Error al obtener las capturas:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ruta para eliminar una captura
app.delete('/api/captures/:year/:month/:day/:file', async (req, res) => {
    try {
        const { year, month, day, file } = req.params;
        const filePath = path.join(capturesDir, year, month, day, file);
        
        // Verificar que el archivo existe
        if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'Archivo no encontrado' });
        }
    } catch (error) {
        console.error('Error al eliminar la captura:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor iniciado en http://localhost:${port}`);
}); 