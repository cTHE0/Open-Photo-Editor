"use strict";
/**
 * Open Photo Editor v4.0 - OPTIMIZED
 * Fixes:
 *  - Image moves with frame (not just frame)
 *  - Instant preview without "Apply" button
 *  - Reduced latency with optimized rendering
 *  - Filters working correctly
 *  - JPG support fixed
 */

// ══════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

let _toastT;
function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 2000);
}
function busy(v) { $('processing').style.display = v ? 'flex' : 'none'; }

// Optimized throttle - immediate execution then rate-limited
function throttle(func, limit) {
  let lastTime = 0;
  return function(...args) {
    const now = Date.now();
    if (now - lastTime >= limit) {
      lastTime = now;
      return func.apply(this, args);
    }
  };
}

// Optimized debounce
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════
const S = {
  projectId: null,
  _creating: false,
  layers: [],
  activeId: null,
  canvasW: 0,
  canvasH: 0,
  zoom: 1, panX: 0, panY: 0,
  tool: 'select',
  drag: null,
  
  // Optimized: single sync timer for all updates
  _syncTimer: null,
  _pendingSync: false,
  
  // Offscreen canvas for instant preview
  offscreen: null,
  layerImages: {},
  
  // Undo/Redo
  _history: [],
  _historyIndex: -1,
  _maxHistory: 30,
  _historyLock: false,
  
  // Current color for brush/fill
 currentColor: '#ffffff',
};

// ══════════════════════════════════════════════════════════════
// UNDO/REDO SYSTEM (Optimized)
// ══════════════════════════════════════════════════════════════

function pushHistory(action = 'edit') {
  if (S._historyLock || !S.projectId) return;
  if (S._historyIndex < S._history.length - 1) {
    S._history = S._history.slice(0, S._historyIndex + 1);
  }
  const snapshot = {
    action: action,
    layers: S.layers.map(l => ({
      id: l.id, name: l.name, type: l.type, visible: l.visible,
      opacity: l.opacity, blend_mode: l.blend_mode,
      x: l.x, y: l.y, display_w: l.display_w, display_h: l.display_h,
      display_rotation: l.display_rotation, has_image: !!l.image_data
    })),
    canvasW: S.canvasW, canvasH: S.canvasH, timestamp: Date.now()
  };
  S._history.push(snapshot);
  S._historyIndex = S._history.length - 1;
  if (S._history.length > S._maxHistory) {
    S._history.shift();
    S._historyIndex--;
  }
  updateUndoButton();
}

function undo() {
  if (S._historyIndex <= 0 || !S.projectId) { toast('Rien à annuler', 'info'); return; }
  S._historyLock = true;
  S._historyIndex--;
  restoreState(S._history[S._historyIndex], 'Annulé');
  S._historyLock = false;
  updateUndoButton();
}

function redo() {
  if (S._historyIndex >= S._history.length - 1 || !S.projectId) { toast('Rien à rétablir', 'info'); return; }
  S._historyLock = true;
  S._historyIndex++;
  restoreState(S._history[S._historyIndex], 'Rétabli');
  S._historyLock = false;
  updateUndoButton();
}

async function restoreState(state, msg) {
  busy(true);
  S.canvasW = state.canvasW; S.canvasH = state.canvasH;
  // Restore layer positions from history
  state.layers.forEach(h => {
    const layer = S.layers.find(l => l.id === h.id);
    if (layer) {
      layer.x = h.x; layer.y = h.y;
      layer.display_w = h.display_w; layer.display_h = h.display_h;
      layer.display_rotation = h.display_rotation;
    }
  });
  initScene(); renderLayerList();
  if (S.layers.length > 0) setActive(S.layers[0].id);
  await syncAllLayers();
  toast(msg, 'success');
  busy(false);
}

function updateUndoButton() {
  const undoBtn = $('undoBtn');
  if (undoBtn) {
    undoBtn.disabled = S._historyIndex <= 0;
    undoBtn.textContent = S._historyIndex <= 0 ? '↩ Annuler' : `↩ Annuler (${S._historyIndex})`;
  }
}

// Section toggles
document.querySelectorAll('[data-toggle]').forEach(hdr => {
  const body = $(hdr.dataset.toggle);
  const chevron = hdr.querySelector('.chevron');
  if (!body) return;
  hdr.addEventListener('click', () => {
    const open = body.classList.toggle('open');
    if (chevron) chevron.classList.toggle('open', open);
  });
});

// Tool picker
$$('[data-tool]').forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

function setTool(tool) {
  S.tool = tool;
  $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  $('canvasScene').classList.toggle('panning', tool === 'pan');
  if (tool !== 'crop') { $('cropOverlay').style.display = 'none'; clearCropShades(); }
  else if (S.projectId) initCrop();
  updateBoxVisibility();
}

// File upload
['fileInput', 'fileInputEmpty'].forEach(id => {
  $(id).addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) uploadAndAddImage(f);
  });
});

$('addLayerImageInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) await uploadAndAddImage(f);
});

async function uploadAndAddImage(file) {
  if (!file.type.startsWith('image/')) { toast('Format non supporté', 'error'); return; }
  busy(true);
  try {
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    await ensureProject(d.width, d.height);
    await addLayerToServer({ type: 'image', file_id: d.file_id, name: file.name.replace(/\.[^.]+$/, '') });
  } catch (err) { toast('Erreur : ' + err.message, 'error'); console.error(err); }
  finally { busy(false); }
}

// Drag & drop
const cwrap = document.querySelector('.canvas-wrap');
cwrap.addEventListener('dragover', e => { e.preventDefault(); cwrap.classList.add('drag-over'); });
cwrap.addEventListener('dragleave', () => cwrap.classList.remove('drag-over'));
cwrap.addEventListener('drop', e => {
  e.preventDefault(); cwrap.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) uploadAndAddImage(f);
});

// Project creation
let _projectReadyResolve = null;
async function ensureProject(w, h) {
  if (S.projectId) return;
  if (S._creating) {
    await new Promise((resolve, reject) => {
      _projectReadyResolve = resolve;
      setTimeout(() => reject(new Error('Project creation timeout')), 5000);
    });
    return;
  }
  await createProject(w, h);
}

