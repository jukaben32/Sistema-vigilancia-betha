/**
 * ============================================================================
 * BETHA SENTINEL // CLIENT NEURAL ENGINE & DASHBOARD CONTROLLER
 * ============================================================================
 */

// Elementos DOM Principales
const video = document.getElementById('videoElement');
const overlayCanvas = document.getElementById('overlayCanvas');
const videoContainer = document.getElementById('videoContainer');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const toggleCameraBtn = document.getElementById('toggleCamera');
const toggleCameraText = document.getElementById('toggleCameraText');
const btnStartCameraCenter = document.getElementById('btnStartCameraCenter');
const btnToggleAI = document.getElementById('btnToggleAI');
const aiToggleText = document.getElementById('aiToggleText');
const btnToggleROI = document.getElementById('btnToggleROI');
const roiBtnText = document.getElementById('roiBtnText');
const roiBox = document.getElementById('roiBox');
const btnManualCapture = document.getElementById('btnManualCapture');
const btnFullscreen = document.getElementById('btnFullscreen');
const btnToggleSound = document.getElementById('btnToggleSound');
const soundIcon = document.getElementById('soundIcon');
const recBadge = document.getElementById('recBadge');
const hudClock = document.getElementById('hudClock');
const aiEngineStatus = document.getElementById('aiEngineStatus');
const wsStatus = document.getElementById('wsStatus');
const wsIndicator = document.getElementById('wsIndicator');
const hudAlertBanner = document.getElementById('hudAlertBanner');
const hudAlertText = document.getElementById('hudAlertText');
const fpsCounter = document.getElementById('fpsCounter');

// Métricas DOM
const statTodayPersons = document.getElementById('statTodayPersons');
const statTodayEvents = document.getElementById('statTodayEvents');
const statLatestAlert = document.getElementById('statLatestAlert');
const statRetentionInfo = document.getElementById('statRetentionInfo');

// Galería y Timeline
const gallery = document.getElementById('captureGallery');
const dateFilter = document.getElementById('dateFilter');
const clearFilterBtn = document.getElementById('clearFilter');
const filterButtons = document.querySelectorAll('.btn-filter');
const btnPrevPage = document.getElementById('btnPrevPage');
const btnNextPage = document.getElementById('btnNextPage');
const pageIndicator = document.getElementById('pageIndicator');
const galleryCountBadge = document.getElementById('galleryCountBadge');
const timelineTrack = document.getElementById('timelineTrack');
const timelineStats = document.getElementById('timelineStats');

// Modal Forense
const imagePreviewModal = new bootstrap.Modal(document.getElementById('imagePreviewModal'));
const previewImage = document.getElementById('previewImage');
const previewVideo = document.getElementById('previewVideo');
const photoViewerContainer = document.getElementById('photoViewerContainer');
const videoViewerContainer = document.getElementById('videoViewerContainer');
const btnViewPhoto = document.getElementById('btnViewPhoto');
const btnViewVideo = document.getElementById('btnViewVideo');
const modalTitle = document.getElementById('modalTitle');
const modalEventBadge = document.getElementById('modalEventBadge');
const modalConfidence = document.getElementById('modalConfidence');
const imageTimestamp = document.getElementById('imageTimestamp');
const modalProtectedStatus = document.getElementById('modalProtectedStatus');
const btnModalStar = document.getElementById('btnModalStar');
const starIcon = document.getElementById('starIcon');
const starText = document.getElementById('starText');
const btnModalDelete = document.getElementById('btnModalDelete');
const downloadBtn = document.getElementById('downloadImage');

// Modal Ajustes
const settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));
const telegramEnabledInput = document.getElementById('telegramEnabled');
const telegramTokenInput = document.getElementById('telegramToken');
const telegramChatIdInput = document.getElementById('telegramChatId');
const btnTestTelegram = document.getElementById('btnTestTelegram');
const telegramTestResult = document.getElementById('telegramTestResult');
const aiThresholdRange = document.getElementById('aiThresholdRange');
const thresholdValueLabel = document.getElementById('thresholdValueLabel');
const cooldownRange = document.getElementById('cooldownRange');
const cooldownValueLabel = document.getElementById('cooldownValueLabel');
const classPerson = document.getElementById('classPerson');
const classCar = document.getElementById('classCar');
const classAnimals = document.getElementById('classAnimals');
const videoClipsEnabled = document.getElementById('videoClipsEnabled');
const retentionRange = document.getElementById('retentionRange');
const retentionValueLabel = document.getElementById('retentionValueLabel');
const btnManualCleanup = document.getElementById('btnManualCleanup');
const btnSaveSettings = document.getElementById('btnSaveSettings');

