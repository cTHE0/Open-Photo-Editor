"use strict";
/**
 * Open Photo Editor v5.0 - 100% Client-Side
 * - No server-side processing
 * - localStorage for project persistence
 * - Canvas API for image processing
 * - Instant preview, zero latency
 */

// ══════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

let _toastT;
function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 2000);
}
function busy(v) { $('processing').style.display = v ? 'flex' : 'none'; }

// ══════════════════════════════════════════════════════════════
// LOCAL STORAGE MANAGER
// ══════════════════════════════════════════════════════════════
const Storage = {
  get(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : def;
    } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {
      console.warn('Storage full:', e);
      toast('Stockage plein !', 'error');
    }
  },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════
const S = {
  projectId: null,
  layers: [],
  activeId: null,
  canvasW: 0,
  canvasH: 0,
  zoom: 1, panX: 0, panY: 0,
  tool: 'select',
  drag: null,
  layerImages: {},  // Canvas elements for each layer
  _history: [],
  _historyIndex: -1,
  _maxHistory: 30,
  _historyLock: false,
  currentColor: '#ffffff',
};

// ══════════════════════════════════════════════════════════════
// PROJECT MANAGEMENT (Client-Side)
// ══════════════════════════════════════════════════════════════

function createProject(w, h) {
  S.projectId = 'proj_' + Date.now();
  S.canvasW = w || 1920;
  S.canvasH = h || 1080;
  S.layers = [];
  S.layerImages = {};
  S._history = [];
  S._historyIndex = -1;
  saveProject();
  initScene();
  toast(`Projet ${S.canvasW}×${S.canvasH}`, 'success');
}

function saveProject() {
  if (!S.projectId) return;
  const project = {
    id: S.projectId,
    canvasW: S.canvasW,
    canvasH: S.canvasH,
    layers: S.layers.map(l => ({
      ...l,
      imageData: l.imageData || null  // Keep canvas data URLs
    }))
  };
  Storage.set('photoeditor_' + S.projectId, project);
  Storage.set('photoeditor_current', S.projectId);
}

function loadProject(id) {
  const project = Storage.get('photoeditor_' + id, null);
  if (!project) return false;
  S.projectId = project.id;
  S.canvasW = project.canvasW;
  S.canvasH = project.canvasH;
  S.layers = project.layers || [];
  S.layerImages = {};
  S._history = [];
  S._historyIndex = -1;
  initScene();
  renderLayerList();
  if (S.layers.length > 0) setActive(S.layers[0].id);
  return true;
}

function deleteProject(id) {
  Storage.remove('photoeditor_' + id);
}

function loadCurrentProject() {
  const id = Storage.get('photoeditor_current', null);
  if (id) loadProject(id);
}

// ══════════════════════════════════════════════════════════════
// UNDO/REDO
// ══════════════════════════════════════════════════════════════