async function createProject(w, h) {
  S._creating = true;
  try {
    const W = w || parseInt($('newW').value) || 1920;
    const H = h || parseInt($('newH').value) || 1080;
    const r = await fetch('/api/project/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: W, height: H })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    S.projectId = d.project_id; S.canvasW = d.width; S.canvasH = d.height; S.layers = [];
    initScene();
  } finally {
    S._creating = false;
    if (_projectReadyResolve) { _projectReadyResolve(); _projectReadyResolve = null; }
  }
}

function initScene() {
  $('canvasBg').style.width = S.canvasW + 'px';
  $('canvasBg').style.height = S.canvasH + 'px';
  $('compositeImg').style.width = S.canvasW + 'px';
  $('compositeImg').style.height = S.canvasH + 'px';
  $('emptyState').style.display = 'none';
  $('canvasScene').style.display = '';
  $('infoBar').style.display = 'flex';
  $('rpInfo').style.display = '';
  $('exportBtn').disabled = false;
  $('saveProjectBtn').disabled = false;
  $('downloadBtn').disabled = false;
  $('mergeBtn').disabled = false;
  $('flattenBtn').disabled = false;
  pushHistory('init');
  updateUndoButton();
  updateRPInfo();
  fitZoom();
}

// Add layer buttons
$('addSolidBtn').addEventListener('click', async () => {
  busy(true);
  try { await ensureProject(); await addLayerToServer({ type: 'solid', color: '#3a3a5c', name: 'Couleur unie' }); }
  catch (e) { toast('Erreur : ' + e.message, 'error'); }
  finally { busy(false); }
});

$('addGradientBtn').addEventListener('click', async () => {
  busy(true);
  try { await ensureProject(); await addLayerToServer({ type: 'gradient', color1: '#1a1a2e', color2: '#e8c547', angle: 135, name: 'Dégradé' }); }
  catch (e) { toast('Erreur : ' + e.message, 'error'); }
  finally { busy(false); }
});

$('addTextBtn').addEventListener('click', async () => {
  const txt = prompt('Texte :', 'Open Photo Editor');
  if (!txt) return;
  busy(true);
  try { await ensureProject(); await addLayerToServer({ type: 'text', text: txt, font_size: 72, color: '#ffffff', x: 80, y: 80, name: 'Texte' }); }
  catch (e) { toast('Erreur : ' + e.message, 'error'); }
  finally { busy(false); }
});

$('addRectBtn').addEventListener('click', async () => {
  busy(true);
  try { await ensureProject(); await addLayerToServer({ type: 'shape', shape: 'rectangle', color: '#3a3a5c', x: 50, y: 50, width: 200, height: 150, name: 'Rectangle' }); }
  catch (e) { toast('Erreur : ' + e.message, 'error'); }
  finally { busy(false); }
});

$('addEllipseBtn').addEventListener('click', async () => {
  busy(true);
  try { await ensureProject(); await addLayerToServer({ type: 'shape', shape: 'ellipse', color: '#3a3a5c', x: 50, y: 50, width: 200, height: 150, name: 'Ellipse' }); }
  catch (e) { toast('Erreur : ' + e.message, 'error'); }
  finally { busy(false); }
});

$('newProjectBtn').addEventListener('click', async () => {
  S.projectId = null;
  busy(true);
  try { await createProject(); }
  catch (e) { toast('Erreur : ' + e.message, 'error'); }
  finally { busy(false); }
});

// ══════════════════════════════════════════════════════════════
// SERVER API (Optimized with batch sync)
// ══════════════════════════════════════════════════════════════

async function addLayerToServer(params) {
  if (!S.projectId) throw new Error('No active project');
  const r = await fetch(`/api/project/${S.projectId}/layer/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const d = await r.json();
  if (!d.success) throw new Error(d.error);
  if (d.canvas_width) { S.canvasW = d.canvas_width; S.canvasH = d.canvas_height; initScene(); }
  await cacheLayerImage(d.layer.id, d.preview);
  S.layers.push(d.layer);
  setPreview(d.preview);
  renderLayerList();
  setActive(d.layer.id);
  updateRPInfo();
  pushHistory('add_layer');
  updateUndoButton();
  toast('Calque ajouté : ' + d.layer.name, 'success');
  return d.layer;
}

// Optimized: batch server updates
async function serverUpdateLayer(id, data, skipCache = false) {
  if (!S.projectId || !id) return null;
  
  // Update local state immediately for instant preview
  const layer = S.layers.find(l => l.id === id);
  if (layer) {
    Object.assign(layer, data);
    updateBox(layer);
    drawLocalPreview(layer);
  }
  
  // Debounce server sync
  clearTimeout(S._syncTimer);
  S._syncTimer = setTimeout(async () => {
    S._pendingSync = true;
    try {
      const r = await fetch(`/api/project/${S.projectId}/layer/${id}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const d = await r.json();
      if (d.success && d.preview) {
        await cacheLayerImage(id, d.preview);
        setPreview(d.preview);
      }
    } catch (e) { console.warn('Sync failed:', e); }
    finally { S._pendingSync = false; }
  }, 300); // 300ms debounce
  
  return null;
}

async function syncAllLayers() {
  if (!S.projectId || !S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  try {
    const r = await fetch(`/api/project/${S.projectId}/layer/${S.activeId}/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const d = await r.json();
    if (d.success && d.preview) {
      await cacheLayerImage(S.activeId, d.preview);
      setPreview(d.preview);
    }
  } catch (e) { console.warn('Sync failed:', e); }
}

async function deleteLayerFromServer(id) {
  pushHistory('delete_layer');
  const r = await fetch(`/api/project/${S.projectId}/layer/${id}/delete`, { method: 'POST' });
  const d = await r.json();
  S.layers = S.layers.filter(l => l.id !== id);
  delete S.layerImages[id];
  if (S.activeId === id) { S.activeId = null; hideBox(); }
  setPreview(d.preview);
  renderLayerList();
  updateRPInfo();
  hideSelectedLayerPanel();
  updateUndoButton();
  toast('Calque supprimé', 'info');
}

async function duplicateLayerServer(id) {
  pushHistory('duplicate_layer');
  const r = await fetch(`/api/project/${S.projectId}/layer/${id}/duplicate`, { method: 'POST' });
  const d = await r.json();
  const src = S.layers.findIndex(l => l.id === id);
  S.layers.splice(src + 1, 0, d.layer);
  await cacheLayerImage(d.layer.id, d.preview);
  setPreview(d.preview);
  renderLayerList();
  setActive(d.layer.id);
  updateRPInfo();
}

async function reorderServer() {
  const r = await fetch(`/api/project/${S.projectId}/layers/reorder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: S.layers.map(l => l.id) })
  });
  const d = await r.json();
  setPreview(d.preview);
  renderLayerList();
}

async function cacheLayerImage(id, previewSrc) {
  if (!previewSrc) return;
  return new Promise(res => {
    const img = new Image();
    img.onload = () => { S.layerImages[id] = img; res(); };
    img.onerror = res;
    img.src = previewSrc;
  });
}

function setPreview(src) {
  $('compositeImg').src = src;
  $('infoSize').textContent = `${S.canvasW} × ${S.canvasH}`;
}

// ══════════════════════════════════════════════════════════════
// INSTANT CANVAS PREVIEW (Fixed - image moves with frame)
// ══════════════════════════════════════════════════════════════

let _previewCanvas = null;
let _previewCtx = null;