// ==========================================
// ESTADO GLOBAL
// ==========================================
let stream = null;
let isStreaming = false;
let isAiActive = true;
let isSoundEnabled = true;
let isDrawingROI = false;
let activeROI = { enabled: false, x: 10, y: 10, width: 80, height: 80 }; // Porcentajes
let cocoModel = null;
let ws = null;

// Paginación y Filtros
let currentPage = 1;
let currentFilterType = 'all';
let currentSelectedEvent = null;

// Parámetros de Detección
let detectionThreshold = 0.65;
let cooldownMs = 8000;
let lastAlertTimestamp = 0;
let isRecordingClip = false;

// Reloj y FPS
let lastFrameTime = performance.now();
let frameCount = 0;
let currentFps = 30;

// Configuración de Audio de Alarma
let audioCtx = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function playAlertSiren() {
    if (!isSoundEnabled) return;
    try {
        initAudio();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        
        // Frecuencia tipo alerta táctica
        const now = audioCtx.currentTime;
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1760, now + 0.15);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.3);

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.36);
    } catch (e) {
        console.warn('Audio no permitido todavía:', e);
    }
}

// ==========================================
// INICIALIZACIÓN
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
    initClock();
    initWebSocket();
    await loadSettings();
    await loadStats();
    await loadCapturedEvents();
    await loadTimeline();
    initModel();
});

// Reloj táctico en tiempo real
function initClock() {
    setInterval(() => {
        const now = new Date();
        hudClock.textContent = now.toLocaleTimeString('es-ES', { hour12: false }) + '.' + String(Math.floor(now.getMilliseconds() / 100));
    }, 100);
}

// ==========================================
// TENSORFLOW.JS / MODELO COCO-SSD
// ==========================================
async function initModel() {
    try {
        aiEngineStatus.textContent = 'IA: CARGANDO COCO-SSD...';
        aiEngineStatus.className = 'text-warning font-mono';
        
        // Carga del modelo pre-entrenado COCO-SSD
        cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        
        aiEngineStatus.textContent = 'IA: ACTIVA (COCO-SSD)';
        aiEngineStatus.className = 'text-emerald font-mono';
        console.log('[IA] Modelo COCO-SSD cargado con éxito en GPU/WebGL.');
    } catch (err) {
        console.error('[IA] Error al inicializar TensorFlow.js:', err);
        aiEngineStatus.textContent = 'IA: ERROR AL CARGAR';
        aiEngineStatus.className = 'text-danger font-mono';
    }
}

// ==========================================
// CONTROL DE CÁMARA & STREAMING
// ==========================================
async function startCamera() {
    try {
        initAudio();
        const constraints = {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'environment'
            },
            audio: false
        };

        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            overlayCanvas.width = video.videoWidth;
            overlayCanvas.height = video.videoHeight;
            isStreaming = true;
            videoPlaceholder.style.display = 'none';
            toggleCameraText.textContent = 'Detener';
            recBadge.className = 'badge bg-danger rec-badge';
            recBadge.innerHTML = '<span class="blink-dot"></span> REC';
            
            // Iniciar ciclo de detección
            requestAnimationFrame(detectLoop);
        };
    } catch (err) {
        console.error('Error al acceder a la cámara:', err);
        alert('No se pudo acceder a la cámara. Asegúrate de conceder permisos.');
    }
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
        stream = null;
    }
    isStreaming = false;
    videoPlaceholder.style.display = 'flex';
    toggleCameraText.textContent = 'Iniciar Cámara';
    recBadge.className = 'badge bg-secondary rec-badge';
    recBadge.innerHTML = 'INACTIVO';

    // Limpiar canvas
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

toggleCameraBtn.addEventListener('click', () => {
    if (isStreaming) stopCamera(); else startCamera();
});

btnStartCameraCenter.addEventListener('click', startCamera);