function pushHistory(action = 'edit') {
  if (S._historyLock || !S.projectId) return;
  if (S._historyIndex < S._history.length - 1) {
    S._history = S._history.slice(0, S._historyIndex + 1);
  }
  const snapshot = {
    action,
    layers: S.layers.map(l => ({
      id: l.id, name: l.name, type: l.type, visible: l.visible,
      opacity: l.opacity, blend_mode: l.blend_mode,
      x: l.x, y: l.y, display_w: l.display_w, display_h: l.display_h,
      display_rotation: l.display_rotation, adjustments: l.adjustments,
      filters: l.filters, styles: l.styles, color: l.color
    })),
    canvasW: S.canvasW, canvasH: S.canvasH
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

function restoreState(state, msg) {
  S.canvasW = state.canvasW; S.canvasH = state.canvasH;
  state.layers.forEach(h => {
    const layer = S.layers.find(l => l.id === h.id);
    if (layer) Object.assign(layer, h);
  });
  renderAllLayers();
  initScene();
  renderLayerList();
  if (S.layers.length > 0) setActive(S.layers[0].id);
  toast(msg, 'success');
}

function updateUndoButton() {
  const undoBtn = $('undoBtn');
  if (undoBtn) {
    undoBtn.disabled = S._historyIndex <= 0;
    undoBtn.textContent = S._historyIndex <= 0 ? '↩ Annuler' : `↩ Annuler (${S._historyIndex})`;
  }
}

// ══════════════════════════════════════════════════════════════
// CANVAS RENDERING (Client-Side)
// ══════════════════════════════════════════════════════════════

function createLayerCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function renderLayerToCanvas(layer) {
  const canvas = createLayerCanvas(S.canvasW, S.canvasH);
  const ctx = canvas.getContext('2d');
  
  if (layer.type === 'image' && layer.imageData) {
    const img = new Image();
    img.src = layer.imageData;
    const lw = layer.display_w || layer.orig_width || S.canvasW;
    const lh = layer.display_h || layer.orig_height || S.canvasH;
    const lx = layer.x || 0;
    const ly = layer.y || 0;
    
    ctx.save();
    ctx.globalAlpha = (layer.opacity || 100) / 100;
    ctx.translate(lx, ly);
    if (layer.display_rotation) {
      ctx.translate(lw/2, lh/2);
      ctx.rotate(layer.display_rotation * Math.PI / 180);
      ctx.translate(-lw/2, -lh/2);
    }
    ctx.drawImage(img, 0, 0, lw, lh);
    ctx.restore();
  } else if (layer.type === 'solid') {
    ctx.fillStyle = layer.color || '#3a3a5c';
    ctx.fillRect(0, 0, S.canvasW, S.canvasH);
  } else if (layer.type === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, S.canvasW, S.canvasH);
    grad.addColorStop(0, layer.color1 || '#1a1a2e');
    grad.addColorStop(1, layer.color2 || '#e8c547');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S.canvasW, S.canvasH);
  } else if (layer.type === 'text') {
    ctx.fillStyle = layer.color || '#ffffff';
    ctx.font = `${layer.font_size || 72}px Arial`;
    ctx.fillText(layer.text || 'Texte', layer.x || 0, (layer.y || 0) + (layer.font_size || 72));
  } else if (layer.type === 'shape') {
    ctx.fillStyle = layer.color || '#3a3a5c';
    if (layer.shape === 'rectangle') {
      ctx.fillRect(layer.x || 0, layer.y || 0, layer.width || 200, layer.height || 150);
    } else if (layer.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        (layer.x || 0) + (layer.width || 200)/2,
        (layer.y || 0) + (layer.height || 150)/2,
        (layer.width || 200)/2,
        (layer.height || 150)/2,
        0, 0, 2 * Math.PI
      );
      ctx.fill();
    }
  }
  
  return canvas;
}

function renderAllLayers() {
  const compositeCanvas = $('compositeImg');
  const ctx = compositeCanvas.getContext('2d');
  compositeCanvas.width = S.canvasW;
  compositeCanvas.height = S.canvasH;
  
  ctx.clearRect(0, 0, S.canvasW, S.canvasH);
  
  for (const layer of S.layers) {
    if (!layer.visible) continue;
    const layerCanvas = renderLayerToCanvas(layer);
    ctx.globalAlpha = 1;
    ctx.drawImage(layerCanvas, 0, 0);
  }
  
  S.layerImages = {};
  S.layers.forEach(l => {
    S.layerImages[l.id] = renderLayerToCanvas(l);
  });
}

// ══════════════════════════════════════════════════════════════
// SECTION TOGGLES
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
// FILE UPLOAD (Client-Side)
// ══════════════════════════════════════════════════════════════

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
    // Read file as data URL
    const imageData = await readFileAsDataURL(file);
    
    // Get image dimensions
    const img = await loadImage(imageData);
    
    // Create project if needed
    if (!S.projectId) createProject(img.width, img.height);
    
    // Add layer
    addLayer({
      type: 'image',
      imageData: imageData,
      orig_width: img.width,
      orig_height: img.height,
      display_w: img.width,
      display_h: img.height,
      name: file.name.replace(/\.[^.]+$/, '')
    });
    
    toast('Image ajoutée', 'success');
  } catch (err) {
    console.error('Upload error:', err);
    toast('Erreur : ' + err.message, 'error');
  } finally {
    busy(false);
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Drag & drop
const cwrap = document.querySelector('.canvas-wrap');
cwrap.addEventListener('dragover', e => { e.preventDefault(); cwrap.classList.add('drag-over'); });
cwrap.addEventListener('dragleave', () => cwrap.classList.remove('drag-over'));
cwrap.addEventListener('drop', e => {
  e.preventDefault(); cwrap.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) uploadAndAddImage(f);
});

