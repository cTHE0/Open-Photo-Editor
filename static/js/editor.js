/**
 * Open Photo Editor — Frontend Logic
 * All processing is server-side (local), no third-party services.
 */

"use strict";

// ── STATE ──────────────────────────────────────────────────────
const state = {
  fileId: null,
  originalExt: null,
  originalWidth: 0,
  originalHeight: 0,
  imageMode: '',
  zoom: 1,
  debounceTimer: null,
  cropActive: false,
  cropStart: null,
  cropRect: null,
  activeCrop: null,
  filters: [],
  transforms: { rotation: 0, flip_horizontal: false, flip_vertical: false },
  history: [],
  historyIndex: -1,
  adjustments: {
    brightness: 100, contrast: 100, saturation: 100,
    sharpness: 100, exposure: 0, highlights: 0,
    shadows: 0, temperature: 0
  }
};

// ── DOM REFS ───────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const fileInput       = $('fileInput');
const mainImage       = $('mainImage');
const imageWrapper    = $('imageWrapper');
const emptyState      = $('emptyState');
const processing      = $('processingIndicator');
const infoBar         = $('infoBar');
const imageDimensions = $('imageDimensions');
const imageMode       = $('imageMode');
const miniPreview     = $('miniPreview');
const downloadBtn     = $('downloadBtn');
const undoBtn         = $('undoBtn');
const canvasArea      = document.querySelector('.canvas-area');
const cropOverlay     = $('cropOverlay');
const cropBox         = $('cropBox');
const cropToggleBtn   = $('cropToggleBtn');
const applyCropBtn    = $('applyCropBtn');
const cancelCropBtn   = $('cancelCropBtn');
const activeFilters   = $('activeFilters');

// ── HELPERS ────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = $('toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function showProcessing(show) {
  processing.style.display = show ? 'flex' : 'none';
}

function updateZoomDisplay() {
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
  imageWrapper.style.transform = `scale(${state.zoom})`;
}

// ── FILE UPLOAD ────────────────────────────────────────────────
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await uploadFile(file);
});

async function uploadFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Fichier non supporté', 'error');
    return;
  }

  showProcessing(true);
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Upload failed');

    state.fileId = data.file_id;
    state.originalExt = data.original_ext;
    state.originalWidth = data.width;
    state.originalHeight = data.height;
    state.imageMode = data.mode;

    // Reset all state
    resetAllState();

    // Show image
    mainImage.src = data.preview;
    imageWrapper.style.display = 'inline-block';
    emptyState.style.display = 'none';
    infoBar.style.display = 'flex';
    downloadBtn.disabled = false;

    // Update info
    imageDimensions.textContent = `${data.width} × ${data.height} px`;
    imageMode.textContent = data.mode;
    updateRightPanel(data.width, data.height, data.mode);
    updateMiniPreview(data.preview);

    // Fit zoom
    fitZoom();

    // Push initial history
    pushHistory('Original');

    showToast(`Image chargée : ${data.width}×${data.height}`, 'success');
  } catch (err) {
    showToast('Erreur : ' + err.message, 'error');
  } finally {
    showProcessing(false);
  }
}

function resetAllState() {
  state.zoom = 1;
  state.filters = [];
  state.transforms = { rotation: 0, flip_horizontal: false, flip_vertical: false };
  state.activeCrop = null;
  state.adjustments = {
    brightness: 100, contrast: 100, saturation: 100,
    sharpness: 100, exposure: 0, highlights: 0,
    shadows: 0, temperature: 0
  };
  state.history = [];
  state.historyIndex = -1;

  // Reset slider UI
  $$('.slider[data-param]').forEach(sl => {
    sl.value = sl.defaultValue;
    updateSliderVal(sl);
  });

  // Reset filter buttons
  $$('.filter-btn').forEach(btn => btn.classList.remove('active'));
  updateActiveFiltersDisplay();

  // Reset transform state
  updateTransformState();

  // Cancel crop
  cancelCrop();
}

// ── SLIDERS ────────────────────────────────────────────────────
function updateSliderVal(slider) {
  const param = slider.dataset.param;
  if (param) {
    const valEl = $(param + '-val');
    if (valEl) valEl.textContent = slider.value;
    state.adjustments[param] = parseFloat(slider.value);
  }
}

$$('.slider[data-param]').forEach(slider => {
  slider.addEventListener('input', () => {
    updateSliderVal(slider);
    scheduleProcess();
  });
  slider.addEventListener('change', () => {
    if (state.fileId) pushHistory('Ajustement');
  });
});

// Quality display
$('exportQuality').addEventListener('input', (e) => {
  $('quality-val').textContent = e.target.value;
});