// Botón Toggle IA
btnToggleAI.addEventListener('click', () => {
    isAiActive = !isAiActive;
    if (isAiActive) {
        btnToggleAI.className = 'btn btn-outline-cyan active';
        aiToggleText.textContent = 'IA: Activa';
    } else {
        btnToggleAI.className = 'btn btn-outline-secondary';
        aiToggleText.textContent = 'IA: Pausada';
        const ctx = overlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
});

// Botón Pantalla Completa
btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        videoContainer.requestFullscreen().catch(err => console.warn(err));
    } else {
        document.exitFullscreen();
    }
});

// Botón Sonido
btnToggleSound.addEventListener('click', () => {
    isSoundEnabled = !isSoundEnabled;
    if (isSoundEnabled) {
        btnToggleSound.className = 'btn btn-outline-cyan btn-sm';
        soundIcon.className = 'bi bi-volume-up';
    } else {
        btnToggleSound.className = 'btn btn-outline-secondary btn-sm';
        soundIcon.className = 'bi bi-volume-mute';
    }
});

// ==========================================
// ZONA DE DETECCIÓN ROI (REGION OF INTEREST)
// ==========================================
btnToggleROI.addEventListener('click', () => {
    activeROI.enabled = !activeROI.enabled;
    if (activeROI.enabled) {
        roiBox.style.display = 'block';
        btnToggleROI.className = 'btn btn-cyan btn-outline-cyan active';
        roiBtnText.textContent = 'ROI: ON';
        updateROIElement();
    } else {
        roiBox.style.display = 'none';
        btnToggleROI.className = 'btn btn-outline-secondary';
        roiBtnText.textContent = 'Zona ROI';
    }
    saveRoiSettings();
});

function updateROIElement() {
    roiBox.style.left = `${activeROI.x}%`;
    roiBox.style.top = `${activeROI.y}%`;
    roiBox.style.width = `${activeROI.width}%`;
    roiBox.style.height = `${activeROI.height}%`;
}

// ==========================================
// CICLO PRINCIPAL DE DETECCIÓN POR IA
// ==========================================
async function detectLoop() {
    if (!isStreaming) return;

    // Medición de FPS
    const now = performance.now();
    frameCount++;
    if (now - lastFrameTime >= 1000) {
        currentFps = frameCount;
        fpsCounter.textContent = `${currentFps} FPS`;
        frameCount = 0;
        lastFrameTime = now;
    }

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (isAiActive && cocoModel && video.readyState === 4) {
        try {
            // Predicción por TensorFlow
            const predictions = await cocoModel.detect(video);
            
            // Filtrar predicciones según configuración y ROI
            const validDetections = filterDetections(predictions);

            // Renderizar cajas tácticas
            drawTacticalHUD(ctx, validDetections);

            // Si hay detecciones válidas de personas/vehículos
            if (validDetections.length > 0) {
                handleTriggerEvent(validDetections[0]);
            }
        } catch (e) {
            console.error('[IA] Error en frame de detección:', e);
        }
    }

    requestAnimationFrame(detectLoop);
}

// Filtrar predicciones por umbral, clase y ROI
function filterDetections(predictions) {
    const allowed = [];
    if (classPerson.checked) allowed.push('person');
    if (classCar.checked) allowed.push('car', 'motorcycle', 'bicycle', 'truck');
    if (classAnimals.checked) allowed.push('dog', 'cat', 'bird', 'horse');

    return predictions.filter(pred => {
        // Umbral de confianza
        if (pred.score < detectionThreshold) return false;
        // Clase permitida
        if (!allowed.includes(pred.class)) return false;

        // Comprobación de Zona ROI si está activa
        if (activeROI.enabled) {
            const [bx, by, bw, bh] = pred.bbox;
            const centerX = (bx + bw / 2) / overlayCanvas.width * 100;
            const centerY = (by + bh / 2) / overlayCanvas.height * 100;

            const inRoiX = centerX >= activeROI.x && centerX <= (activeROI.x + activeROI.width);
            const inRoiY = centerY >= activeROI.y && centerY <= (activeROI.y + activeROI.height);
            if (!inRoiX || !inRoiY) return false;
        }

        return true;
    });
}

