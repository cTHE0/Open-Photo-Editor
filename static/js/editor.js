"use strict";
/**
 * Open Photo Editor v3.0
 * Full mouse-driven canvas: drag, resize handles, rotation, crop handles,
 * pan/zoom viewport, layer management.
 */

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

let toastTimer;
function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function showProcessing(v) { $('processing').style.display = v ? 'flex' : 'none'; }

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
const S = {
  // Project / layers
  projectId:   null,
  layers:      [],           // local layer list (no image_data)
  activeId:    null,
  canvasW:     0,
  canvasH:     0,

  // Single-image mode (no project)
  fileId:      null,
  imgW:        0,
  imgH:        0,

  // Viewport pan / zoom
  zoom:        1,
  panX:        0,
  panY:        0,

  // Active tool
  tool:        'select',     // 'select' | 'crop' | 'pan'

  // Adjustments (global, applied to single-image or active layer)
  adj: { brightness:0, exposure:0, contrast:0, highlights:0, shadows:0,
         saturation:0, temperature:0, sharpness:0 },
  filters: [],
  transforms: { rotation:0, flip_horizontal:false, flip_vertical:false },
  activeCrop: null,

  // History
  history:     [],
  histIdx:     -1,

  // Interaction state
  dragging:    null,   // { type, ... }
  pendingProcess: null,
};

// ═══════════════════════════════════════════════════════════════
// SECTION TOGGLES
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('[data-toggle]').forEach(hdr => {
  const id = hdr.dataset.toggle;
  const body = $(id);
  const chevron = hdr.querySelector('.chevron');
  hdr.addEventListener('click', () => {
    const open = body.classList.toggle('open');
    if (chevron) chevron.classList.toggle('open', open);
  });
});

// ═══════════════════════════════════════════════════════════════
// TOOL SELECTION
// ═══════════════════════════════════════════════════════════════
$$('[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

function setTool(tool) {
  S.tool = tool;
  $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  const scene = $('canvasScene');
  scene.classList.toggle('panning', tool === 'pan');

  if (tool === 'crop') {
    initCropUI();
  } else {
    $('cropOverlay').style.display = 'none';
    hideCropShades();
  }

  updateTransformBoxVisibility();
}

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════════════
['fileInput','fileInputEmpty'].forEach(id => {
  $(id).addEventListener('change', e => {
    const f = e.target.files[0]; if (f) doUpload(f);
    e.target.value = '';
  });
});

$('addLayerImageInput').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = '';
  showProcessing(true);
  try {
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/api/upload', {method:'POST', body:fd});
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    if (!S.projectId) await createProject(d.width, d.height);
    await addLayer({ type:'image', file_id:d.file_id, name:f.name.replace(/\.[^.]+$/,'') });
  } catch(e) { toast('Erreur : '+e.message, 'error'); }
  finally { showProcessing(false); }
});

async function doUpload(file) {
  if (!file.type.startsWith('image/')) { toast('Format non supporté', 'error'); return; }
  showProcessing(true);
  try {
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/upload', {method:'POST', body:fd});
    const d = await r.json(); if (!d.success) throw new Error(d.error);

    S.fileId = d.file_id; S.imgW = d.width; S.imgH = d.height;

    // If no project yet, create one and add as layer
    if (!S.projectId) await createProject(d.width, d.height);
    await addLayer({ type:'image', file_id:d.file_id, name:file.name.replace(/\.[^.]+$/,'') });
    pushHistory('Image ouverte');
  } catch(e) { toast('Erreur : '+e.message, 'error'); }
  finally { showProcessing(false); }
}

// drag & drop
const cw = document.querySelector('.canvas-wrap');
cw.addEventListener('dragover',  e => { e.preventDefault(); cw.classList.add('drag-over'); });
cw.addEventListener('dragleave', () => cw.classList.remove('drag-over'));
cw.addEventListener('drop', e => {
  e.preventDefault(); cw.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) doUpload(f);
});

// ═══════════════════════════════════════════════════════════════
// PROJECT / LAYERS API
// ═══════════════════════════════════════════════════════════════
async function createProject(w, h) {
  const r = await fetch('/api/project/new', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ width:w||parseInt($('newW').value)||1920, height:h||parseInt($('newH').value)||1080 })
  });
  const d = await r.json();
  S.projectId = d.project_id;
  S.canvasW   = d.width;
  S.canvasH   = d.height;
  S.layers    = [];
  setupCanvasBg();
  $('emptyState').style.display   = 'none';
  $('canvasScene').style.display  = '';
  $('infoBar').style.display      = 'flex';
  $('rpInfo').style.display       = '';
  $('exportBtn').disabled         = false;
  $('downloadBtn').disabled       = false;
  $('mergeBtn').disabled          = false;
  $('flattenBtn').disabled        = false;
  updateRPInfo();
  fitZoom();
}

function setupCanvasBg() {
  const bg = $('canvasBg');
  bg.style.width  = S.canvasW + 'px';
  bg.style.height = S.canvasH + 'px';
}

async function addLayer(params) {
  showProcessing(true);
  try {
    const r = await fetch(`/api/project/${S.projectId}/layer/add`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(params)
    });
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    if (d.canvas_width) { S.canvasW = d.canvas_width; S.canvasH = d.canvas_height; setupCanvasBg(); }
    S.layers.push(d.layer);
    setPreview(d.preview);
    renderLayers();
    setActive(d.layer.id);
    updateRPInfo();
    toast(`Calque ajouté : ${d.layer.name}`, 'success');
  } catch(e) { toast('Erreur : '+e.message, 'error'); }
  finally { showProcessing(false); }
}