// ── DEBOUNCED PROCESS ──────────────────────────────────────────
function scheduleProcess(delay = 350) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => processImage(), delay);
}

async function processImage() {
  if (!state.fileId) return;

  showProcessing(true);

  const payload = {
    file_id: state.fileId,
    original_ext: state.originalExt,
    adjustments: { ...state.adjustments },
    filters: [...state.filters],
    transforms: { ...state.transforms },
    crop: state.activeCrop
  };

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    mainImage.src = data.preview;
    updateMiniPreview(data.preview);
    imageDimensions.textContent = `${data.width} × ${data.height} px`;
    updateRightPanel(data.width, data.height, state.imageMode);

  } catch (err) {
    showToast('Erreur de traitement', 'error');
    console.error(err);
  } finally {
    showProcessing(false);
  }
}

// ── FILTERS ────────────────────────────────────────────────────
$$('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter;
    if (!state.fileId) { showToast('Chargez une image d\'abord', 'info'); return; }

    if (btn.classList.contains('active')) {
      state.filters = state.filters.filter(f => f !== filter);
      btn.classList.remove('active');
    } else {
      state.filters.push(filter);
      btn.classList.add('active');
    }

    updateActiveFiltersDisplay();
    scheduleProcess(100);
    pushHistory(`Filtre : ${filter}`);
  });
});

$('clearFiltersBtn').addEventListener('click', () => {
  state.filters = [];
  $$('.filter-btn').forEach(b => b.classList.remove('active'));
  updateActiveFiltersDisplay();
  if (state.fileId) { scheduleProcess(100); pushHistory('Filtres effacés'); }
});

function updateActiveFiltersDisplay() {
  const noEl = activeFilters.querySelector('.no-filters');
  const tags = activeFilters.querySelectorAll('.filter-tag');
  tags.forEach(t => t.remove());

  if (state.filters.length === 0) {
    if (!noEl) {
      const s = document.createElement('span');
      s.className = 'no-filters'; s.textContent = 'Aucun';
      activeFilters.appendChild(s);
    }
  } else {
    if (noEl) noEl.remove();
    state.filters.forEach(f => {
      const tag = document.createElement('span');
      tag.className = 'filter-tag';
      tag.textContent = f;
      activeFilters.appendChild(tag);
    });
  }
}

// ── TRANSFORMS ────────────────────────────────────────────────
$('rotateLeft').addEventListener('click', () => {
  if (!state.fileId) return;
  state.transforms.rotation = (state.transforms.rotation - 90 + 360) % 360;
  updateTransformState();
  scheduleProcess(100);
  pushHistory('Rotation −90°');
});

$('rotateRight').addEventListener('click', () => {
  if (!state.fileId) return;
  state.transforms.rotation = (state.transforms.rotation + 90) % 360;
  updateTransformState();
  scheduleProcess(100);
  pushHistory('Rotation +90°');
});

$('flipH').addEventListener('click', () => {
  if (!state.fileId) return;
  state.transforms.flip_horizontal = !state.transforms.flip_horizontal;
  updateTransformState();
  scheduleProcess(100);
  pushHistory('Miroir horizontal');
});

$('flipV').addEventListener('click', () => {
  if (!state.fileId) return;
  state.transforms.flip_vertical = !state.transforms.flip_vertical;
  updateTransformState();
  scheduleProcess(100);
  pushHistory('Miroir vertical');
});

$('resetTransformBtn').addEventListener('click', () => {
  state.transforms = { rotation: 0, flip_horizontal: false, flip_vertical: false };
  updateTransformState();
  if (state.fileId) { scheduleProcess(100); pushHistory('Transforms réinitialisés'); }
});

function updateTransformState() {
  $('state-rotation').textContent = state.transforms.rotation + '°';
  $('state-flipH').textContent = state.transforms.flip_horizontal ? 'Oui' : 'Non';
  $('state-flipV').textContent = state.transforms.flip_vertical ? 'Oui' : 'Non';
}

// ── RESET ADJUSTMENTS ─────────────────────────────────────────
$('resetBtn').addEventListener('click', () => {
  const defaults = { brightness: 100, contrast: 100, saturation: 100, sharpness: 100, exposure: 0, highlights: 0, shadows: 0, temperature: 0 };
  Object.entries(defaults).forEach(([k, v]) => {
    const el = $(k);
    if (el) { el.value = v; state.adjustments[k] = v; }
    const val = $(k + '-val');
    if (val) val.textContent = v;
  });
  if (state.fileId) { scheduleProcess(100); pushHistory('Réglages réinitialisés'); }
});