// Dibujar Bounding Boxes con estilo táctico cibernético
function drawTacticalHUD(ctx, detections) {
    detections.forEach(det => {
        const [x, y, width, height] = det.bbox;
        const score = Math.round(det.score * 100);
        const isPerson = det.class === 'person';
        const color = isPerson ? '#10b981' : '#06b6d4';
        const labelText = isPerson ? `👤 PERSONA ${score}%` : `🎯 ${det.class.toUpperCase()} ${score}%`;

        // Rectángulo principal con glow
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.strokeRect(x, y, width, height);

        // Esquinas tácticas reforzadas
        const cornerLength = Math.min(20, width / 4, height / 4);
        ctx.lineWidth = 4;
        
        // Esquina sup-izq
        ctx.beginPath();
        ctx.moveTo(x, y + cornerLength);
        ctx.lineTo(x, y);
        ctx.lineTo(x + cornerLength, y);
        ctx.stroke();

        // Esquina sup-der
        ctx.beginPath();
        ctx.moveTo(x + width - cornerLength, y);
        ctx.lineTo(x + width, y);
        ctx.lineTo(x + width, y + cornerLength);
        ctx.stroke();

        // Etiqueta superior
        ctx.shadowBlur = 0;
        ctx.font = 'bold 12px "JetBrains Mono", monospace';
        const textWidth = ctx.measureText(labelText).width;
        
        ctx.fillStyle = color;
        ctx.fillRect(x, Math.max(0, y - 22), textWidth + 12, 22);

        ctx.fillStyle = '#022c22';
        ctx.fillText(labelText, x + 6, Math.max(15, y - 6));

        ctx.restore();
    });
}

// ==========================================
// DISPARADOR DE ALERTA Y GRABACIÓN FORENSE
// ==========================================
async function handleTriggerEvent(detection) {
    const now = Date.now();
    if (now - lastAlertTimestamp < cooldownMs) return; // En cooldown anti-spam
    if (isRecordingClip) return;

    lastAlertTimestamp = now;
    isRecordingClip = true;

    // Mostrar banner de alerta en pantalla
    showHUDAlert(detection);

    // Sonido de sirena
    playAlertSiren();

    // 1. Tomar snapshot de alta resolución con la caja de detección
    const photoBlob = await takeSnapshotWithOverlay(detection);

    // 2. Grabar clip de video WebM de 6 segundos si está activado
    let videoBlob = null;
    if (videoClipsEnabled.checked && window.MediaRecorder && stream) {
        videoBlob = await recordVideoClip(6000);
    }

    // 3. Subir al backend mediante FormData
    await uploadEvidence({
        photoBlob,
        videoBlob,
        eventType: detection.class,
        label: detection.class === 'person' ? 'Persona' : detection.class,
        confidence: detection.score
    });

    isRecordingClip = false;
}

// Mostrar banner táctico en video
function showHUDAlert(detection) {
    const isPerson = detection.class === 'person';
    hudAlertText.textContent = isPerson ? `¡PERSONA DETECTADA! (${Math.round(detection.score * 100)}%)` : `¡${detection.class.toUpperCase()} DETECTADO!`;
    hudAlertBanner.className = 'hud-alert-banner show';
    setTimeout(() => {
        hudAlertBanner.className = 'hud-alert-banner';
    }, 4000);
}

// Capturar frame compuesto (Video + HUD)
function takeSnapshotWithOverlay(detection) {
    return new Promise(resolve => {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = video.videoWidth;
        offCanvas.height = video.videoHeight;
        const offCtx = offCanvas.getContext('2d');

        // Dibujar frame original de video
        offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

        // Dibujar caja de detección sobre la foto para evidencia forense
        if (detection) {
            drawTacticalHUD(offCtx, [detection]);
        }

        offCanvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.92);
    });
}

// Grabar clip de video en búfer
function recordVideoClip(durationMs = 6000) {
    return new Promise(resolve => {
        try {
            const recordedChunks = [];
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });

            recorder.ondataavailable = e => {
                if (e.data && e.data.size > 0) recordedChunks.push(e.data);
            };

            recorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: 'video/webm' });
                resolve(blob);
            };

            recorder.start(500);

            setTimeout(() => {
                if (recorder.state === 'recording') {
                    recorder.stop();
                }
            }, durationMs);
        } catch (e) {
            console.warn('[REC] Error al grabar video clip:', e);
            resolve(null);
        }
    });
}