async function updateLayer(id, data) {
  if (!S.projectId || !id) return;
  showProcessing(true);
  try {
    const r = await fetch(`/api/project/${S.projectId}/layer/${id}/update`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    const idx = S.layers.findIndex(l => l.id === id);
    if (idx >= 0) Object.assign(S.layers[idx], d.layer);
    setPreview(d.preview);
    renderLayers();
  } catch(e) { toast('Erreur mise à jour', 'error'); }
  finally { showProcessing(false); }
}

async function deleteLayer(id) {
  showProcessing(true);
  try {
    const r = await fetch(`/api/project/${S.projectId}/layer/${id}/delete`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
    });
    const d = await r.json();
    S.layers = S.layers.filter(l => l.id !== id);
    if (S.activeId === id) { S.activeId = null; hideTransformBox(); }
    setPreview(d.preview);
    renderLayers();
    updateRPInfo();
    hideSelectedLayerPanel();
    toast('Calque supprimé', 'info');
  } catch(e) { toast('Erreur', 'error'); }
  finally { showProcessing(false); }
}

async function duplicateLayer(id) {
  showProcessing(true);
  try {
    const r = await fetch(`/api/project/${S.projectId}/layer/${id}/duplicate`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
    });
    const d = await r.json();
    const srcIdx = S.layers.findIndex(l => l.id === id);
    S.layers.splice(srcIdx+1, 0, d.layer);
    setPreview(d.preview);
    renderLayers();
    setActive(d.layer.id);
    updateRPInfo();
  } catch(e) { toast('Erreur', 'error'); }
  finally { showProcessing(false); }
}

async function reorder() {
  showProcessing(true);
  try {
    const r = await fetch(`/api/project/${S.projectId}/layers/reorder`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ order: S.layers.map(l=>l.id) })
    });
    const d = await r.json(); setPreview(d.preview); renderLayers();
  } catch(e) { toast('Erreur', 'error'); }
  finally { showProcessing(false); }
}

function setPreview(src) {
  const img = $('compositeImg');
  img.src = src;
  img.style.width  = S.canvasW + 'px';
  img.style.height = S.canvasH + 'px';
  $('infoSize').textContent = `${S.canvasW} × ${S.canvasH}`;
}

// ═══════════════════════════════════════════════════════════════
// VIEWPORT PAN & ZOOM
// ═══════════════════════════════════════════════════════════════
function applyViewport() {
  $('viewport').style.transform =
    `translate(calc(-50% + ${S.panX}px), calc(-50% + ${S.panY}px)) scale(${S.zoom})`;
  $('zoomDisplay').textContent = Math.round(S.zoom * 100) + '%';
}

function fitZoom() {
  const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
  const scaleX = (wrap.width  - 80) / S.canvasW;
  const scaleY = (wrap.height - 80) / S.canvasH;
  S.zoom = Math.min(scaleX, scaleY, 1);
  S.panX = 0; S.panY = 0;
  applyViewport();
}

$('zoomIn' ).addEventListener('click', () => { S.zoom = Math.min(S.zoom*1.25, 8); applyViewport(); });
$('zoomOut').addEventListener('click', () => { S.zoom = Math.max(S.zoom*.8, .05); applyViewport(); });
$('zoomFit').addEventListener('click', fitZoom);
$('zoom100').addEventListener('click', () => { S.zoom=1; S.panX=0; S.panY=0; applyViewport(); });

// Wheel zoom (centered on cursor)
$('canvasScene').addEventListener('wheel', e => {
  e.preventDefault();
  const rect = $('canvasScene').getBoundingClientRect();
  const mx = e.clientX - rect.left - rect.width/2;
  const my = e.clientY - rect.top  - rect.height/2;

  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const newZoom = Math.max(.05, Math.min(S.zoom * factor, 8));
  const ratio = newZoom / S.zoom;
  S.panX = mx - (mx - S.panX) * ratio;
  S.panY = my - (my - S.panY) * ratio;
  S.zoom = newZoom;
  applyViewport();
}, { passive:false });

// ═══════════════════════════════════════════════════════════════
// MOUSE INTERACTION — unified pointer handler
// ═══════════════════════════════════════════════════════════════

// Convert screen coords to canvas-space coords
function screenToCanvas(sx, sy) {
  const sceneRect = $('canvasScene').getBoundingClientRect();
  const relX = sx - sceneRect.left - sceneRect.width/2;
  const relY = sy - sceneRect.top  - sceneRect.height/2;
  return {
    x: (relX - S.panX) / S.zoom,
    y: (relY - S.panY) / S.zoom
  };
}

function canvasToScreen(cx, cy) {
  const sceneRect = $('canvasScene').getBoundingClientRect();
  return {
    x: cx * S.zoom + S.panX + sceneRect.left + sceneRect.width/2,
    y: cy * S.zoom + S.panY + sceneRect.top  + sceneRect.height/2
  };
}

// ── Scene mousedown ──────────────────────────────────────────
$('canvasScene').addEventListener('mousedown', onSceneMouseDown);