function getPreviewCanvas() {
  if (_previewCanvas) return _previewCanvas;
  _previewCanvas = document.createElement('canvas');
  _previewCanvas.style.cssText = 'position:absolute;inset:0;z-index:5;pointer-events:none;';
  _previewCanvas.width = S.canvasW;
  _previewCanvas.height = S.canvasH;
  $('canvasBg').appendChild(_previewCanvas);
  _previewCtx = _previewCanvas.getContext('2d');
  return _previewCanvas;
}

function drawLocalPreview(layer) {
  const cv = getPreviewCanvas();
  cv.width = S.canvasW; cv.height = S.canvasH;
  const ctx = _previewCtx;
  ctx.clearRect(0, 0, S.canvasW, S.canvasH);
  
  const img = S.layerImages[layer.id];
  if (!img) return;
  
  const lx = layer.x || 0;
  const ly = layer.y || 0;
  const lw = layer.display_w || layer.orig_width || S.canvasW;
  const lh = layer.display_h || layer.orig_height || S.canvasH;
  const rot = layer.display_rotation || 0;
  
  ctx.save();
  ctx.globalAlpha = (layer.opacity ?? 100) / 100;
  
  // Apply transform at layer position
  ctx.translate(lx, ly);
  if (rot) {
    ctx.translate(lw/2, lh/2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.translate(-lw/2, -lh/2);
  }
  ctx.drawImage(img, 0, 0, lw, lh);
  ctx.restore();
  
  $('compositeImg').style.opacity = '0.3';
  cv.style.display = '';
}

function clearLocalPreview() {
  if (_previewCanvas) {
    _previewCtx.clearRect(0, 0, _previewCanvas.width, _previewCanvas.height);
    _previewCanvas.style.display = 'none';
  }
  $('compositeImg').style.opacity = '1';
}

// ══════════════════════════════════════════════════════════════
// VIEWPORT
// ══════════════════════════════════════════════════════════════

function applyVP() {
  $('viewport').style.transform = `translate(calc(-50% + ${S.panX}px), calc(-50% + ${S.panY}px)) scale(${S.zoom})`;
  $('zoomDisplay').textContent = Math.round(S.zoom * 100) + '%';
}

function fitZoom() {
  const wr = document.querySelector('.canvas-wrap').getBoundingClientRect();
  S.zoom = Math.min((wr.width - 80) / S.canvasW, (wr.height - 80) / S.canvasH, 1);
  S.panX = 0; S.panY = 0;
  applyVP();
}

$('zoomIn').addEventListener('click', () => { S.zoom = Math.min(S.zoom * 1.25, 8); applyVP(); });
$('zoomOut').addEventListener('click', () => { S.zoom = Math.max(S.zoom * 0.8, 0.05); applyVP(); });
$('zoomFit').addEventListener('click', fitZoom);
$('zoom100').addEventListener('click', () => { S.zoom = 1; S.panX = 0; S.panY = 0; applyVP(); });

$('canvasScene').addEventListener('wheel', e => {
  e.preventDefault();
  const rect = $('canvasScene').getBoundingClientRect();
  const mx = e.clientX - rect.left - rect.width / 2;
  const my = e.clientY - rect.top - rect.height / 2;
  const f = e.deltaY < 0 ? 1.12 : 0.9;
  const nz = Math.max(0.05, Math.min(S.zoom * f, 8));
  const ratio = nz / S.zoom;
  S.panX = mx - (mx - S.panX) * ratio;
  S.panY = my - (my - S.panY) * ratio;
  S.zoom = nz;
  applyVP();
}, { passive: false });

// ══════════════════════════════════════════════════════════════
// COORD HELPERS
// ══════════════════════════════════════════════════════════════

function s2c(sx, sy) {
  const r = $('canvasScene').getBoundingClientRect();
  return {
    x: (sx - r.left - r.width / 2 - S.panX) / S.zoom,
    y: (sy - r.top - r.height / 2 - S.panY) / S.zoom
  };
}

function c2s(cx, cy) {
  const r = $('canvasScene').getBoundingClientRect();
  return {
    x: cx * S.zoom + S.panX + r.left + r.width / 2,
    y: cy * S.zoom + S.panY + r.top + r.height / 2
  };
}

// ══════════════════════════════════════════════════════════════
// MOUSE INTERACTION
// ══════════════════════════════════════════════════════════════

$('canvasScene').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const bg_targets = [$('canvasBg'), $('compositeImg'), $('canvasScene'), $('viewport'), $('handlesLayer')];
  if (bg_targets.includes(e.target)) {
    if (S.tool === 'pan') { startPan(e); return; }
    if (S.tool === 'select') { setActive(null); return; }
    if (S.tool === 'crop') { startCropDraw(e); return; }
  }
  if (S.tool === 'pan') startPan(e);
});

document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.code === 'Space' && tag === 'BODY') { e.preventDefault(); setTool('pan'); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') setTool('select'); });

function startPan(e) {
  S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY };
  $('canvasScene').classList.add('active');
}

$('moveArea').addEventListener('mousedown', e => {
  if (S.tool !== 'select' || !S.activeId) return;
  e.stopPropagation();
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  const pt = s2c(e.clientX, e.clientY);
  S.drag = { type: 'move', pt, x0: layer.x || 0, y0: layer.y || 0 };
  e.preventDefault();
});

$$('.handle').forEach(h => {
  h.addEventListener('mousedown', e => {
    if (S.tool !== 'select' || !S.activeId) return;
    e.stopPropagation(); e.preventDefault();
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    const pt = s2c(e.clientX, e.clientY);
    S.drag = {
      type: 'resize', handle: h.dataset.handle, pt,
      x0: layer.x || 0, y0: layer.y || 0,
      w0: layer.display_w || layer.orig_width || S.canvasW,
      h0: layer.display_h || layer.orig_height || S.canvasH,
    };
  });
});

$('rotateHandle').addEventListener('mousedown', e => {
  if (S.tool !== 'select' || !S.activeId) return;
  e.stopPropagation(); e.preventDefault();
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  const lx = layer.x || 0, ly = layer.y || 0;
  const lw = layer.display_w || layer.orig_width || S.canvasW;
  const lh = layer.display_h || layer.orig_height || S.canvasH;
  const cx = lx + lw / 2, cy = ly + lh / 2;
  S.drag = {
    type: 'rotate', cx, cy,
    rot0: layer.display_rotation || 0,
    startAngle: angleToPoint(cx, cy, e.clientX, e.clientY),
  };
});

function angleToPoint(cx, cy, mx, my) {
  const sc = c2s(cx, cy);
  return Math.atan2(my - sc.y, mx - sc.x) * 180 / Math.PI;
}

$$('.crop-handle').forEach(h => {
  h.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const pt = s2c(e.clientX, e.clientY);
    S.drag = { type: 'crop-resize', handle: h.dataset.handle, pt, rect0: { ...S.cropRect } };
  });
});