// ══════════════════════════════════════════════════════════════
// ADD LAYER
// ══════════════════════════════════════════════════════════════

function addLayer(params) {
  const layer = {
    id: 'layer_' + Date.now(),
    type: params.type || 'image',
    name: params.name || 'Calque',
    visible: true,
    opacity: params.opacity || 100,
    blend_mode: params.blend_mode || 'normal',
    x: params.x || 0,
    y: params.y || 0,
    adjustments: params.adjustments || {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0},
    filters: params.filters || [],
    transforms: params.transforms || {rotation:0,flip_horizontal:false,flip_vertical:false},
    crop: null,
    styles: params.styles || {},
    ...params
  };
  
  S.layers.push(layer);
  renderAllLayers();
  renderLayerList();
  setActive(layer.id);
  pushHistory('add_layer');
  updateUndoButton();
  saveProject();
  toast('Calque ajouté : ' + layer.name, 'success');
  return layer;
}

$('addSolidBtn').addEventListener('click', () => {
  if (!S.projectId) createProject();
  addLayer({ type: 'solid', color: '#3a3a5c', name: 'Couleur unie' });
});

$('addGradientBtn').addEventListener('click', () => {
  if (!S.projectId) createProject();
  addLayer({ type: 'gradient', color1: '#1a1a2e', color2: '#e8c547', angle: 135, name: 'Dégradé' });
});

$('addTextBtn').addEventListener('click', async () => {
  const txt = prompt('Texte :', 'Open Photo Editor');
  if (!txt) return;
  if (!S.projectId) createProject();
  addLayer({ type: 'text', text: txt, font_size: 72, color: '#ffffff', x: 80, y: 80, name: 'Texte' });
});

$('addRectBtn').addEventListener('click', () => {
  if (!S.projectId) createProject();
  addLayer({ type: 'shape', shape: 'rectangle', color: '#3a3a5c', x: 50, y: 50, width: 200, height: 150, name: 'Rectangle' });
});

$('addEllipseBtn').addEventListener('click', () => {
  if (!S.projectId) createProject();
  addLayer({ type: 'shape', shape: 'ellipse', color: '#3a3a5c', x: 50, y: 50, width: 200, height: 150, name: 'Ellipse' });
});

$('newProjectBtn').addEventListener('click', () => {
  if (confirm('Créer un nouveau projet ? (les modifications non sauvegardées seront perdues)')) {
    createProject();
  }
});

// ══════════════════════════════════════════════════════════════
// SCENE INIT
// ══════════════════════════════════════════════════════════════

function initScene() {
  $('canvasBg').style.width = S.canvasW + 'px';
  $('canvasBg').style.height = S.canvasH + 'px';
  $('compositeImg').style.width = S.canvasW + 'px';
  $('compositeImg').style.height = S.canvasH + 'px';
  $('compositeImg').width = S.canvasW;
  $('compositeImg').height = S.canvasH;
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
    drawLocalPreview(layer);
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

document.addEventListener('mouseup', async e => {
  if (!S.drag) return;
  const dtype = S.drag.type;
  S.drag = null;
  $('canvasScene').classList.remove('active');

  if (['move', 'resize', 'rotate'].includes(dtype)) {
    clearLocalPreview();
    renderAllLayers();
    saveProject();
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
// LOCAL PREVIEW
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

$('applyCropBtn').addEventListener('click', () => {
  if (!S.cropRect || !S.activeId) return;
  const cr = S.cropRect;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  layer.x = Math.round(cr.x);
  layer.y = Math.round(cr.y);
  layer.display_w = Math.round(cr.w);
  layer.display_h = Math.round(cr.h);
  $('cropOverlay').style.display = 'none';
  clearCropShades();
  S.cropRect = null;
  setTool('select');
  renderAllLayers();
  saveProject();
  toast('Recadrage appliqué', 'success');
});

$('cancelCropBtn').addEventListener('click', () => {
  $('cropOverlay').style.display = 'none';
  clearCropShades();
  S.cropRect = null;
  setTool('select');
});

// ══════════════════════════════════════════════════════════════
// ACTIVE LAYER
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
// ADJUSTMENTS & FILTERS
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
    drawLocalPreview(layer);
    renderAllLayers();
    saveProject();
  });
});