// Subir evidencia al servidor
async function uploadEvidence({ photoBlob, videoBlob, eventType, label, confidence }) {
    try {
        const formData = new FormData();
        formData.append('photo', photoBlob, 'capture.jpg');
        if (videoBlob) {
            formData.append('video', videoBlob, 'clip.webm');
        }
        formData.append('timestamp', new Date().toISOString());
        formData.append('eventType', eventType);
        formData.append('label', label);
        formData.append('confidence', confidence);

        const res = await fetch('/api/save-capture', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        if (data.success) {
            console.log('[EVIDENCIA] Guardada y notificada con éxito:', data.event);
            loadStats();
        }
    } catch (err) {
        console.error('Error al subir evidencia:', err);
    }
}

// Captura Manual
btnManualCapture.addEventListener('click', async () => {
    if (!isStreaming) {
        alert('Inicia la cámara primero para realizar una captura.');
        return;
    }

    const photoBlob = await takeSnapshotWithOverlay(null);
    await uploadEvidence({
        photoBlob,
        videoBlob: null,
        eventType: 'manual',
        label: 'Captura Manual',
        confidence: 1.0
    });
    alert('Captura manual guardada.');
});

// ==========================================
// WEBSOCKETS EN TIEMPO REAL
// ==========================================
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            wsStatus.textContent = 'EN LÍNEA';
            wsIndicator.className = 'pulse-dot active';
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'NEW_EVENT') {
                    handleIncomingEvent(message.data);
                } else if (message.type === 'EVENT_UPDATED') {
                    handleEventUpdated(message.data);
                } else if (message.type === 'EVENT_DELETED') {
                    handleEventDeleted(message.data);
                }
            } catch (err) {
                console.error('Error procesando WS message:', err);
            }
        };

        ws.onclose = () => {
            wsStatus.textContent = 'RECONECTANDO...';
            wsIndicator.className = 'pulse-dot';
            setTimeout(initWebSocket, 4000);
        };
    } catch (e) {
        console.warn('WebSocket error:', e);
    }
}

function handleIncomingEvent(event) {
    // Si estamos en la página 1, prepend a la galería
    if (currentPage === 1 && (currentFilterType === 'all' || currentFilterType === event.event_type)) {
        const card = createEventCard(event);
        gallery.prepend(card);
    }
    loadStats();
    loadTimeline();
}

function handleEventUpdated(data) {
    const starBtn = document.querySelector(`.star-btn-card[data-id="${data.id}"]`);
    if (starBtn) {
        if (data.is_starred) {
            starBtn.className = 'star-btn-card starred';
            starBtn.innerHTML = '<i class="bi bi-star-fill"></i>';
        } else {
            starBtn.className = 'star-btn-card';
            starBtn.innerHTML = '<i class="bi bi-star"></i>';
        }
    }
}

function handleEventDeleted(data) {
    const card = document.querySelector(`.capture-card[data-id="${data.id}"]`);
    if (card) card.remove();
    loadStats();
    loadTimeline();
}

// ==========================================
// GALERÍA & EVENTOS
// ==========================================
async function loadCapturedEvents() {
    try {
        let url = `/api/events?page=${currentPage}&limit=12&type=${currentFilterType}`;
        if (dateFilter.value) {
            url += `&date=${dateFilter.value}`;
        }
        if (currentFilterType === 'starred') {
            url = `/api/events?page=${currentPage}&limit=12&starred=true`;
            if (dateFilter.value) url += `&date=${dateFilter.value}`;
        }

        const res = await fetch(url);
        const data = await res.json();

        gallery.innerHTML = '';
        galleryCountBadge.textContent = data.total;
        pageIndicator.textContent = `Página ${data.page} / ${data.totalPages}`;
        btnPrevPage.disabled = data.page <= 1;
        btnNextPage.disabled = data.page >= data.totalPages;

        if (data.events.length === 0) {
            gallery.innerHTML = `
                <div class="text-center py-5 text-secondary">
                    <i class="bi bi-inbox display-6 d-block mb-2"></i>
                    <p class="small mb-0">No hay capturas registradas para esta selección.</p>
                </div>
            `;
            return;
        }

        data.events.forEach(ev => {
            const card = createEventCard(ev);
            gallery.appendChild(card);
        });
    } catch (err) {
        console.error('Error al cargar eventos:', err);
    }
}