$('cropBox').addEventListener('mousedown', e => {
  if (e.target.classList.contains('crop-handle') || e.target.classList.contains('crop-grid-line')) return;
  e.stopPropagation();
  const pt = s2c(e.clientX, e.clientY);
  S.drag = { type: 'crop-move', pt, rect0: { ...S.cropRect } };
});

// ── Global mousemove ──────────────────────────────────────────
document.addEventListener('mousemove', onMove);

function onMove(e) {
  if ($('canvasScene').style.display !== 'none') {
    const pt = s2c(e.clientX, e.clientY);
    $('infoPos').textContent = `x:${Math.round(pt.x)} y:${Math.round(pt.y)}`;
  }
  if (!S.drag) return;
  const d = S.drag;

  if (d.type === 'pan') {
    S.panX = d.px + (e.clientX - d.sx);
    S.panY = d.py + (e.clientY - d.sy);
    applyVP(); return;
  }

  const layer = S.layers.find(l => l.id === S.activeId);

  if (d.type === 'move' && layer) {
    const pt = s2c(e.clientX, e.clientY);
    layer.x = Math.round(d.x0 + (pt.x - d.pt.x));
    layer.y = Math.round(d.y0 + (pt.y - d.pt.y));
    updateBox(layer);
    $('dimTooltip').textContent = `${layer.x}, ${layer.y}`;
    drawLocalPreview(layer); // FIXED: Now properly draws image at new position
    return;
  }

  if (d.type === 'resize' && layer) {
    const pt = s2c(e.clientX, e.clientY);
    const dx = pt.x - d.pt.x, dy = pt.y - d.pt.y;
    let { x0: x, y0: y, w0: w, h0: h } = d;
    const hs = d.handle;
    if (hs.includes('e')) w = Math.max(10, d.w0 + dx);
    if (hs.includes('s')) h = Math.max(10, d.h0 + dy);
    if (hs.includes('w')) { x = d.x0 + dx; w = Math.max(10, d.w0 - dx); }
    if (hs.includes('n')) { y = d.y0 + dy; h = Math.max(10, d.h0 - dy); }
    layer.x = Math.round(x); layer.y = Math.round(y);
    layer.display_w = Math.round(w); layer.display_h = Math.round(h);
    updateBox(layer);
    $('dimTooltip').textContent = `${Math.round(w)} × ${Math.round(h)}`;
    drawLocalPreview(layer);
    return;
  }

  if (d.type === 'rotate' && layer) {
    const cur = angleToPoint(d.cx, d.cy, e.clientX, e.clientY);
    let rot = d.rot0 + (cur - d.startAngle);
    if (e.shiftKey) rot = Math.round(rot / 15) * 15;
    layer.display_rotation = rot;
    updateBox(layer);
    $('dimTooltip').textContent = `${Math.round(rot)}°`;
    drawLocalPreview(layer);
    return;
  }

  if (d.type === 'crop-draw') {
    const pt = s2c(e.clientX, e.clientY);
    S.cropRect = {
      x: Math.min(pt.x, d.pt.x), y: Math.min(pt.y, d.pt.y),
      w: Math.abs(pt.x - d.pt.x), h: Math.abs(pt.y - d.pt.y)
    };
    drawCropUI(); return;
  }

  if (d.type === 'crop-move') {
    const pt = s2c(e.clientX, e.clientY);
    S.cropRect = { ...d.rect0, x: d.rect0.x + pt.x - d.pt.x, y: d.rect0.y + pt.y - d.pt.y };
    drawCropUI(); return;
  }

  if (d.type === 'crop-resize') {
    const pt = s2c(e.clientX, e.clientY);
    const dx = pt.x - d.pt.x, dy = pt.y - d.pt.y;
    let { x, y, w, h } = d.rect0;
    const hs = d.handle;
    if (hs.includes('e')) w = Math.max(10, d.rect0.w + dx);
    if (hs.includes('s')) h = Math.max(10, d.rect0.h + dy);
    if (hs.includes('w')) { x = d.rect0.x + dx; w = Math.max(10, d.rect0.w - dx); }
    if (hs.includes('n')) { y = d.rect0.y + dy; h = Math.max(10, d.rect0.h - dy); }
    x = Math.max(0, Math.min(x, S.canvasW - 10));
    y = Math.max(0, Math.min(y, S.canvasH - 10));
    w = Math.max(10, Math.min(w, S.canvasW - x));
    h = Math.max(10, Math.min(h, S.canvasH - y));
    S.cropRect = { x, y, w, h };
    drawCropUI(); return;
  }
}

// ── Global mouseup — sync to server ──────────────────────────
document.addEventListener('mouseup', async e => {
  if (!S.drag) return;
  const dtype = S.drag.type;
  S.drag = null;
  $('canvasScene').classList.remove('active');

  if (['move', 'resize', 'rotate'].includes(dtype)) {
    clearLocalPreview();
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    const upd = { x: layer.x, y: layer.y };
    if (layer.display_w) upd.display_w = layer.display_w;
    if (layer.display_h) upd.display_h = layer.display_h;
    if (layer.display_rotation !== undefined) upd.display_rotation = layer.display_rotation;
    // Sync to server (debounced)
    serverUpdateLayer(S.activeId, upd);
  }
});

// ══════════════════════════════════════════════════════════════
// TRANSFORM BOX
// ══════════════════════════════════════════════════════════════

function updateBox(layer) {
  if (!layer) return;
  const box = $('transformBox');
  const lx = layer.x || 0;
  const ly = layer.y || 0;
  const lw = layer.display_w || layer.orig_width || S.canvasW;
  const lh = layer.display_h || layer.orig_height || S.canvasH;
  const rot = layer.display_rotation || 0;
  box.style.cssText = `display:block;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;transform:rotate(${rot}deg);transform-origin:50% 50%`;
}

function hideBox() { $('transformBox').style.display = 'none'; }

function updateBoxVisibility() {
  if (S.tool === 'select' && S.activeId) {
    const l = S.layers.find(l => l.id === S.activeId);
    if (l) updateBox(l);
  } else { hideBox(); }
}

// ══════════════════════════════════════════════════════════════
// CROP UI
// ══════════════════════════════════════════════════════════════

S.cropRect = null;

function initCrop() {
  const layer = S.layers.find(l => l.id === S.activeId);
  S.cropRect = layer
    ? { x: layer.x || 0, y: layer.y || 0, w: layer.display_w || layer.orig_width || S.canvasW, h: layer.display_h || layer.orig_height || S.canvasH }
    : { x: 0, y: 0, w: S.canvasW, h: S.canvasH };
  $('cropOverlay').style.display = '';
  drawCropUI();
}

function startCropDraw(e) {
  const pt = s2c(e.clientX, e.clientY);
  S.drag = { type: 'crop-draw', pt };
  S.cropRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
  $('cropOverlay').style.display = '';
  drawCropUI();
}