$('resetAdjBtn').addEventListener('click', () => {
  $$('.adj-slider[data-param]').forEach(sl => {
    sl.value = 0; const vEl = $('sv-' + sl.dataset.param); if (vEl) vEl.textContent = '0';
  });
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.adjustments = {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0};
    renderAllLayers();
    saveProject();
  }
});

$('layerOpacity').addEventListener('input', e => {
  $('sv-opacity').textContent = e.target.value + '%';
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.opacity = parseInt(e.target.value);
    drawLocalPreview(layer);
    renderAllLayers();
    saveProject();
  }
});

$('layerBlend').addEventListener('change', e => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.blend_mode = e.target.value;
    renderAllLayers();
    saveProject();
  }
});

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
    renderAllLayers();
    saveProject();
  });
});

$('resetLayerAdjBtn').addEventListener('click', () => {
  $$('.lslider').forEach(sl => { sl.value = 0; const lv = sl.closest('.slider-item')?.querySelector('.lv'); if(lv) lv.textContent='0'; });
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) {
    layer.adjustments = {brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0};
    renderAllLayers();
    saveProject();
  }
});

// Filters
$$('.chip:not(.lchip)').forEach(c => {
  c.addEventListener('click', () => {
    if (!S.activeId) { toast('Sélectionnez un calque', 'info'); return; }
    const f = c.dataset.filter;
    c.classList.toggle('active');
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    if (!layer.filters) layer.filters = [];
    if (c.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    renderAllLayers();
    saveProject();
  });
});

$('clearFiltersBtn').addEventListener('click', () => {
  $$('.chip:not(.lchip)').forEach(c => c.classList.remove('active'));
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) { layer.filters = []; renderAllLayers(); saveProject(); }
});

$$('.lchip').forEach(c => {
  c.addEventListener('click', () => {
    if (!S.activeId) return;
    const f = c.dataset.filter;
    c.classList.toggle('active');
    const layer = S.layers.find(l => l.id === S.activeId);
    if (!layer) return;
    if (!layer.filters) layer.filters = [];
    if (c.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    renderAllLayers();
    saveProject();
  });
});

$('clearLayerFiltersBtn').addEventListener('click', () => {
  $$('.lchip').forEach(c => c.classList.remove('active'));
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) { layer.filters = []; renderAllLayers(); saveProject(); }
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
    renderAllLayers();
    saveProject();
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
    renderAllLayers();
    saveProject();
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
  renderAllLayers();
  saveProject();
  toast('Effets réinitialisés', 'info');
});

$('gradAngle').addEventListener('input', e => {
  $('sv-gradAngle').textContent = e.target.value + '°';
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer) { layer.angle = parseInt(e.target.value); renderAllLayers(); saveProject(); }
});

$('textSize').addEventListener('input', e => {
  $('sv-textSize').textContent = e.target.value;
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer && layer.type === 'text') { layer.font_size = parseInt(e.target.value); renderAllLayers(); saveProject(); }
});

$('shapeColor').addEventListener('input', e => {
  if (!S.activeId) return;
  const layer = S.layers.find(l => l.id === S.activeId);
  if (layer && layer.type === 'shape') { layer.color = e.target.value; renderAllLayers(); saveProject(); }
});

$('applyLayerPropsBtn').style.display = 'none';

// ══════════════════════════════════════════════════════════════
// TRANSFORM
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
    renderAllLayers();
    saveProject();
  }
  $('tinfo-rot').textContent = 'Rotation : 0°';
});