function createEventCard(event) {
    const card = document.createElement('div');
    card.className = 'capture-card';
    card.dataset.id = event.id;

    const isPerson = event.event_type === 'person';
    const confidencePct = Math.round((event.confidence || 0) * 100);
    const dateFormatted = new Date(event.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const hasVideo = !!event.video_path;

    card.innerHTML = `
        <div class="capture-thumb-box">
            <img class="capture-thumb" src="${event.photo_path}" alt="Captura" loading="lazy">
            ${hasVideo ? '<span class="video-indicator-badge"><i class="bi bi-play-circle-fill me-1"></i>CLIP</span>' : ''}
        </div>
        <div class="capture-details">
            <span class="capture-event-title ${isPerson ? 'text-emerald' : 'text-cyan'}">
                <i class="bi ${isPerson ? 'bi-person-fill' : 'bi-camera'}"></i>
                ${event.label || 'Evento'}
                <span class="badge bg-dark border border-secondary text-secondary font-mono">${confidencePct}%</span>
            </span>
            <span class="capture-time"><i class="bi bi-clock me-1"></i>${dateFormatted}</span>
        </div>
        <button class="star-btn-card ${event.is_starred ? 'starred' : ''}" data-id="${event.id}" title="Destacar / Proteger">
            <i class="bi ${event.is_starred ? 'bi-star-fill' : 'bi-star'}"></i>
        </button>
    `;

    // Clic en la tarjeta para abrir vista forense
    card.addEventListener('click', (e) => {
        if (e.target.closest('.star-btn-card')) return;
        showForensicModal(event);
    });

    // Clic en estrella
    const starBtn = card.querySelector('.star-btn-card');
    starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleStarEvent(event.id);
    });

    return card;
}

// Filtros por tab
filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilterType = btn.dataset.filter;
        currentPage = 1;
        loadCapturedEvents();
    });
});

dateFilter.addEventListener('change', () => {
    currentPage = 1;
    loadCapturedEvents();
});

clearFilterBtn.addEventListener('click', () => {
    dateFilter.value = '';
    currentPage = 1;
    loadCapturedEvents();
});

btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        loadCapturedEvents();
    }
});

btnNextPage.addEventListener('click', () => {
    currentPage++;
    loadCapturedEvents();
});

// ==========================================
// MODAL FORENSE / VISOR AVANZADO
// ==========================================
function showForensicModal(event) {
    currentSelectedEvent = event;
    const isPerson = event.event_type === 'person';
    const confidencePct = Math.round((event.confidence || 0) * 100);

    modalTitle.textContent = `Registro Forense #${event.id}`;
    modalEventBadge.className = isPerson ? 'badge bg-danger' : 'badge bg-info text-dark';
    modalEventBadge.textContent = event.label.toUpperCase();
    modalConfidence.textContent = `${confidencePct}%`;
    imageTimestamp.textContent = new Date(event.timestamp).toLocaleString('es-ES', { hour12: false });

    // Estado protegido
    updateModalStarStatus(event.is_starred);

    // Configurar imagen
    previewImage.src = event.photo_path;

    // Configurar video si existe
    if (event.video_path) {
        previewVideo.src = event.video_path;
        btnViewVideo.style.display = 'inline-block';
    } else {
        previewVideo.src = '';
        btnViewVideo.style.display = 'none';
    }

    // Por defecto mostrar foto
    showPhotoViewer();

    imagePreviewModal.show();
}

function showPhotoViewer() {
    photoViewerContainer.style.display = 'block';
    videoViewerContainer.style.display = 'none';
    btnViewPhoto.className = 'btn btn-dark active';
    btnViewVideo.className = 'btn btn-dark';
    previewVideo.pause();
}

function showVideoViewer() {
    photoViewerContainer.style.display = 'none';
    videoViewerContainer.style.display = 'block';
    btnViewPhoto.className = 'btn btn-dark';
    btnViewVideo.className = 'btn btn-dark active';
    previewVideo.play().catch(() => {});
}

btnViewPhoto.addEventListener('click', showPhotoViewer);
btnViewVideo.addEventListener('click', showVideoViewer);