function drawCropUI() {
  const cr = S.cropRect;
  if (!cr) return;
  const cw = S.canvasW, ch = S.canvasH;
  const t = Math.max(0, cr.y), b = Math.max(0, ch - (cr.y + cr.h));
  const l = Math.max(0, cr.x), r = Math.max(0, cw - (cr.x + cr.w));
  const bh = Math.min(cr.h, ch - t);
  $('cropShadeTop').style.cssText = `height:${t}px`;
  $('cropShadeBottom').style.cssText = `height:${b}px`;
  $('cropShadeLeft').style.cssText = `top:${t}px;height:${bh}px;width:${l}px`;
  $('cropShadeRight').style.cssText = `top:${t}px;height:${bh}px;width:${r}px`;
  $('cropBox').style.cssText = `left:${cr.x}px;top:${cr.y}px;width:${cr.w}px;height:${cr.h}px`;
  $('infoPos').textContent = `crop: ${Math.round(cr.w)}×${Math.round(cr.h)}`;
}

function clearCropShades() {
  ['cropShadeTop','cropShadeBottom','cropShadeLeft','cropShadeRight'].forEach(id => $(id).style.cssText = '');
}

$('applyCropBtn').addEventListener('click', async () => {
  if (!S.cropRect || !S.activeId) return;
  const cr = S.cropRect;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  const layerX = layer.x || 0;
  const layerY = layer.y || 0;
  const relCrop = {
    x: Math.round(cr.x - layerX),
    y: Math.round(cr.y - layerY),
    width: Math.round(cr.w),
    height: Math.round(cr.h)
  };
  busy(true);
  try {
    await serverUpdateLayer(S.activeId, {
      crop: relCrop,
      x: Math.round(cr.x), y: Math.round(cr.y),
      display_w: Math.round(cr.w), display_h: Math.round(cr.h)
    });
    layer.x = Math.round(cr.x); layer.y = Math.round(cr.y);
    layer.display_w = Math.round(cr.w); layer.display_h = Math.round(cr.h);
    layer.crop = relCrop;
    $('cropOverlay').style.display = 'none';
    clearCropShades();
    S.cropRect = null;
    setTool('select');
    toast('Recadrage appliqué', 'success');
  } finally { busy(false); }
});

$('cancelCropBtn').addEventListener('click', () => {
  $('cropOverlay').style.display = 'none';
  clearCropShades();
  S.cropRect = null;
  setTool('select');
});

// ══════════════════════════════════════════════════════════════
// ACTIVE LAYER SELECTION
// ══════════════════════════════════════════════════════════════

function setActive(id) {
  S.activeId = id;
  renderLayerList();
  if (!id) { hideBox(); hideSelectedLayerPanel(); $('infoMode').textContent = '—'; return; }
  const layer = S.layers.find(l => l.id === id);
  if (!layer) return;
  if (S.tool === 'select') updateBox(layer);
  showSelectedLayerPanel(layer);
  $('infoMode').textContent = layer.type;
}

function showSelectedLayerPanel(layer) {
  $('selectedLayerSection').style.display = '';
  $('selLayerTitle').textContent = '▣ ' + (layer.name || 'Calque');
  $('layerOpacity').value = layer.opacity ?? 100;
  $('sv-opacity').textContent = (layer.opacity ?? 100) + '%';
  $('layerBlend').value = layer.blend_mode || 'normal';
  $('solidProps').style.display = layer.type === 'solid' ? '' : 'none';
  $('gradientProps').style.display = layer.type === 'gradient' ? '' : 'none';
  $('textProps').style.display = layer.type === 'text' ? '' : 'none';
  $('shapeProps').style.display = layer.type === 'shape' ? '' : 'none';
  if (layer.type === 'solid') $('solidColor').value = layer.color || '#3a3a5c';
  if (layer.type === 'gradient') {
    $('grad1').value = layer.color1 || '#1a1a2e';
    $('grad2').value = layer.color2 || '#e8c547';
    $('gradAngle').value = layer.angle || 135;
    $('sv-gradAngle').textContent = (layer.angle || 135) + '°';
  }
  if (layer.type === 'text') {
    $('textContent').value = layer.text || '';
    $('textSize').value = layer.font_size || 72;
    $('sv-textSize').textContent = layer.font_size || 72;
    $('textColor').value = layer.color || '#ffffff';
  }
  if (layer.type === 'shape') {
    $('shapeColor').value = layer.color || '#3a3a5c';
  }
  const adj = layer.adjustments || {};
  $$('.lslider').forEach(sl => {
    const p = sl.dataset.lparam;
    const raw = adj[p] !== undefined ? adj[p] : (['brightness','contrast','saturation','sharpness'].includes(p) ? 100 : 0);
    const disp = ['brightness','contrast','saturation','sharpness'].includes(p) ? raw - 100 : raw;
    sl.value = disp;
    const lv = sl.closest('.slider-item')?.querySelector('.lv');
    if (lv) lv.textContent = disp;
  });
  $$('.lchip').forEach(c => c.classList.toggle('active', (layer.filters || []).includes(c.dataset.filter)));
  
  // Load layer styles
  const styles = layer.styles || {};
  const ds = styles.drop_shadow || {};
  $('shadowEnabled').checked = !!ds.enabled;
  $('shadowControls').classList.toggle('show', !!ds.enabled);
  $('shadowColor').value = ds.color || '#000000';
  $('shadowOpacity').value = ds.opacity || 50;
  $('sv-shadowOpacity').textContent = ds.opacity || 50;
  $('shadowOffset').value = ds.offset || 10;
  $('sv-shadowOffset').textContent = ds.offset || 10;
  $('shadowBlur').value = ds.blur || 10;
  $('sv-shadowBlur').textContent = ds.blur || 10;
  const stroke = styles.stroke || {};
  $('strokeEnabled').checked = !!stroke.enabled;
  $('strokeControls').classList.toggle('show', !!stroke.enabled);
  $('strokeColor').value = stroke.color || '#000000';
  $('strokeOpacity').value = stroke.opacity || 100;
  $('sv-strokeOpacity').textContent = stroke.opacity || 100;
  $('strokeSize').value = stroke.size || 3;
  $('sv-strokeSize').textContent = stroke.size || 3;
  $('strokePosition').value = stroke.position || 'outside';
  const og = styles.outer_glow || {};
  $('outerGlowEnabled').checked = !!og.enabled;
  $('outerGlowControls').classList.toggle('show', !!og.enabled);
  $('outerGlowColor').value = og.color || '#ffffff';
  $('outerGlowOpacity').value = og.opacity || 50;
  $('sv-outerGlowOpacity').textContent = og.opacity || 50;
  $('outerGlowSize').value = og.size || 10;
  $('sv-outerGlowSize').textContent = og.size || 10;
  const ig = styles.inner_glow || {};
  $('innerGlowEnabled').checked = !!ig.enabled;
  $('innerGlowControls').classList.toggle('show', !!ig.enabled);
  $('innerGlowColor').value = ig.color || '#ffffff';
  $('innerGlowOpacity').value = ig.opacity || 50;
  $('sv-innerGlowOpacity').textContent = ig.opacity || 50;
  $('innerGlowSize').value = ig.size || 10;
  $('sv-innerGlowSize').textContent = ig.size || 10;
  const bevel = styles.bevel || {};
  $('bevelEnabled').checked = !!bevel.enabled;
  $('bevelControls').classList.toggle('show', !!bevel.enabled);
  $('bevelOpacity').value = bevel.opacity || 50;
  $('sv-bevelOpacity').textContent = bevel.opacity || 50;
  $('bevelSize').value = bevel.size || 5;
  $('sv-bevelSize').textContent = bevel.size || 5;
  $('bevelAngle').value = bevel.angle || 135;
  $('sv-bevelAngle').textContent = bevel.angle || 135;
}