function onSceneMouseDown(e) {
  if (e.button !== 0) return;

  // PAN TOOL or middle button or space
  if (S.tool === 'pan' || e.button === 1) {
    S.dragging = { type:'pan', startX:e.clientX, startY:e.clientY, startPanX:S.panX, startPanY:S.panY };
    $('canvasScene').classList.add('active');
    return;
  }

  // CROP TOOL
  if (S.tool === 'crop') {
    const pt = screenToCanvas(e.clientX, e.clientY);
    // Check if clicking on crop box
    if ($('cropOverlay').style.display !== 'none' && S.cropRect) {
      const cr = S.cropRect;
      const margin = 8 / S.zoom;
      if (pt.x > cr.x+margin && pt.x < cr.x+cr.w-margin &&
          pt.y > cr.y+margin && pt.y < cr.y+cr.h-margin) {
        S.dragging = { type:'crop-move', startPt:pt, startRect:{...S.cropRect} };
        return;
      }
    }
    // Start new crop draw
    S.dragging = { type:'crop-draw', startPt:pt };
    S.cropRect = { x:pt.x, y:pt.y, w:0, h:0 };
    $('cropOverlay').style.display = '';
    updateCropUI();
    return;
  }

  // SELECT TOOL — check what's under cursor (transform handles take priority)
  // handled by handle/move-area listeners below
  if (S.tool === 'select') {
    // Click on canvas background = deselect
    if (e.target === $('canvasBg') || e.target === $('compositeImg') || e.target === $('canvasScene') || e.target === $('viewport')) {
      setActive(null);
      return;
    }
    // Pan fallback when clicking empty space
    S.dragging = { type:'pan', startX:e.clientX, startY:e.clientY, startPanX:S.panX, startPanY:S.panY };
  }
}

// ── Transform box move ───────────────────────────────────────
$('moveArea').addEventListener('mousedown', e => {
  if (S.tool !== 'select' || !S.activeId) return;
  e.stopPropagation();
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  const pt = screenToCanvas(e.clientX, e.clientY);
  S.dragging = {
    type: 'layer-move',
    startPt: pt,
    startX: layer.x || 0,
    startY: layer.y || 0
  };
  e.preventDefault();
});

// ── Resize handles ───────────────────────────────────────────
$$('.handle').forEach(h => {
  h.addEventListener('mousedown', e => {
    if (S.tool !== 'select' || !S.activeId) return;
    e.stopPropagation(); e.preventDefault();
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    S.dragging = {
      type:  'layer-resize',
      handle: h.dataset.handle,
      startPt: pt,
      startX: layer.x || 0,
      startY: layer.y || 0,
      startW: layer.display_w || layer.orig_width || S.canvasW,
      startH: layer.display_h || layer.orig_height || S.canvasH,
    };
  });
});

// ── Rotation handle ──────────────────────────────────────────
$('rotateHandle').addEventListener('mousedown', e => {
  if (S.tool !== 'select' || !S.activeId) return;
  e.stopPropagation(); e.preventDefault();
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  // Center of layer in canvas coords
  const lx = layer.x || 0, ly = layer.y || 0;
  const lw = layer.display_w || layer.orig_width || S.canvasW;
  const lh = layer.display_h || layer.orig_height || S.canvasH;
  const cx = lx + lw/2, cy = ly + lh/2;
  S.dragging = {
    type: 'layer-rotate',
    cx, cy,
    startAngle: layer.display_rotation || 0,
    startMouseAngle: angleTo(cx, cy, e.clientX, e.clientY)
  };
});

function angleTo(cx, cy, mx, my) {
  const sc = canvasToScreen(cx, cy);
  return Math.atan2(my - sc.y, mx - sc.x) * 180 / Math.PI;
}

// ── Crop handles ─────────────────────────────────────────────
$$('.crop-handle').forEach(h => {
  h.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const pt = screenToCanvas(e.clientX, e.clientY);
    S.dragging = { type:'crop-resize', handle:h.dataset.handle, startPt:pt, startRect:{...S.cropRect} };
  });
});

$('cropBox').addEventListener('mousedown', e => {
  if (e.target.classList.contains('crop-handle') || e.target.classList.contains('crop-grid-line')) return;
  e.stopPropagation();
  const pt = screenToCanvas(e.clientX, e.clientY);
  S.dragging = { type:'crop-move', startPt:pt, startRect:{...S.cropRect} };
});

// ── Global mousemove ─────────────────────────────────────────
document.addEventListener('mousemove', onMouseMove);