// ── CROP ──────────────────────────────────────────────────────
cropToggleBtn.addEventListener('click', () => {
  if (!state.fileId) { showToast('Chargez une image d\'abord', 'info'); return; }
  state.cropActive = !state.cropActive;

  if (state.cropActive) {
    cropOverlay.style.display = 'block';
    cropToggleBtn.textContent = '✕ Annuler recadrage';
    cropToggleBtn.classList.add('active-tool');
    applyCropBtn.style.display = '';
    cancelCropBtn.style.display = '';
    showToast('Dessinez une zone de recadrage', 'info');
  } else {
    cancelCrop();
  }
});

applyCropBtn.addEventListener('click', () => {
  if (!state.cropRect) { showToast('Dessinez une zone d\'abord', 'info'); return; }

  // Convert screen coords to original image coords
  const imgRect = mainImage.getBoundingClientRect();
  const scaleX = state.originalWidth / imgRect.width * state.zoom;
  const scaleY = state.originalHeight / imgRect.height * state.zoom;

  // Get crop box position relative to image
  const boxRect = cropBox.getBoundingClientRect();
  state.activeCrop = {
    x: Math.round((boxRect.left - imgRect.left) * scaleX / state.zoom),
    y: Math.round((boxRect.top - imgRect.top) * scaleY / state.zoom),
    width: Math.round(boxRect.width * scaleX / state.zoom),
    height: Math.round(boxRect.height * scaleY / state.zoom)
  };

  cancelCrop();
  scheduleProcess(100);
  pushHistory('Recadrage appliqué');
  showToast('Recadrage appliqué', 'success');
});

cancelCropBtn.addEventListener('click', cancelCrop);

function cancelCrop() {
  state.cropActive = false;
  cropOverlay.style.display = 'none';
  cropBox.style.display = 'none';
  cropBox.style.width = '0';
  cropBox.style.height = '0';
  state.cropRect = null;
  cropToggleBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 2 6 18 22 18"/><polyline points="2 6 18 6 18 22"/></svg> Activer le recadrage';
  cropToggleBtn.classList.remove('active-tool');
  applyCropBtn.style.display = 'none';
  cancelCropBtn.style.display = 'none';
}

// Crop drag
let isDragging = false;
let startX, startY;

cropOverlay.addEventListener('mousedown', (e) => {
  if (!state.cropActive) return;
  const overlayRect = cropOverlay.getBoundingClientRect();
  startX = e.clientX - overlayRect.left;
  startY = e.clientY - overlayRect.top;
  isDragging = true;
  cropBox.style.display = 'block';
  cropBox.style.left = startX + 'px';
  cropBox.style.top = startY + 'px';
  cropBox.style.width = '0';
  cropBox.style.height = '0';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging || !state.cropActive) return;
  const overlayRect = cropOverlay.getBoundingClientRect();
  const currentX = Math.max(0, Math.min(e.clientX - overlayRect.left, overlayRect.width));
  const currentY = Math.max(0, Math.min(e.clientY - overlayRect.top, overlayRect.height));

  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const w = Math.abs(currentX - startX);
  const h = Math.abs(currentY - startY);

  cropBox.style.left = x + 'px';
  cropBox.style.top = y + 'px';
  cropBox.style.width = w + 'px';
  cropBox.style.height = h + 'px';
  state.cropRect = { x, y, width: w, height: h };
});

document.addEventListener('mouseup', () => { isDragging = false; });

// ── ZOOM ──────────────────────────────────────────────────────
$('zoomIn').addEventListener('click', () => {
  state.zoom = Math.min(state.zoom * 1.25, 5);
  updateZoomDisplay();
});
$('zoomOut').addEventListener('click', () => {
  state.zoom = Math.max(state.zoom * 0.8, 0.1);
  updateZoomDisplay();
});
$('zoomFit').addEventListener('click', fitZoom);

function fitZoom() {
  if (!state.fileId) return;
  const area = canvasArea.getBoundingClientRect();
  const imgW = mainImage.naturalWidth || state.originalWidth;
  const imgH = mainImage.naturalHeight || state.originalHeight;
  const scaleX = (area.width - 60) / imgW;
  const scaleY = (area.height - 80) / imgH;
  state.zoom = Math.min(scaleX, scaleY, 1);
  updateZoomDisplay();
}

// Wheel zoom
canvasArea.addEventListener('wheel', (e) => {
  if (!state.fileId) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  state.zoom = Math.max(0.1, Math.min(state.zoom * delta, 5));
  updateZoomDisplay();
}, { passive: false });