function hideSelectedLayerPanel() { $('selectedLayerSection').style.display = 'none'; }

// ══════════════════════════════════════════════════════════════
// GLOBAL ADJ SLIDERS (Instant preview, debounced sync)
// ══════════════════════════════════════════════════════════════

$$('.adj-slider[data-param]').forEach(sl => {
  sl.addEventListener('input', () => {
    const p = sl.dataset.param, v = parseInt(sl.value);
    const vEl = $('sv-' + p); if (vEl) vEl.textContent = (v >= 0 ? '+' : '') + v;
    if (!S.activeId) return;
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    if (!layer.adjustments) layer.adjustments = { brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0 };
    layer.adjustments[p] = ['brightness','contrast','saturation','sharpness'].includes(p) ? 100 + v : v;
    // Instant local preview
    drawLocalPreview(layer);
    // Debounced server sync
    clearTimeout(S._syncTimer);
    S._syncTimer = setTimeout(() => serverUpdateLayer(S.activeId, { adjustments: layer.adjustments }), 200);
  });
});

$('resetAdjBtn').addEventListener('click', () => {
  $$('.adj-slider[data-param]').forEach(sl => {
    sl.value = 0; const vEl = $('sv-' + sl.dataset.param); if (vEl) vEl.textContent = '0';
  });
  if (!S.activeId) return;
  serverUpdateLayer(S.activeId, { adjustments: {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0} });
});

$('layerOpacity').addEventListener('input', e => {
  $('sv-opacity').textContent = e.target.value + '%';
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.opacity = parseInt(e.target.value);
    drawLocalPreview(layer);
  }
  clearTimeout(S._syncTimer);
  S._syncTimer = setTimeout(() => serverUpdateLayer(S.activeId, { opacity: parseInt(e.target.value) }), 150);
});

$('layerBlend').addEventListener('change', e => {
  if (!S.activeId) return;
  serverUpdateLayer(S.activeId, { blend_mode: e.target.value });
});

// Per-layer adj sliders
$$('.lslider').forEach(sl => {
  sl.addEventListener('input', () => {
    const p = sl.dataset.lparam, v = parseInt(sl.value);
    const lv = sl.closest('.slider-item')?.querySelector('.lv'); if (lv) lv.textContent = v;
    if (!S.activeId) return;
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    if (!layer.adjustments) layer.adjustments = {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0};
    layer.adjustments[p] = ['brightness','contrast','saturation','sharpness'].includes(p) ? 100 + v : v;
    drawLocalPreview(layer);
    clearTimeout(S._syncTimer);
    S._syncTimer = setTimeout(() => serverUpdateLayer(S.activeId, { adjustments: layer.adjustments }), 200);
  });
});

$('resetLayerAdjBtn').addEventListener('click', () => {
  $$('.lslider').forEach(sl => { sl.value = 0; const lv = sl.closest('.slider-item')?.querySelector('.lv'); if(lv) lv.textContent='0'; });
  if (!S.activeId) return;
  serverUpdateLayer(S.activeId, { adjustments: {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0} });
});

// Filters - FIXED
$$('.chip:not(.lchip)').forEach(c => {
  c.addEventListener('click', () => {
    if (!S.activeId) { toast('Sélectionnez un calque', 'info'); return; }
    const f = c.dataset.filter;
    c.classList.toggle('active');
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer.filters) layer.filters = [];
    if (c.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    serverUpdateLayer(S.activeId, { filters: layer.filters });
  });
});

$('clearFiltersBtn').addEventListener('click', () => {
  $$('.chip:not(.lchip)').forEach(c => c.classList.remove('active'));
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId); if (layer) layer.filters = [];
  serverUpdateLayer(S.activeId, { filters: [] });
});

$$('.lchip').forEach(c => {
  c.addEventListener('click', () => {
    if (!S.activeId) return;
    const f = c.dataset.filter;
    c.classList.toggle('active');
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer.filters) layer.filters = [];
    if (c.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    serverUpdateLayer(S.activeId, { filters: layer.filters });
  });
});

$('clearLayerFiltersBtn').addEventListener('click', () => {
  $$('.lchip').forEach(c => c.classList.remove('active'));
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId); if (layer) layer.filters = [];
  serverUpdateLayer(S.activeId, { filters: [] });
});

// Layer Styles
$$('.style-checkbox').forEach(cb => {
  cb.addEventListener('change', () => {
    if (!S.activeId) return;
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    if (!layer.styles) layer.styles = {};
    const styleType = cb.id.replace('Enabled', '');
    const controls = $(styleType + 'Controls');
    if (controls) controls.classList.toggle('show', cb.checked);
    const styleKey = styleType === 'shadow' ? 'drop_shadow' : styleType === 'outerGlow' ? 'outer_glow' : styleType === 'innerGlow' ? 'inner_glow' : styleType === 'stroke' ? 'stroke' : 'bevel';
    if (!layer.styles[styleKey]) layer.styles[styleKey] = { enabled: false };
    layer.styles[styleKey].enabled = cb.checked;
    clearTimeout(S._syncTimer);
    S._syncTimer = setTimeout(() => serverUpdateLayer(S.activeId, { styles: layer.styles }), 200);
  });
});