function onMouseMove(e) {
  if (!S.dragging) {
    // Update cursor info
    if ($('canvasScene').style.display !== 'none') {
      const pt = screenToCanvas(e.clientX, e.clientY);
      $('infoPos').textContent = `x:${Math.round(pt.x)} y:${Math.round(pt.y)}`;
    }
    return;
  }
  const d = S.dragging;

  // ── PAN
  if (d.type === 'pan') {
    S.panX = d.startPanX + (e.clientX - d.startX);
    S.panY = d.startPanY + (e.clientY - d.startY);
    applyViewport();
    return;
  }

  // ── LAYER MOVE
  if (d.type === 'layer-move') {
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    const nx = d.startX + (pt.x - d.startPt.x);
    const ny = d.startY + (pt.y - d.startPt.y);
    layer.x = Math.round(nx); layer.y = Math.round(ny);
    updateTransformBox(layer);
    $('dimTooltip').textContent = `${Math.round(layer.x)}, ${Math.round(layer.y)}`;
    scheduleLayerUpdate(S.activeId, { x:layer.x, y:layer.y });
    return;
  }

  // ── LAYER RESIZE
  if (d.type === 'layer-resize') {
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    const dx = pt.x - d.startPt.x, dy = pt.y - d.startPt.y;
    let { startX:x, startY:y, startW:w, startH:h } = d;
    const h_str = d.handle;

    if (h_str.includes('e')) w = Math.max(10, d.startW + dx);
    if (h_str.includes('s')) h = Math.max(10, d.startH + dy);
    if (h_str.includes('w')) { x = d.startX + dx; w = Math.max(10, d.startW - dx); }
    if (h_str.includes('n')) { y = d.startY + dy; h = Math.max(10, d.startH - dy); }

    layer.x = Math.round(x); layer.y = Math.round(y);
    layer.display_w = Math.round(w); layer.display_h = Math.round(h);
    updateTransformBox(layer);
    $('dimTooltip').textContent = `${Math.round(w)} × ${Math.round(h)}`;
    scheduleLayerUpdate(S.activeId, { x:layer.x, y:layer.y, display_w:layer.display_w, display_h:layer.display_h });
    return;
  }

  // ── LAYER ROTATE
  if (d.type === 'layer-rotate') {
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    const curAngle = angleTo(d.cx, d.cy, e.clientX, e.clientY);
    let rotation = d.startAngle + (curAngle - d.startMouseAngle);
    if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
    layer.display_rotation = rotation;
    updateTransformBox(layer);
    $('dimTooltip').textContent = `${Math.round(rotation)}°`;
    scheduleLayerUpdate(S.activeId, { display_rotation: rotation });
    return;
  }

  // ── CROP DRAW
  if (d.type === 'crop-draw') {
    const pt = screenToCanvas(e.clientX, e.clientY);
    const x = Math.min(pt.x, d.startPt.x);
    const y = Math.min(pt.y, d.startPt.y);
    const w = Math.abs(pt.x - d.startPt.x);
    const h = Math.abs(pt.y - d.startPt.y);
    S.cropRect = { x, y, w, h };
    updateCropUI();
    return;
  }

  // ── CROP MOVE
  if (d.type === 'crop-move') {
    const pt = screenToCanvas(e.clientX, e.clientY);
    const dx = pt.x - d.startPt.x, dy = pt.y - d.startPt.y;
    S.cropRect = {
      x: d.startRect.x + dx, y: d.startRect.y + dy,
      w: d.startRect.w, h: d.startRect.h
    };
    updateCropUI();
    return;
  }

  // ── CROP RESIZE
  if (d.type === 'crop-resize') {
    const pt = screenToCanvas(e.clientX, e.clientY);
    const dx = pt.x - d.startPt.x, dy = pt.y - d.startPt.y;
    let { x, y, w, h } = d.startRect;
    const hs = d.handle;
    if (hs.includes('e')) w = Math.max(10, d.startRect.w + dx);
    if (hs.includes('s')) h = Math.max(10, d.startRect.h + dy);
    if (hs.includes('w')) { x = d.startRect.x + dx; w = Math.max(10, d.startRect.w - dx); }
    if (hs.includes('n')) { y = d.startRect.y + dy; h = Math.max(10, d.startRect.h - dy); }
    S.cropRect = { x, y, w, h };
    updateCropUI();
    return;
  }
}

// ── Global mouseup ───────────────────────────────────────────
document.addEventListener('mouseup', e => {
  if (!S.dragging) return;
  const type = S.dragging.type;
  S.dragging = null;
  $('canvasScene').classList.remove('active');

  if (type === 'layer-move' || type === 'layer-resize' || type === 'layer-rotate') {
    // Force immediate update
    clearTimeout(S.pendingProcess);
    const layer = S.layers.find(l => l.id === S.activeId);
    if (layer) {
      const data = { x:layer.x, y:layer.y };
      if (layer.display_w) data.display_w = layer.display_w;
      if (layer.display_h) data.display_h = layer.display_h;
      if (layer.display_rotation !== undefined) data.display_rotation = layer.display_rotation;
      updateLayer(S.activeId, data).then(() => pushHistory('Transform'));
    }
    return;
  }

  if (type === 'crop-draw' || type === 'crop-resize' || type === 'crop-move') {
    if (S.cropRect && S.cropRect.w > 5 && S.cropRect.h > 5) {
      updateCropUI();
    }
  }
});

// ─── Debounced layer update for live drag feedback ────────────
function scheduleLayerUpdate(id, data) {
  clearTimeout(S.pendingProcess);
  S.pendingProcess = setTimeout(async () => {
    if (!id) return;
    try {
      const r = await fetch(`/api/project/${S.projectId}/layer/${id}/update`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(data)
      });
      const d = await r.json();
      if (d.success) setPreview(d.preview);
    } catch(e) { /* silent */ }
  }, 80);
}

// ═══════════════════════════════════════════════════════════════
// TRANSFORM BOX
// ═══════════════════════════════════════════════════════════════
function updateTransformBox(layer) {
  if (!layer || !$('canvasScene') || $('canvasScene').style.display === 'none') return;
  const box = $('transformBox');

  const lx = layer.x || 0;
  const ly = layer.y || 0;
  const lw = layer.display_w || layer.orig_width  || S.canvasW;
  const lh = layer.display_h || layer.orig_height || S.canvasH;
  const rot = layer.display_rotation || 0;

  box.style.left      = lx + 'px';
  box.style.top       = ly + 'px';
  box.style.width     = lw + 'px';
  box.style.height    = lh + 'px';
  box.style.transform = `rotate(${rot}deg)`;
  box.style.transformOrigin = '50% 50%';
  box.style.display   = '';
}

function hideTransformBox() { $('transformBox').style.display = 'none'; }

function updateTransformBoxVisibility() {
  if (S.tool === 'select' && S.activeId) {
    const layer = S.layers.find(l => l.id === S.activeId);
    if (layer) updateTransformBox(layer);
  } else {
    hideTransformBox();
  }
}

// ═══════════════════════════════════════════════════════════════
// CROP UI
// ═══════════════════════════════════════════════════════════════
function initCropUI() {
  const activeLayer = S.layers.find(l => l.id === S.activeId);
  // Default crop = full canvas
  S.cropRect = { x:0, y:0, w:S.canvasW, h:S.canvasH };
  if (activeLayer && activeLayer.x !== undefined) {
    const lw = activeLayer.display_w || activeLayer.orig_width || S.canvasW;
    const lh = activeLayer.display_h || activeLayer.orig_height || S.canvasH;
    S.cropRect = { x:activeLayer.x||0, y:activeLayer.y||0, w:lw, h:lh };
  }
  $('cropOverlay').style.display = '';
  updateCropUI();
}