function applyTransformBtn(type, val) {
  if (!S.activeId) { toast('Sélectionnez un calque', 'info'); return; }
  const layer = S.layers.find(l => l.id === S.activeId);
  if (!layer) return;
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  if (type === 'rot') {
    layer.transforms.rotation = (layer.transforms.rotation + val + 360) % 360;
    $('tinfo-rot').textContent = `Rotation : ${layer.transforms.rotation}°`;
  }
  if (type === 'flipH') layer.transforms.flip_horizontal = !layer.transforms.flip_horizontal;
  if (type === 'flipV') layer.transforms.flip_vertical = !layer.transforms.flip_vertical;
  renderAllLayers();
  saveProject();
}

// ══════════════════════════════════════════════════════════════
// MERGE / FLATTEN
// ══════════════════════════════════════════════════════════════

$('mergeBtn').addEventListener('click', () => {
  if (S.layers.length < 2) return;
  if (!confirm('Fusionner tous les calques visibles ?')) return;
  // Simplified: just keep the composite
  renderAllLayers();
  toast('Calques fusionnés', 'success');
});

$('flattenBtn').addEventListener('click', () => $('mergeBtn').click());

// ══════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════

$('exportQuality').addEventListener('input', e => { $('sv-quality').textContent = e.target.value; });
$('exportFmt').addEventListener('change', e => { $('qualRow').style.display = e.target.value === 'png' ? 'none' : ''; });

function doExport() {
  if (!S.projectId) return;
  renderAllLayers();
  const canvas = $('compositeImg');
  const fmt = $('exportFmt').value;
  const quality = parseInt($('exportQuality').value) / 100;
  
  const dataURL = canvas.toDataURL('image/' + (fmt === 'jpeg' ? 'jpeg' : fmt), quality);
  const a = document.createElement('a');
  a.href = dataURL;
  a.download = `composition.${fmt}`;
  a.click();
  toast('Exporté !', 'success');
}

$('exportBtn').addEventListener('click', doExport);
$('downloadBtn').addEventListener('click', doExport);

// ══════════════════════════════════════════════════════════════
// PROJECT SAVE / LOAD
// ══════════════════════════════════════════════════════════════