const styleSliders = [
  { id: 'shadowOpacity', sv: 'sv-shadowOpacity', style: 'drop_shadow', key: 'opacity' },
  { id: 'shadowOffset', sv: 'sv-shadowOffset', style: 'drop_shadow', key: 'offset' },
  { id: 'shadowBlur', sv: 'sv-shadowBlur', style: 'drop_shadow', key: 'blur' },
  { id: 'shadowColor', sv: null, style: 'drop_shadow', key: 'color', isColor: true },
  { id: 'strokeOpacity', sv: 'sv-strokeOpacity', style: 'stroke', key: 'opacity' },
  { id: 'strokeSize', sv: 'sv-strokeSize', style: 'stroke', key: 'size' },
  { id: 'strokeColor', sv: null, style: 'stroke', key: 'color', isColor: true },
  { id: 'strokePosition', sv: null, style: 'stroke', key: 'position', isSelect: true },
  { id: 'outerGlowOpacity', sv: 'sv-outerGlowOpacity', style: 'outer_glow', key: 'opacity' },
  { id: 'outerGlowSize', sv: 'sv-outerGlowSize', style: 'outer_glow', key: 'size' },
  { id: 'outerGlowColor', sv: null, style: 'outer_glow', key: 'color', isColor: true },
  { id: 'innerGlowOpacity', sv: 'sv-innerGlowOpacity', style: 'inner_glow', key: 'opacity' },
  { id: 'innerGlowSize', sv: 'sv-innerGlowSize', style: 'inner_glow', key: 'size' },
  { id: 'innerGlowColor', sv: null, style: 'inner_glow', key: 'color', isColor: true },
  { id: 'bevelOpacity', sv: 'sv-bevelOpacity', style: 'bevel', key: 'opacity' },
  { id: 'bevelSize', sv: 'sv-bevelSize', style: 'bevel', key: 'size' },
  { id: 'bevelAngle', sv: 'sv-bevelAngle', style: 'bevel', key: 'angle' },
];

styleSliders.forEach(s => {
  const el = $(s.id);
  if (!el) return;
  const updateStyle = () => {
    if (!S.activeId) return;
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer || !layer.styles) return;
    const styleKey = s.style;
    if (!layer.styles[styleKey]) layer.styles[styleKey] = {};
    let val = s.isColor ? el.value : parseInt(el.value);
    layer.styles[styleKey][s.key] = val;
    if (s.sv) $(s.sv).textContent = val;
    clearTimeout(S._syncTimer);
    S._syncTimer = setTimeout(() => serverUpdateLayer(S.activeId, { styles: layer.styles }), 200);
  };
  if (s.isColor || s.isSelect) el.addEventListener('change', updateStyle);
  else el.addEventListener('input', updateStyle);
});

$('resetLayerStylesBtn').addEventListener('click', () => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  layer.styles = {};
  $$('.style-checkbox').forEach(cb => {
    cb.checked = false;
    const styleType = cb.id.replace('Enabled', '');
    const controls = $(styleType + 'Controls');
    if (controls) controls.classList.remove('show');
  });
  serverUpdateLayer(S.activeId, { styles: {} });
  toast('Effets réinitialisés', 'info');
});

// Gradient live
$('gradAngle').addEventListener('input', e => {
  $('sv-gradAngle').textContent = e.target.value + '°';
  if (!S.activeId) return;
  clearTimeout(S._gradTimer);
  S._gradTimer = setTimeout(() => serverUpdateLayer(S.activeId, { angle: parseInt(e.target.value) }), 200);
});

// Text size live
$('textSize').addEventListener('input', e => { $('sv-textSize').textContent = e.target.value; });

// Shape color live
$('shapeColor').addEventListener('input', e => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer && layer.type === 'shape') {
    layer.color = e.target.value;
    drawLocalPreview(layer);
  }
  clearTimeout(S._shapeTimer);
  S._shapeTimer = setTimeout(() => serverUpdateLayer(S.activeId, { color: e.target.value }), 200);
});

// Apply layer props - REMOVED - changes are now instant
$('applyLayerPropsBtn').style.display = 'none';

// ══════════════════════════════════════════════════════════════
// TRANSFORM BUTTONS
// ══════════════════════════════════════════════════════════════

$('rotL').addEventListener('click', () => applyTransformBtn('rot', -90));
$('rotR').addEventListener('click', () => applyTransformBtn('rot', +90));
$('flipH').addEventListener('click', () => applyTransformBtn('flipH'));
$('flipV').addEventListener('click', () => applyTransformBtn('flipV'));

$('resetTransformBtn').addEventListener('click', () => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.display_rotation = 0;
    layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  }
  serverUpdateLayer(S.activeId, { transforms:{rotation:0,flip_horizontal:false,flip_vertical:false}, display_rotation:0 });
  $('tinfo-rot').textContent = 'Rotation : 0°';
});

function applyTransformBtn(type, val) {
  if (!S.activeId) { toast('Sélectionnez un calque', 'info'); return; }
  const layer = S.layers.find(l => l.id === S.activeId); if (!layer) return;
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  if (type === 'rot') { layer.transforms.rotation = (layer.transforms.rotation + val + 360) % 360; $('tinfo-rot').textContent = `Rotation : ${layer.transforms.rotation}°`; }
  if (type === 'flipH') layer.transforms.flip_horizontal = !layer.transforms.flip_horizontal;
  if (type === 'flipV') layer.transforms.flip_vertical = !layer.transforms.flip_vertical;
  serverUpdateLayer(S.activeId, { transforms: layer.transforms });
}

// ══════════════════════════════════════════════════════════════
// MERGE / FLATTEN
// ══════════════════════════════════════════════════════════════

$('mergeBtn').addEventListener('click', async () => {
  if (S.layers.length < 2) return;
  if (!confirm('Fusionner tous les calques visibles ?')) return;
  busy(true);
  try {
    const ids = S.layers.filter(l => l.visible !== false).map(l => l.id);
    const r = await fetch(`/api/project/${S.projectId}/layers/merge`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({layer_ids:ids})
    });
    const d = await r.json();
    S.layers = [d.layer];
    await cacheLayerImage(d.layer.id, d.preview);
    setPreview(d.preview);
    setActive(d.layer.id);
    renderLayerList();
    updateRPInfo();
    toast('Calques fusionnés', 'success');
  } catch(e) { toast('Erreur fusion', 'error'); }
  finally { busy(false); }
});

$('flattenBtn').addEventListener('click', () => $('mergeBtn').click());

// ══════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════

$('exportQuality').addEventListener('input', e => { $('sv-quality').textContent = e.target.value; });
$('exportFmt').addEventListener('change', e => { $('qualRow').style.display = e.target.value === 'png' ? 'none' : ''; });

async function doExport() {
  if (!S.projectId) return;
  busy(true); toast('Export…', 'info');
  try {
    const r = await fetch(`/api/project/${S.projectId}/export`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ format: $('exportFmt').value, quality: parseInt($('exportQuality').value) })
    });
    if (!r.ok) throw new Error(`Export failed ${r.status}`);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `composition.${$('exportFmt').value}`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exporté !', 'success');
  } catch(e) { toast('Erreur export : ' + e.message, 'error'); }
  finally { busy(false); }
}

$('exportBtn').addEventListener('click', doExport);
$('downloadBtn').addEventListener('click', doExport);

// ══════════════════════════════════════════════════════════════
// PROJECT SAVE / LOAD
// ══════════════════════════════════════════════════════════════