function updateCropUI() {
  const cr = S.cropRect;
  if (!cr) return;

  const cw_px = S.canvasW, ch_px = S.canvasH;

  // Shade positions (all in canvas px)
  const top    = Math.max(0, cr.y);
  const left   = Math.max(0, cr.x);
  const right  = Math.max(0, cw_px - (cr.x + cr.w));
  const bottom = Math.max(0, ch_px - (cr.y + cr.h));
  const boxH   = Math.min(cr.h, ch_px - top);

  $('cropShadeTop').style.cssText    = `height:${top}px`;
  $('cropShadeBottom').style.cssText = `height:${bottom}px`;
  $('cropShadeLeft').style.cssText   = `top:${top}px;height:${boxH}px;width:${left}px`;
  $('cropShadeRight').style.cssText  = `top:${top}px;height:${boxH}px;width:${right}px`;

  $('cropBox').style.cssText = `left:${cr.x}px;top:${cr.y}px;width:${cr.w}px;height:${cr.h}px`;
  $('infoPos').textContent = `crop: ${Math.round(cr.w)}×${Math.round(cr.h)}`;
}

function hideCropShades() {
  ['cropShadeTop','cropShadeBottom','cropShadeLeft','cropShadeRight'].forEach(id => {
    $(id).style.cssText = '';
  });
}

$('applyCropBtn').addEventListener('click', async () => {
  if (!S.cropRect || !S.activeId) return;
  const cr = S.cropRect;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;

  // Convert canvas coords to layer-relative coords
  const lx = layer.x || 0, ly = layer.y || 0;
  const relCrop = {
    x: Math.round(cr.x - lx),
    y: Math.round(cr.y - ly),
    width:  Math.round(cr.w),
    height: Math.round(cr.h)
  };

  await updateLayer(S.activeId, { crop: relCrop });
  layer.crop = relCrop;
  layer.x = Math.round(cr.x); layer.y = Math.round(cr.y);
  layer.display_w = Math.round(cr.w); layer.display_h = Math.round(cr.h);

  $('cropOverlay').style.display = 'none';
  hideCropShades();
  S.cropRect = null;
  setTool('select');
  pushHistory('Recadrage');
  toast('Recadrage appliqué', 'success');
});

$('cancelCropBtn').addEventListener('click', () => {
  $('cropOverlay').style.display = 'none';
  hideCropShades();
  S.cropRect = null;
  setTool('select');
});

// ═══════════════════════════════════════════════════════════════
// ACTIVE LAYER + SELECTION
// ═══════════════════════════════════════════════════════════════
function setActive(id) {
  S.activeId = id;
  renderLayers(); // re-render to show selection

  if (!id) {
    hideTransformBox();
    hideSelectedLayerPanel();
    $('infoMode').textContent = '—';
    return;
  }

  const layer = S.layers.find(l => l.id === id);
  if (!layer) return;

  updateTransformBox(layer);
  showSelectedLayerPanel(layer);
  $('infoMode').textContent = layer.type;
}

function showSelectedLayerPanel(layer) {
  $('selectedLayerSection').style.display = '';
  $('selLayerTitle').textContent = '▣ ' + (layer.name || 'Calque');

  // Opacity / blend
  const op = layer.opacity ?? 100;
  $('layerOpacity').value = op;
  $('sv-opacity').textContent = op + '%';
  $('layerBlend').value = layer.blend_mode || 'normal';

  // Type props
  $('solidProps').style.display    = layer.type === 'solid'    ? '' : 'none';
  $('gradientProps').style.display = layer.type === 'gradient' ? '' : 'none';
  $('textProps').style.display     = layer.type === 'text'     ? '' : 'none';

  if (layer.type === 'solid')    $('solidColor').value = layer.color || '#3a3a5c';
  if (layer.type === 'gradient') {
    $('grad1').value = layer.color1 || '#1a1a2e';
    $('grad2').value = layer.color2 || '#e8c547';
    $('gradAngle').value = layer.angle || 135;
    $('sv-gradAngle').textContent = (layer.angle||135) + '°';
  }
  if (layer.type === 'text') {
    $('textContent').value = layer.text || '';
    $('textSize').value    = layer.font_size || 72;
    $('sv-textSize').textContent = layer.font_size || 72;
    $('textColor').value   = layer.color || '#ffffff';
  }

  // Per-layer sliders
  const adj = layer.adjustments || {};
  $$('.lslider').forEach(sl => {
    const p = sl.dataset.lparam;
    const v = adj[p] !== undefined ? adj[p] : 0;
    sl.value = v;
    const lv = sl.closest('.slider-item')?.querySelector('.lv');
    if (lv) lv.textContent = v;
  });

  // Per-layer filter chips
  $$('.lchip').forEach(c => c.classList.toggle('active', (layer.filters||[]).includes(c.dataset.filter)));
}