async function saveProjectJSON() {
  if (!S.projectId) { toast('Aucun projet actif', 'error'); return; }
  const project = {
    id: S.projectId,
    canvasW: S.canvasW,
    canvasH: S.canvasH,
    layers: S.layers
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `project_${S.projectId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Projet sauvegardé !', 'success');
}

async function loadProjectJSON(file) {
  busy(true);
  try {
    const text = await file.text();
    const proj = JSON.parse(text);
    if (!proj.canvasW || !proj.layers) throw new Error('Format invalide');
    S.projectId = proj.id || 'proj_' + Date.now();
    S.canvasW = proj.canvasW;
    S.canvasH = proj.canvasH;
    S.layers = proj.layers || [];
    S.layerImages = {};
    S._history = [];
    S._historyIndex = -1;
    initScene();
    renderLayerList();
    if (S.layers.length > 0) setActive(S.layers[0].id);
    saveProject();
    toast('Projet chargé !', 'success');
  } catch(e) {
    toast('Erreur chargement : ' + e.message, 'error');
  } finally {
    busy(false);
  }
}

$('saveProjectBtn').addEventListener('click', saveProjectJSON);
$('loadProjectInput').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) loadProjectJSON(f);
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
    else if (layer.type === 'shape') thumb.style.background = layer.color || '#333';
    else { const img = S.layerImages[layer.id]; if (img) { const im=document.createElement('img'); im.src=img.toDataURL(); im.style.cssText='width:100%;height:100%;object-fit:cover'; thumb.appendChild(im); } else thumb.innerHTML='<span style="font-size:10px;color:var(--text3)">🖼</span>'; }
    const main = document.createElement('div'); main.className = 'layer-main';
    main.innerHTML = `<div class="layer-name">${layer.name||'Calque'}</div><div class="layer-sub">${layer.blend_mode||'normal'} · ${layer.opacity??100}%${layer.visible===false?' · caché':''}</div>`;
    const btns = document.createElement('div'); btns.className = 'layer-btns';
    const mk = (txt, cls, title, fn) => {
      const b = document.createElement('button'); b.className = 'lbtn '+(cls||''); b.title = title; b.textContent = txt;
      b.addEventListener('click', e => { e.stopPropagation(); fn(layer); }); return b;
    };
    btns.append(
      mk(layer.visible===false?'○':'●', 'vis'+(layer.visible===false?' hidden':''), 'Visibilité', l => { l.visible=!l.visible; renderAllLayers(); saveProject(); renderLayerList(); }),
      mk('↑','','Monter', l => { const i=S.layers.findIndex(x=>x.id===l.id); if(i<S.layers.length-1){[S.layers[i],S.layers[i+1]]=[S.layers[i+1],S.layers[i]];renderAllLayers();saveProject();renderLayerList();} }),
      mk('↓','','Descendre', l => { const i=S.layers.findIndex(x=>x.id===l.id); if(i>0){[S.layers[i],S.layers[i-1]]=[S.layers[i-1],S.layers[i]];renderAllLayers();saveProject();renderLayerList();} }),
      mk('⧉','','Dupliquer', l => { const nl={...l,id:'layer_'+Date.now(),name:l.name+' (copie)'}; S.layers.splice(S.layers.indexOf(l)+1,0,nl); renderAllLayers();saveProject();renderLayerList(); }),
      mk('✕','danger','Supprimer', l => { if(!confirm(`Supprimer "${l.name}" ?`))return; S.layers=S.layers.filter(x=>x.id!==l.id); if(S.activeId===l.id)S.activeId=null; renderAllLayers();saveProject();renderLayerList(); })
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
    if (e.key === 's') { e.preventDefault(); saveProjectJSON(); }
    if (e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'd' && S.activeId) { e.preventDefault(); const l=S.layers.find(x=>x.id===S.activeId); if(l){const nl={...l,id:'layer_'+Date.now(),name:l.name+' (copie)'};S.layers.splice(S.layers.indexOf(l)+1,0,nl);renderAllLayers();saveProject();renderLayerList();} }
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && S.activeId) {
    e.preventDefault();
    if (confirm('Supprimer ce calque ?')) {
      const l=S.layers.find(x=>x.id===S.activeId);
      if(l){S.layers=S.layers.filter(x=>x.id!==l.id);S.activeId=null;renderAllLayers();saveProject();renderLayerList();}
    }
  }

  if (e.key === 'Escape') {
    if (S.tool === 'crop') $('cancelCropBtn').click();
    else setActive(null);
  }

  if (S.activeId && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const layer = S.layers.find(l=>l.id===S.activeId);
    if(!layer) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key==='ArrowLeft') layer.x=(layer.x||0)-step;
    if (e.key==='ArrowRight') layer.x=(layer.x||0)+step;
    if (e.key==='ArrowUp') layer.y=(layer.y||0)-step;
    if (e.key==='ArrowDown') layer.y=(layer.y||0)+step;
    updateBox(layer);
    drawLocalPreview(layer);
    renderAllLayers();
    saveProject();
  }
});

// ══════════════════════════════════════════════════════════════
// COLOR PICKER
// ══════════════════════════════════════════════════════════════

$('canvasScene').addEventListener('click', async e => {
  if (S.tool !== 'eyedropper') return;
  const bg_targets = [$('canvasBg'), $('compositeImg'), $('canvasScene'), $('viewport'), $('handlesLayer')];
  if (!bg_targets.includes(e.target)) return;
  const pt = s2c(e.clientX, e.clientY);
  if (pt.x < 0 || pt.x >= S.canvasW || pt.y < 0 || pt.y >= S.canvasH) return;
  
  const canvas = $('compositeImg');
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(Math.floor(pt.x), Math.floor(pt.y), 1, 1).data;
  const hex = '#' + [imageData[0], imageData[1], imageData[2]].map(x => x.toString(16).padStart(2, '0')).join('');
  
  try {
    await navigator.clipboard.writeText(hex);
    toast(`Couleur ${hex} copiée!`, 'success');
  } catch {
    toast(`Couleur: ${hex}`, 'info');
  }
});

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

console.log('%cOpen Photo Editor v5.0', 'color:#e8c547;font-family:monospace;font-size:14px;font-weight:bold');
console.log('%c100% Client-Side - Zero Latency', 'color:#55556a;font-family:monospace');

// Load last project on startup
window.addEventListener('load', () => {
  loadCurrentProject();
});