async function saveProject() {
  if (!S.projectId) { toast('Aucun projet actif', 'error'); return; }
  busy(true);
  try {
    const r = await fetch(`/api/project/${S.projectId}/save`, { method: 'POST' });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    const blob = new Blob([JSON.stringify(d.project, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `project_${S.projectId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Projet sauvegardé !', 'success');
  } catch(e) { toast('Erreur sauvegarde : ' + e.message, 'error'); }
  finally { busy(false); }
}

async function loadProject(file) {
  busy(true);
  try {
    const text = await file.text();
    const proj = JSON.parse(text);
    if (!proj.canvas_width || !proj.layers) throw new Error('Format invalide');
    const r = await fetch('/api/project/load', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: proj })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    S.projectId = d.project_id;
    S.canvasW = d.canvas_width;
    S.canvasH = d.canvas_height;
    S.layers = proj.layers || [];
    S.layerImages = {};
    for (const layer of S.layers) {
      if (layer.image_data) await cacheLayerImage(layer.id, layer.image_data);
    }
    initScene();
    renderLayerList();
    if (S.layers.length > 0) setActive(S.layers[0].id);
    toast('Projet chargé !', 'success');
  } catch(e) { toast('Erreur chargement : ' + e.message, 'error'); console.error(e); }
  finally { busy(false); }
}

$('saveProjectBtn').addEventListener('click', saveProject);
$('loadProjectInput').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) loadProject(f);
});

// ══════════════════════════════════════════════════════════════
// LAYERS LIST
// ══════════════════════════════════════════════════════════════

function renderLayerList() {
  const list = $('layersList');
  list.innerHTML = '';
  $('layerBadge').textContent = S.layers.length;
  if (!S.layers.length) { list.innerHTML = '<div class="no-layers">Aucun calque</div>'; return; }
  [...S.layers].reverse().forEach(layer => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === S.activeId ? ' selected' : '');
    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    if (layer.type === 'solid') thumb.style.background = layer.color || '#333';
    else if (layer.type === 'gradient') thumb.style.background = `linear-gradient(${layer.angle||135}deg,${layer.color1||'#000'},${layer.color2||'#fff'})`;
    else if (layer.type === 'text') { thumb.textContent = 'T'; Object.assign(thumb.style, {font:'bold 12px serif',color:'#eee',display:'flex',alignItems:'center',justifyContent:'center'}); }
    else { const img = S.layerImages[layer.id]; if (img) { const im=document.createElement('img'); im.src=img.src; im.style.cssText='width:100%;height:100%;object-fit:cover'; thumb.appendChild(im); } else thumb.innerHTML='<span style="font-size:10px;color:var(--text3)">🖼</span>'; }
    const main = document.createElement('div'); main.className = 'layer-main';
    main.innerHTML = `<div class="layer-name">${layer.name||'Calque'}</div><div class="layer-sub">${layer.blend_mode||'normal'} · ${layer.opacity??100}%${layer.visible===false?' · caché':''}</div>`;
    const btns = document.createElement('div'); btns.className = 'layer-btns';
    const mk = (txt, cls, title, fn) => {
      const b = document.createElement('button'); b.className = 'lbtn '+(cls||''); b.title = title; b.textContent = txt;
      b.addEventListener('click', e => { e.stopPropagation(); fn(layer); }); return b;
    };
    btns.append(
      mk(layer.visible===false?'○':'●', 'vis'+(layer.visible===false?' hidden':''), 'Visibilité', async l => { l.visible=l.visible===false; await serverUpdateLayer(l.id,{visible:l.visible}); }),
      mk('↑','','Monter', async l => { const i=S.layers.findIndex(x=>x.id===l.id); if(i<S.layers.length-1){[S.layers[i],S.layers[i+1]]=[S.layers[i+1],S.layers[i]];busy(true);try{await reorderServer();}finally{busy(false);}} }),
      mk('↓','','Descendre', async l => { const i=S.layers.findIndex(x=>x.id===l.id); if(i>0){[S.layers[i],S.layers[i-1]]=[S.layers[i-1],S.layers[i]];busy(true);try{await reorderServer();}finally{busy(false);}} }),
      mk('⧉','','Dupliquer', async l => { busy(true); try{await duplicateLayerServer(l.id);}finally{busy(false);} }),
      mk('✕','danger','Supprimer', async l => { if(!confirm(`Supprimer "${l.name}" ?`))return; busy(true);try{await deleteLayerFromServer(l.id);}finally{busy(false);} })
    );
    item.append(thumb, main, btns);
    item.addEventListener('click', () => setActive(layer.id));
    list.appendChild(item);
  });
}

function updateRPInfo() {
  $('rpCanvasSize').textContent = `${S.canvasW} × ${S.canvasH}`;
  $('rpLayerCount').textContent = S.layers.length;
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'v') setTool('select');
  if (e.key === 'c') setTool('crop');
  if (e.key === 'h') setTool('pan');
  if (e.key === 'i') setTool('eyedropper');

  if (e.ctrlKey || e.metaKey) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); S.zoom=Math.min(S.zoom*1.2,8); applyVP(); }
    if (e.key === '-') { e.preventDefault(); S.zoom=Math.max(S.zoom*.8,.05); applyVP(); }
    if (e.key === '0') { e.preventDefault(); fitZoom(); }
    if (e.key === 'o') { e.preventDefault(); $('fileInput').click(); }
    if (e.key === 's') { e.preventDefault(); doExport(); }
    if (e.key === 'p') { e.preventDefault(); saveProject(); }
    if (e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'd' && S.activeId) { e.preventDefault(); busy(true); duplicateLayerServer(S.activeId).finally(()=>busy(false)); }
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && S.activeId) {
    e.preventDefault();
    if (confirm('Supprimer ce calque ?')) { busy(true); deleteLayerFromServer(S.activeId).finally(()=>busy(false)); }
  }

  if (e.key === 'Escape') {
    if (S.tool === 'crop') $('cancelCropBtn').click();
    else setActive(null);
  }

  // Arrow nudge
  if (S.activeId && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const layer = S.layers.find(l=>l.id===S.activeId); if(!layer) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key==='ArrowLeft')  layer.x=(layer.x||0)-step;
    if (e.key==='ArrowRight') layer.x=(layer.x||0)+step;
    if (e.key==='ArrowUp')    layer.y=(layer.y||0)-step;
    if (e.key==='ArrowDown')  layer.y=(layer.y||0)+step;
    updateBox(layer);
    drawLocalPreview(layer);
    clearTimeout(S._nudgeTimer);
    S._nudgeTimer = setTimeout(() => serverUpdateLayer(S.activeId,{x:layer.x,y:layer.y}), 120);
  }
});

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

console.log('%cOpen Photo Editor v4.0', 'color:#e8c547;font-family:monospace;font-size:14px;font-weight:bold');
console.log('%cOptimized: instant preview, reduced latency', 'color:#55556a;font-family:monospace');