function hideSelectedLayerPanel() {
  $('selectedLayerSection').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL ADJ SLIDERS (applied to selected layer or whole project)
// ═══════════════════════════════════════════════════════════════
$$('.adj-slider[data-param]').forEach(sl => {
  sl.addEventListener('input', () => {
    const p = sl.dataset.param;
    const v = parseInt(sl.value);
    const vEl = $('sv-' + p); if (vEl) vEl.textContent = (v >= 0 ? '+' : '') + v;
    S.adj[p] = v;
    scheduleGlobalProcess();
  });
  sl.addEventListener('change', pushHistoryOnChange);
});

function scheduleGlobalProcess(delay=300) {
  clearTimeout(S._adjTimer);
  S._adjTimer = setTimeout(doGlobalProcess, delay);
}

async function doGlobalProcess() {
  // Apply global adjustments to active layer, or to all layers
  if (!S.projectId) return;

  // Build PIL-compatible adj object (convert -100..100 range to PIL scale)
  const adjPIL = {
    brightness: 100 + S.adj.brightness,
    contrast:   100 + S.adj.contrast,
    saturation: 100 + S.adj.saturation,
    sharpness:  100 + S.adj.sharpness,
    exposure:   S.adj.exposure,
    highlights: S.adj.highlights,
    shadows:    S.adj.shadows,
    temperature:S.adj.temperature
  };

  if (S.activeId) {
    await updateLayer(S.activeId, { adjustments: adjPIL });
  }
}

function pushHistoryOnChange() { pushHistory('Réglage'); }

$('resetAdjBtn').addEventListener('click', () => {
  $$('.adj-slider[data-param]').forEach(sl => {
    sl.value = 0;
    const vEl = $('sv-' + sl.dataset.param); if (vEl) vEl.textContent = '0';
    S.adj[sl.dataset.param] = 0;
  });
  if (S.activeId) {
    const def = {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0};
    updateLayer(S.activeId, { adjustments: def }).then(() => pushHistory('Réinitialisation'));
  }
});

// ── Layer opacity live ────────────────────────────────────────
$('layerOpacity').addEventListener('input', e => {
  $('sv-opacity').textContent = e.target.value + '%';
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) layer.opacity = parseInt(e.target.value);
  clearTimeout(S._opTimer);
  S._opTimer = setTimeout(() => updateLayer(S.activeId, {opacity:parseInt(e.target.value)}), 150);
});

$('layerBlend').addEventListener('change', e => {
  if (!S.activeId) return;
  updateLayer(S.activeId, { blend_mode: e.target.value }).then(() => pushHistory('Mode de fusion'));
});

$('gradAngle').addEventListener('input', e => {
  $('sv-gradAngle').textContent = e.target.value + '°';
  clearTimeout(S._gradTimer);
  S._gradTimer = setTimeout(() => {
    if (!S.activeId) return;
    updateLayer(S.activeId, { angle: parseInt(e.target.value) });
  }, 200);
});

$('textSize').addEventListener('input', e => {
  $('sv-textSize').textContent = e.target.value;
});

// ── Apply layer props ─────────────────────────────────────────
$('applyLayerPropsBtn').addEventListener('click', async () => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  const upd = {};
  if (layer.type==='solid')    { upd.color = $('solidColor').value; }
  if (layer.type==='gradient') { upd.color1=$('grad1').value; upd.color2=$('grad2').value; upd.angle=parseInt($('gradAngle').value); }
  if (layer.type==='text')     { upd.text=$('textContent').value; upd.font_size=parseInt($('textSize').value); upd.color=$('textColor').value; }
  Object.assign(layer, upd);
  await updateLayer(S.activeId, upd);
  pushHistory('Propriétés calque');
});

// ═══════════════════════════════════════════════════════════════
// GLOBAL FILTERS
// ═══════════════════════════════════════════════════════════════
$$('.chip:not(.lchip)').forEach(c => {
  c.addEventListener('click', () => {
    if (!S.activeId) { toast('Sélectionnez un calque', 'info'); return; }
    const f = c.dataset.filter;
    c.classList.toggle('active');
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer.filters) layer.filters = [];
    if (c.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    updateLayer(S.activeId, { filters: layer.filters }).then(() => pushHistory('Filtre'));
  });
});

$('clearFiltersBtn').addEventListener('click', () => {
  $$('.chip:not(.lchip)').forEach(c => c.classList.remove('active'));
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) layer.filters = [];
  updateLayer(S.activeId, { filters: [] }).then(() => pushHistory('Filtres effacés'));
});

// ── Per-layer adj sliders ─────────────────────────────────────
$$('.lslider').forEach(sl => {
  sl.addEventListener('input', () => {
    const p = sl.dataset.lparam;
    const lv = sl.closest('.slider-item')?.querySelector('.lv');
    if (lv) lv.textContent = sl.value;
    if (!S.activeId) return;
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    if (!layer.adjustments) layer.adjustments = {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0};
    layer.adjustments[p] = parseFloat(sl.value);
    clearTimeout(S._ladjTimer);
    S._ladjTimer = setTimeout(() => updateLayer(S.activeId, {adjustments:layer.adjustments}), 200);
  });
});

$('resetLayerAdjBtn').addEventListener('click', () => {
  if (!S.activeId) return;
  const def = {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0};
  $$('.lslider').forEach(sl => {
    sl.value = 0;
    const lv = sl.closest('.slider-item')?.querySelector('.lv'); if(lv) lv.textContent='0';
  });
  updateLayer(S.activeId, {adjustments:def}).then(() => pushHistory('Réinitialisation calque'));
});

// ── Per-layer filters ─────────────────────────────────────────
$$('.lchip').forEach(c => {
  c.addEventListener('click', () => {
    if (!S.activeId) return;
    const f = c.dataset.filter;
    c.classList.toggle('active');
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer.filters) layer.filters = [];
    if (c.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    updateLayer(S.activeId, {filters:layer.filters}).then(() => pushHistory('Filtre calque'));
  });
});

$('clearLayerFiltersBtn').addEventListener('click', () => {
  $$('.lchip').forEach(c => c.classList.remove('active'));
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) layer.filters = [];
  updateLayer(S.activeId, {filters:[]});
});