function updateModalStarStatus(isStarred) {
    if (isStarred) {
        modalProtectedStatus.textContent = 'PROTEGIDO';
        modalProtectedStatus.className = 'text-warning fw-bold';
        starIcon.className = 'bi bi-star-fill text-warning me-1';
        starText.textContent = 'Protegido';
    } else {
        modalProtectedStatus.textContent = 'NORMAL';
        modalProtectedStatus.className = 'text-emerald';
        starIcon.className = 'bi bi-star me-1';
        starText.textContent = 'Proteger';
    }
}

// Proteger / Desproteger desde Modal
btnModalStar.addEventListener('click', async () => {
    if (!currentSelectedEvent) return;
    const res = await toggleStarEvent(currentSelectedEvent.id);
    if (res) {
        currentSelectedEvent.is_starred = res.is_starred;
        updateModalStarStatus(res.is_starred);
    }
});

async function toggleStarEvent(id) {
    try {
        const res = await fetch(`/api/events/${id}/star`, { method: 'PATCH' });
        const data = await res.json();
        return data;
    } catch (e) {
        console.error(e);
        return null;
    }
}

// Eliminar desde Modal
btnModalDelete.addEventListener('click', async () => {
    if (!currentSelectedEvent) return;
    if (!confirm('¿Seguro que deseas eliminar permanentemente esta captura y su grabación?')) return;

    try {
        const res = await fetch(`/api/events/${currentSelectedEvent.id}`, { method: 'DELETE' });
        if (res.ok) {
            imagePreviewModal.hide();
            loadCapturedEvents();
            loadStats();
            loadTimeline();
        }
    } catch (e) {
        alert('Error al eliminar evento');
    }
});

// Descargar
downloadBtn.addEventListener('click', () => {
    if (!currentSelectedEvent) return;
    const isVideo = videoViewerContainer.style.display === 'block' && currentSelectedEvent.video_path;
    const fileUrl = isVideo ? currentSelectedEvent.video_path : currentSelectedEvent.photo_path;

    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = fileUrl.split('/').pop();
    link.click();
});

// ==========================================
// LÍNEA DE TIEMPO INTERACTIVA (TIMELINE)
// ==========================================
async function loadTimeline() {
    try {
        const res = await fetch('/api/timeline');
        const events = await res.json();

        timelineTrack.innerHTML = '';
        timelineStats.textContent = `${events.length} evento(s) en 24h`;

        const now = Date.now();
        const past24h = now - (24 * 60 * 60 * 1000);

        events.forEach(ev => {
            const evTime = new Date(ev.timestamp).getTime();
            // Calcular porcentaje a lo largo de 24 horas (0% hace 24h, 100% ahora)
            const pct = Math.max(0, Math.min(100, ((evTime - past24h) / (24 * 60 * 60 * 1000)) * 100));

            const pin = document.createElement('div');
            pin.className = `timeline-pin ${ev.event_type === 'person' ? 'type-person' : 'type-motion'}`;
            pin.style.left = `${pct}%`;
            pin.title = `${ev.label} - ${new Date(ev.timestamp).toLocaleTimeString()}`;

            pin.addEventListener('click', () => {
                showForensicModal(ev);
            });

            timelineTrack.appendChild(pin);
        });
    } catch (err) {
        console.error('Error al cargar timeline:', err);
    }
}

// ==========================================
// ESTADÍSTICAS GLOBALES
// ==========================================
async function loadStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();

        statTodayPersons.textContent = data.todayPersons;
        statTodayEvents.textContent = data.todayCount;

        if (data.latestEvent) {
            const diffMin = Math.round((Date.now() - new Date(data.latestEvent.timestamp).getTime()) / 60000);
            statLatestAlert.textContent = diffMin <= 1 ? 'Hace un instante' : `Hace ${diffMin} min`;
        } else {
            statLatestAlert.textContent = 'Ninguna';
        }
    } catch (e) {
        console.warn('Error al cargar stats:', e);
    }
}

