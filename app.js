// Elementos del DOM
const video = document.getElementById('videoElement');
const canvas = document.getElementById('canvasElement');
const toggleButton = document.getElementById('toggleCamera');
const statusElement = document.getElementById('status');
const gallery = document.getElementById('captureGallery');
const dateFilter = document.getElementById('dateFilter');
const clearFilterBtn = document.getElementById('clearFilter');
const imagePreviewModal = new bootstrap.Modal(document.getElementById('imagePreviewModal'));
const previewImage = document.getElementById('previewImage');
const imageTimestamp = document.getElementById('imageTimestamp');
const downloadBtn = document.getElementById('downloadImage');
const shareBtn = document.getElementById('shareImage');

// Variables de control
let stream = null;
let isDetecting = false;
let previousImageData = null;
const MOTION_THRESHOLD = 30;
const CAPTURE_INTERVAL = 500;
let currentImagePath = '';

// Configuración de la cámara
const constraints = {
    video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'environment'
    }
};

// Función para formatear fecha y hora
function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('es-ES', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

// Iniciar automáticamente al cargar la página
window.addEventListener('load', () => {
    startCamera();
    loadCapturedImages();
});

// Event listeners para filtros
dateFilter.addEventListener('change', loadCapturedImages);
clearFilterBtn.addEventListener('click', () => {
    dateFilter.value = '';
    loadCapturedImages();
});

// Función para cargar imágenes capturadas
async function loadCapturedImages() {
    try {
        const response = await fetch('/api/captures');
        let captures = await response.json();

        // Aplicar filtro de fecha si existe
        if (dateFilter.value) {
            const filterDate = new Date(dateFilter.value).toISOString().split('T')[0];
            captures = captures.filter(capture => 
                capture.timestamp.startsWith(filterDate)
            );
        }

        gallery.innerHTML = '';
        captures.forEach(capture => {
            const captureItem = createCaptureItem(capture);
            gallery.appendChild(captureItem);
        });
    } catch (error) {
        console.error('Error al cargar las capturas:', error);
    }
}

// Función para crear elemento de captura
function createCaptureItem(capture) {
    const captureItem = document.createElement('div');
    captureItem.className = 'capture-item';
    
    const img = document.createElement('img');
    img.src = capture.path;
    img.alt = 'Captura';
    
    const info = document.createElement('div');
    info.className = 'capture-info';
    info.textContent = new Date(capture.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    captureItem.appendChild(img);
    captureItem.appendChild(info);
    
    // Evento para mostrar vista previa
    captureItem.addEventListener('click', () => showImagePreview(capture));
    
    return captureItem;
}

// Función para mostrar vista previa
function showImagePreview(capture) {
    previewImage.src = capture.path;
    currentImagePath = capture.path;
    imageTimestamp.textContent = formatDateTime(capture.timestamp);
    imagePreviewModal.show();
}

// Event listener para descargar imagen
downloadBtn.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = currentImagePath;
    link.download = currentImagePath.split('/').pop();
    link.click();
});

// Event listener para compartir imagen
shareBtn.addEventListener('click', async () => {
    try {
        if (navigator.share) {
            const response = await fetch(currentImagePath);
            const blob = await response.blob();
            const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' });
            
            await navigator.share({
                files: [file],
                title: 'Captura de vigilancia',
                text: 'Captura del sistema de vigilancia'
            });
        } else {
            // Fallback para navegadores que no soportan Web Share API
            const tempInput = document.createElement('input');
            tempInput.value = window.location.origin + currentImagePath;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand('copy');
            document.body.removeChild(tempInput);
            alert('URL de la imagen copiada al portapapeles');
        }
    } catch (error) {
        console.error('Error al compartir:', error);
        alert('No se pudo compartir la imagen');
    }
});