// ═══════════════════════════════════════════════════════════════
// TRANSFORMS (buttons)
// ═══════════════════════════════════════════════════════════════
$('rotL').addEventListener('click', () => transformActive('rot', -90));
$('rotR').addEventListener('click', () => transformActive('rot', +90));
$('flipH').addEventListener('click', () => transformActive('flipH'));
$('flipV').addEventListener('click', () => transformActive('flipV'));
$('resetTransformBtn').addEventListener('click', () => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.display_rotation = 0;
    layer.transforms = {rotation:0, flip_horizontal:false, flip_vertical:false};
  }
  updateLayer(S.activeId, {
    transforms:{rotation:0,flip_horizontal:false,flip_vertical:false},
    display_rotation:0
  }).then(() => pushHistory('Reset transforms'));
  $('tinfo-rot').textContent = 'Rotation : 0°';
});

function transformActive(type, val) {
  if (!S.activeId) { toast('Sélectionnez un calque', 'info'); return; }
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};

  let upd = {};
  if (type === 'rot') {
    layer.transforms.rotation = (layer.transforms.rotation + val + 360) % 360;
    upd = { transforms: layer.transforms };
    $('tinfo-rot').textContent = `Rotation : ${layer.transforms.rotation}°`;
  }
  if (type === 'flipH') { layer.transforms.flip_horizontal = !layer.transforms.flip_horizontal; upd = {transforms:layer.transforms}; }
  if (type === 'flipV') { layer.transforms.flip_vertical   = !layer.transforms.flip_vertical;   upd = {transforms:layer.transforms}; }

  updateLayer(S.activeId, upd).then(() => pushHistory('Transform'));
}

// ═══════════════════════════════════════════════════════════════
// ADD LAYER BUTTONS
// ═══════════════════════════════════════════════════════════════
$('addSolidBtn').addEventListener('click', async () => {
  if (!S.projectId) await createProject();
  await addLayer({type:'solid', color:'#3a3a5c', name:'Couleur unie'});
});

$('addGradientBtn').addEventListener('click', async () => {
  if (!S.projectId) await createProject();
  await addLayer({type:'gradient', color1:'#1a1a2e', color2:'#e8c547', angle:135, name:'Dégradé'});
});

$('addTextBtn').addEventListener('click', async () => {
  if (!S.projectId) await createProject();
  const txt = prompt('Texte :', 'Open Photo Editor');
  if (!txt) return;
  await addLayer({type:'text', text:txt, font_size:72, color:'#ffffff', x:80, y:80, name:`Texte`});
});

$('newProjectBtn').addEventListener('click', async () => {
  await createProject(parseInt($('newW').value)||1920, parseInt($('newH').value)||1080);
  toast(`Projet ${S.canvasW}×${S.canvasH}`, 'success');
});

// ═══════════════════════════════════════════════════════════════
// LAYERS LIST RENDER
// ═══════════════════════════════════════════════════════════════
function renderLayers() {
  const list = $('layersList');
  list.innerHTML = '';
  $('layerBadge').textContent = S.layers.length;

  if (!S.layers.length) {
    list.innerHTML = '<div class="no-layers">Aucun calque</div>';
    return;
  }

  // Show top-to-bottom (reversed from internal order)
  [...S.layers].reverse().forEach(layer => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === S.activeId ? ' selected' : '');

    // Thumb
    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    if (layer.type === 'solid') {
      const fill = document.createElement('div');
      fill.className = 'layer-thumb-fill';
      fill.style.background = layer.color || '#333';
      thumb.style.background = layer.color || '#333';
      thumb.appendChild(fill);
    } else if (layer.type === 'gradient') {
      thumb.style.background = `linear-gradient(${layer.angle||135}deg,${layer.color1||'#000'},${layer.color2||'#fff'})`;
    } else if (layer.type === 'text') {
      thumb.textContent = 'T';
      thumb.style.cssText = 'font:bold 13px serif;color:#eee;background:var(--bg4);display:flex;align-items:center;justify-content:center';
    } else {
      thumb.innerHTML = '<span style="font-size:11px;color:var(--text3)">🖼</span>';
    }

    // Info
    const main = document.createElement('div'); main.className = 'layer-main';
    const nm = document.createElement('div'); nm.className = 'layer-name'; nm.textContent = layer.name || 'Calque';
    const sub= document.createElement('div'); sub.className = 'layer-sub';
    sub.textContent = `${layer.blend_mode||'normal'} · ${layer.opacity??100}%`;
    if (layer.visible===false) sub.textContent += ' · caché';
    main.append(nm, sub);

    // Actions
    const btns = document.createElement('div'); btns.className = 'layer-btns';

    const mkBtn = (icon, cls, title, fn) => {
      const b = document.createElement('button');
      b.className = 'lbtn ' + (cls||''); b.title = title; b.textContent = icon;
      b.addEventListener('click', e => { e.stopPropagation(); fn(layer); });
      return b;
    };

    // Visibility
    const visBtn = mkBtn(layer.visible===false?'○':'●', 'vis'+(layer.visible===false?' hidden':''), 'Visibilité', async l => {
      l.visible = l.visible===false;
      await updateLayer(l.id, {visible:l.visible});
    });

    // Move up
    const upBtn  = mkBtn('↑','','Monter',  async l => {
      const i = S.layers.findIndex(x=>x.id===l.id);
      if (i < S.layers.length-1) { [S.layers[i],S.layers[i+1]]=[S.layers[i+1],S.layers[i]]; await reorder(); }
    });
    // Move down
    const dnBtn  = mkBtn('↓','','Descendre',async l => {
      const i = S.layers.findIndex(x=>x.id===l.id);
      if (i > 0) { [S.layers[i],S.layers[i-1]]=[S.layers[i-1],S.layers[i]]; await reorder(); }
    });
    // Duplicate
    const dupBtn = mkBtn('⧉','','Dupliquer',async l => { await duplicateLayer(l.id); });
    // Delete
    const delBtn = mkBtn('✕','danger','Supprimer',async l => {
      if (!confirm(`Supprimer "${l.name}" ?`)) return;
      await deleteLayer(l.id);
    });

    btns.append(visBtn, upBtn, dnBtn, dupBtn, delBtn);
    item.append(thumb, main, btns);
    item.addEventListener('click', () => setActive(layer.id));
    list.appendChild(item);
  });
}