// ==========================================
// CONFIGURACIÓN / SETTINGS MODAL
// ==========================================
async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const s = await res.json();

        telegramEnabledInput.checked = s.telegram_enabled === 'true';
        telegramTokenInput.value = s.telegram_bot_token || '';
        telegramChatIdInput.value = s.telegram_chat_id || '';

        detectionThreshold = parseFloat(s.ai_threshold) || 0.65;
        aiThresholdRange.value = Math.round(detectionThreshold * 100);
        thresholdValueLabel.textContent = `${aiThresholdRange.value}%`;

        cooldownMs = (parseInt(s.cooldown_seconds) || 8) * 1000;
        cooldownRange.value = s.cooldown_seconds || 8;
        cooldownValueLabel.textContent = `${cooldownRange.value}s`;

        videoClipsEnabled.checked = s.video_clips_enabled !== 'false';

        retentionRange.value = s.retention_days || 15;
        retentionValueLabel.textContent = `${retentionRange.value} días`;
        statRetentionInfo.textContent = `${retentionRange.value} Días`;

        if (s.roi_zone) {
            try {
                const parsedRoi = JSON.parse(s.roi_zone);
                activeROI = parsedRoi;
                if (activeROI.enabled) {
                    roiBox.style.display = 'block';
                    btnToggleROI.className = 'btn btn-cyan btn-outline-cyan active';
                    roiBtnText.textContent = 'ROI: ON';
                    updateROIElement();
                }
            } catch (_) {}
        }
    } catch (e) {
        console.warn('Error al cargar configuración:', e);
    }
}

aiThresholdRange.addEventListener('input', () => {
    thresholdValueLabel.textContent = `${aiThresholdRange.value}%`;
    detectionThreshold = aiThresholdRange.value / 100;
});

cooldownRange.addEventListener('input', () => {
    cooldownValueLabel.textContent = `${cooldownRange.value}s`;
    cooldownMs = cooldownRange.value * 1000;
});

retentionRange.addEventListener('input', () => {
    retentionValueLabel.textContent = `${retentionRange.value} días`;
});

// Guardar ajustes
btnSaveSettings.addEventListener('click', async () => {
    const payload = {
        telegram_enabled: telegramEnabledInput.checked ? 'true' : 'false',
        telegram_bot_token: telegramTokenInput.value.trim(),
        telegram_chat_id: telegramChatIdInput.value.trim(),
        ai_threshold: (aiThresholdRange.value / 100).toString(),
        cooldown_seconds: cooldownRange.value.toString(),
        video_clips_enabled: videoClipsEnabled.checked ? 'true' : 'false',
        retention_days: retentionRange.value.toString()
    };

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            statRetentionInfo.textContent = `${retentionRange.value} Días`;
            settingsModal.hide();
            alert('Ajustes guardados con éxito.');
        }
    } catch (e) {
        alert('Error al guardar ajustes.');
    }
});

// Probar conexión con Telegram
btnTestTelegram.addEventListener('click', async () => {
    const token = telegramTokenInput.value.trim();
    const chatId = telegramChatIdInput.value.trim();

    if (!token || !chatId) {
        telegramTestResult.textContent = 'Ingresa Token y Chat ID';
        telegramTestResult.className = 'small text-danger';
        return;
    }

    telegramTestResult.textContent = 'Enviando prueba...';
    telegramTestResult.className = 'small text-warning';

    try {
        const res = await fetch('/api/settings/test-telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, chatId })
        });
        const data = await res.json();
        if (data.success) {
            telegramTestResult.textContent = '¡Mensaje recibido!';
            telegramTestResult.className = 'small text-emerald fw-bold';
        } else {
            telegramTestResult.textContent = `Error: ${data.error}`;
            telegramTestResult.className = 'small text-danger';
        }
    } catch (e) {
        telegramTestResult.textContent = 'Error de conexión';
        telegramTestResult.className = 'small text-danger';
    }
});

// Purgar grabaciones manualmente
btnManualCleanup.addEventListener('click', async () => {
    if (!confirm('¿Deseas purgar ahora las grabaciones que superen los días de retención?')) return;
    try {
        const res = await fetch('/api/cleanup', { method: 'POST' });
        const data = await res.json();
        alert(`Purga completada: ${data.purgedCount} evento(s) eliminados.`);
        loadStats();
        loadCapturedEvents();
        loadTimeline();
    } catch (e) {
        alert('Error al ejecutar purga.');
    }
});

function saveRoiSettings() {
    fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roi_zone: JSON.stringify(activeROI) })
    }).catch(() => {});
}