// Función para iniciar la cámara
async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        toggleButton.textContent = 'Detener Cámara';
        statusElement.textContent = 'Estado: Activo';
        statusElement.className = 'text-muted camera-active';
        
        // Esperar a que el video esté listo
        video.addEventListener('loadedmetadata', () => {
            // Establecer dimensiones del canvas igual al video
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            startMotionDetection();
        });
    } catch (err) {
        console.error('Error al acceder a la cámara:', err);
        statusElement.textContent = 'Error: No se pudo acceder a la cámara';
        statusElement.className = 'text-muted camera-inactive';
    }
}

// Función para detener la cámara
function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;
        stream = null;
        toggleButton.textContent = 'Iniciar Cámara';
        statusElement.textContent = 'Estado: Inactivo';
        statusElement.className = 'text-muted camera-inactive';
        isDetecting = false;
    }
}

// Toggle de la cámara
toggleButton.addEventListener('click', () => {
    if (stream) {
        stopCamera();
    } else {
        startCamera();
    }
});

// Función para iniciar la detección de movimiento
function startMotionDetection() {
    isDetecting = true;
    detectMotion();
}

// Función para detectar movimiento
function detectMotion() {
    if (!isDetecting || !video.videoWidth) return;

    const context = canvas.getContext('2d');
    
    // Asegurar que el canvas tenga las dimensiones correctas
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }
    
    context.drawImage(video, 0, 0);
    
    try {
        const currentImageData = context.getImageData(0, 0, canvas.width, canvas.height);

        if (previousImageData) {
            const movement = detectPixelDifference(previousImageData.data, currentImageData.data);
            if (movement > MOTION_THRESHOLD) {
                console.log('Movimiento detectado:', movement);
                captureImage(currentImageData);
            }
        }

        previousImageData = currentImageData;
    } catch (error) {
        console.error('Error al procesar imagen:', error);
    }

    setTimeout(detectMotion, CAPTURE_INTERVAL);
}

// Función para detectar diferencias entre frames
function detectPixelDifference(previous, current) {
    let movement = 0;
    const length = previous.length;
    const step = 4; // RGBA

    for (let i = 0; i < length; i += step) {
        movement += Math.abs(previous[i] - current[i]); // R
        movement += Math.abs(previous[i + 1] - current[i + 1]); // G
        movement += Math.abs(previous[i + 2] - current[i + 2]); // B
    }

    return movement / (length / step);
}

// Función para enviar notificación a WhatsApp
async function sendWhatsAppNotification(timestamp) {
    const apiKey = ""; // Necesitarás registrarte para obtener tu API Key
    const message = `🚨 Movimiento detectado en el sistema de vigilancia - ${formatDateTime(timestamp)}`;
    const phone = "573006957308"; // Tu número de teléfono
    
    try {
        const response = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`);
        if (!response.ok) {
            throw new Error('Error al enviar notificación de WhatsApp');
        }
        console.log('Notificación de WhatsApp enviada correctamente');
    } catch (error) {
        console.error('Error al enviar notificación:', error);
    }
}

// Función para capturar y guardar imagen
function captureImage(imageData) {
    const timestamp = new Date().toISOString();
    
    // Crear imagen a partir de los datos del canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const context = tempCanvas.getContext('2d');
    context.putImageData(imageData, 0, 0);
    
    // Enviar la imagen al servidor
    saveImageToServer(tempCanvas.toDataURL('image/jpeg'), timestamp)
        .then(() => {
            // Recargar la galería después de guardar
            loadCapturedImages();
            // Enviar notificación a WhatsApp
            sendWhatsAppNotification(timestamp);
        });
}

// Función para enviar imagen al servidor
async function saveImageToServer(imageData, timestamp) {
    try {
        const response = await fetch('/api/save-capture', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: imageData,
                timestamp: timestamp
            })
        });
        
        if (!response.ok) {
            throw new Error('Error al guardar la imagen');
        }
    } catch (error) {
        console.error('Error al guardar la captura:', error);
    }
} 