function updateRPInfo() {
  $('rpInfo').style.display = '';
  $('rpCanvasSize').textContent = `${S.canvasW} × ${S.canvasH}`;
  $('rpLayerCount').textContent = S.layers.length;
}

// ═══════════════════════════════════════════════════════════════
// MERGE / FLATTEN
// ═══════════════════════════════════════════════════════════════
$('mergeBtn').addEventListener('click', async () => {
  if (S.layers.length < 2) return;
  if (!confirm('Fusionner tous les calques visibles ?')) return;
  showProcessing(true);
  try {
    const ids = S.layers.filter(l=>l.visible!==false).map(l=>l.id);
    const r = await fetch(`/api/project/${S.projectId}/layers/merge`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({layer_ids:ids})
    });
    const d = await r.json();
    S.layers = [d.layer];
    setPreview(d.preview);
    setActive(d.layer.id);
    renderLayers(); updateRPInfo();
    pushHistory('Fusion');
    toast('Calques fusionnés', 'success');
  } catch(e) { toast('Erreur fusion', 'error'); }
  finally { showProcessing(false); }
});

$('flattenBtn').addEventListener('click', () => $('mergeBtn').click());

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════
$('exportQuality').addEventListener('input', e => { $('sv-quality').textContent = e.target.value; });
$('exportFmt').addEventListener('change', e => { $('qualRow').style.display = e.target.value==='png' ? 'none' : ''; });

async function doExport() {
  if (!S.projectId) return;
  showProcessing(true); toast('Export…', 'info');
  try {
    const r = await fetch(`/api/project/${S.projectId}/export`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ format:$('exportFmt').value, quality:parseInt($('exportQuality').value) })
    });
    if (!r.ok) throw new Error('Export failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`composition.${$('exportFmt').value}`; a.click();
    URL.revokeObjectURL(url);
    toast('Exporté !', 'success');
  } catch(e) { toast('Erreur export', 'error'); }
  finally { showProcessing(false); }
}

$('exportBtn').addEventListener('click', doExport);
$('downloadBtn').addEventListener('click', doExport);

// ═══════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════
function pushHistory(label) {
  // Simplified: just track label for undo UI
  S.history = S.history.slice(0, S.histIdx+1);
  S.history.push({ label, ts: Date.now() });
  if (S.history.length > 30) S.history.shift();
  else S.histIdx++;
  $('undoBtn').disabled = S.histIdx <= 0;
}

$('undoBtn').addEventListener('click', () => {
  toast('Annuler n\'est pas encore disponible après transformation — rechargez la page pour recommencer', 'info');
});

// ═══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'v' || e.key === 'V') setTool('select');
  if (e.key === 'c' || e.key === 'C') setTool('crop');
  if (e.key === 'h' || e.key === 'H') setTool('pan');
  if (e.key === ' ') { e.preventDefault(); setTool('pan'); }

  if (e.ctrlKey || e.metaKey) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); S.zoom=Math.min(S.zoom*1.2,8); applyViewport(); }
    if (e.key === '-') { e.preventDefault(); S.zoom=Math.max(S.zoom*.8,.05); applyViewport(); }
    if (e.key === '0') { e.preventDefault(); fitZoom(); }
    if (e.key === 'o') { e.preventDefault(); $('fileInput').click(); }
    if (e.key === 's') { e.preventDefault(); doExport(); }
    if (e.key === 'z') { e.preventDefault(); $('undoBtn').click(); }
    if (e.key === 'd' && S.activeId) { e.preventDefault(); duplicateLayer(S.activeId); }
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && S.activeId) {
    e.preventDefault();
    if (confirm(`Supprimer le calque ?`)) deleteLayer(S.activeId);
  }

  if (e.key === 'Escape') {
    if (S.tool === 'crop') { $('cancelCropBtn').click(); }
    else setActive(null);
  }

  // Arrow keys = nudge selected layer
  if (S.activeId && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const layer = S.layers.find(l=>l.id===S.activeId);
    if (!layer) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key==='ArrowLeft')  layer.x = (layer.x||0) - step;
    if (e.key==='ArrowRight') layer.x = (layer.x||0) + step;
    if (e.key==='ArrowUp')    layer.y = (layer.y||0) - step;
    if (e.key==='ArrowDown')  layer.y = (layer.y||0) + step;
    updateTransformBox(layer);
    scheduleLayerUpdate(S.activeId, {x:layer.x, y:layer.y});
  }
});

document.addEventListener('keyup', e => {
  if (e.key === ' ' && S.tool === 'pan') setTool('select');
});

// ═══════════════════════════════════════════════════════════════
// CURSOR POSITION TRACKING
// ═══════════════════════════════════════════════════════════════
$('canvasScene').addEventListener('mousemove', e => {
  if (S.dragging) return;
  const pt = screenToCanvas(e.clientX, e.clientY);
  $('infoPos').textContent = `x:${Math.round(pt.x)} y:${Math.round(pt.y)}`;
});

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
console.log('%cOpen Photo Editor v3.0', 'color:#e8c547;font-family:monospace;font-size:14px;font-weight:bold');
console.log('%cMouse-driven · Layers · Open Source', 'color:#55556a;font-family:monospace');