// ── TABS ──────────────────────────────────────────────────────
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── HISTORY ───────────────────────────────────────────────────
function pushHistory(label) {
  const entry = {
    label,
    timestamp: Date.now(),
    adjustments: { ...state.adjustments },
    filters: [...state.filters],
    transforms: { ...state.transforms },
    activeCrop: state.activeCrop ? { ...state.activeCrop } : null
  };

  // Remove future entries if we're not at the end
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(entry);
  state.historyIndex = state.history.length - 1;

  // Limit history to 20 entries
  if (state.history.length > 20) {
    state.history.shift();
    state.historyIndex--;
  }

  renderHistory();
  undoBtn.disabled = state.historyIndex <= 0;
}

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';

  if (state.history.length === 0) {
    list.innerHTML = '<p class="no-history">Aucune modification</p>';
    return;
  }

  [...state.history].reverse().forEach((entry, rIdx) => {
    const idx = state.history.length - 1 - rIdx;
    const item = document.createElement('div');
    item.className = 'history-item' + (idx === state.historyIndex ? ' current' : '');
    item.innerHTML = `<div class="history-dot"></div><span>${entry.label}</span>`;
    item.addEventListener('click', () => restoreHistory(idx));
    list.appendChild(item);
  });
}

function restoreHistory(idx) {
  const entry = state.history[idx];
  if (!entry) return;

  state.historyIndex = idx;
  Object.assign(state.adjustments, entry.adjustments);
  state.filters = [...entry.filters];
  state.transforms = { ...entry.transforms };
  state.activeCrop = entry.activeCrop ? { ...entry.activeCrop } : null;

  // Sync sliders
  Object.entries(state.adjustments).forEach(([k, v]) => {
    const el = $(k);
    if (el) { el.value = v; }
    const val = $(k + '-val');
    if (val) val.textContent = v;
  });

  // Sync filter buttons
  $$('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', state.filters.includes(btn.dataset.filter));
  });
  updateActiveFiltersDisplay();
  updateTransformState();
  renderHistory();
  scheduleProcess(100);
  undoBtn.disabled = state.historyIndex <= 0;
}

$('undoBtn').addEventListener('click', () => {
  if (state.historyIndex > 0) restoreHistory(state.historyIndex - 1);
});

// ── DOWNLOAD ──────────────────────────────────────────────────
downloadBtn.addEventListener('click', async () => {
  if (!state.fileId) return;

  showProcessing(true);
  showToast('Préparation du téléchargement…', 'info');

  const payload = {
    file_id: state.fileId,
    original_ext: state.originalExt,
    adjustments: { ...state.adjustments },
    filters: [...state.filters],
    transforms: { ...state.transforms },
    crop: state.activeCrop,
    format: $('exportFormat').value,
    quality: parseInt($('exportQuality').value)
  };

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Download failed');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edited_photo.${$('exportFormat').value}`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Image téléchargée !', 'success');
  } catch (err) {
    showToast('Erreur lors du téléchargement', 'error');
  } finally {
    showProcessing(false);
  }
});

// PNG shows no quality slider
$('exportFormat').addEventListener('change', (e) => {
  $('qualityRow').style.display = e.target.value === 'png' ? 'none' : '';
});

// ── DRAG & DROP ───────────────────────────────────────────────
canvasArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  canvasArea.classList.add('drag-over');
});
canvasArea.addEventListener('dragleave', () => canvasArea.classList.remove('drag-over'));
canvasArea.addEventListener('drop', (e) => {
  e.preventDefault();
  canvasArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

// ── HELPERS ───────────────────────────────────────────────────
function updateMiniPreview(src) {
  miniPreview.innerHTML = '';
  const img = document.createElement('img');
  img.src = src;
  miniPreview.appendChild(img);
}

function updateRightPanel(w, h, mode) {
  $('imageInfo').style.display = '';
  $('info-width').textContent = w + ' px';
  $('info-height').textContent = h + ' px';
  $('info-mode').textContent = mode;
}

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); $('undoBtn').click(); }
    if (e.key === 's') { e.preventDefault(); downloadBtn.click(); }
    if (e.key === 'o') { e.preventDefault(); fileInput.click(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); $('zoomIn').click(); }
    if (e.key === '-') { e.preventDefault(); $('zoomOut').click(); }
    if (e.key === '0') { e.preventDefault(); fitZoom(); }
  }
  if (e.key === 'Escape') cancelCrop();
});

// ── INIT ──────────────────────────────────────────────────────
updateTransformState();
updateActiveFiltersDisplay();
console.log('%cOpen Photo Editor v1.0', 'color:#e8c547;font-family:monospace;font-size:14px;font-weight:bold');
console.log('%cOpen Source — Processing is 100% local', 'color:#666678;font-family:monospace');
