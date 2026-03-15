"use strict";
/**
 * Open Photo Editor v2.0 — Frontend
 * Two modes: Simple retouche & Layers/Compose
 */

// ══════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function showToast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════════════════════
// MODE SWITCHER
// ══════════════════════════════════════════════════════════════

let currentMode = 'simple';

$('modeSimple').addEventListener('click', () => {
  setMode('simple');
});
$('modeCompose').addEventListener('click', () => {
  setMode('compose');
});

function setMode(mode) {
  currentMode = mode;
  $('appSimple').style.display  = mode === 'simple'  ? 'grid' : 'none';
  $('appCompose').style.display = mode === 'compose' ? 'grid' : 'none';
  $('modeSimple').classList.toggle('active',  mode === 'simple');
  $('modeCompose').classList.toggle('active', mode === 'compose');
}

// ══════════════════════════════════════════════════════════════
// SIMPLE MODE
// ══════════════════════════════════════════════════════════════

const simple = {
  fileId: null,
  originalExt: null,
  width: 0, height: 0, mode: '',
  zoom: 1,
  debounce: null,
  cropActive: false, cropStart: null, cropRect: null, activeCrop: null,
  dragging: false, dStartX: 0, dStartY: 0,
  filters: [],
  transforms: { rotation: 0, flip_horizontal: false, flip_vertical: false },
  history: [], historyIndex: -1,
  adj: { brightness:100, contrast:100, saturation:100, sharpness:100, exposure:0, highlights:0, shadows:0, temperature:0 }
};

// --- Upload ---
$('fileInputSimple').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) simpleUpload(f);
});

async function simpleUpload(file) {
  if (!file.type.startsWith('image/')) { showToast('Format non supporté', 'error'); return; }
  simpleShowProcessing(true);
  const fd = new FormData(); fd.append('file', file);
  try {
    const r = await fetch('/api/upload', { method:'POST', body:fd });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    simple.fileId = d.file_id;
    simple.width  = d.width;
    simple.height = d.height;
    simple.mode   = d.mode || 'RGB';
    simpleReset();
    $('simpleImage').src = d.preview;
    $('simpleImageWrapper').style.display = 'inline-block';
    $('simpleEmptyState').style.display   = 'none';
    $('simpleInfoBar').style.display      = 'flex';
    $('simpleDownloadBtn').disabled       = false;
    $('sendToComposeBtn').disabled        = false;
    $('simpleImgDim').textContent  = `${d.width} × ${d.height}`;
    $('simpleImgMode').textContent = simple.mode;
    simpleUpdateInfo(d.width, d.height, simple.mode);
    simpleMiniPreview(d.preview);
    simpleFitZoom();
    simplePushHistory('Original');
    showToast(`Chargée : ${d.width}×${d.height}`, 'success');
  } catch(e) { showToast('Erreur : ' + e.message, 'error'); }
  finally { simpleShowProcessing(false); }
}

function simpleReset() {
  simple.zoom = 1;
  simple.filters = [];
  simple.transforms = { rotation:0, flip_horizontal:false, flip_vertical:false };
  simple.activeCrop = null;
  simple.adj = { brightness:100, contrast:100, saturation:100, sharpness:100, exposure:0, highlights:0, shadows:0, temperature:0 };
  simple.history = []; simple.historyIndex = -1;
  $$('.slider[data-param]').forEach(s => { s.value = s.defaultValue; simpleUpdateSlider(s); });
  $$('.filter-btn:not(.lfilter-btn)').forEach(b => b.classList.remove('active'));
  simpleUpdateActiveFilters();
  simpleUpdateTransformState();
  simpleCancelCrop();
}

function simpleShowProcessing(v) { $('simpleProcessing').style.display = v ? 'flex' : 'none'; }
function simpleMiniPreview(src) {
  const mp = $('simpleMiniPreview');
  mp.innerHTML = '';
  const img = document.createElement('img'); img.src = src; mp.appendChild(img);
}
function simpleUpdateInfo(w, h, mode) {
  $('simpleImgInfo').style.display = '';
  $('iW').textContent = w + ' px'; $('iH').textContent = h + ' px'; $('iM').textContent = mode;
}

// --- Sliders ---
function simpleUpdateSlider(sl) {
  const p = sl.dataset.param;
  if (!p) return;
  const v = $('v_' + p);
  if (v) v.textContent = sl.value;
  simple.adj[p] = parseFloat(sl.value);
}

$$('.slider[data-param]').forEach(sl => {
  sl.addEventListener('input', () => { simpleUpdateSlider(sl); simpleSchedule(); });
  sl.addEventListener('change', () => { if (simple.fileId) simplePushHistory('Ajustement'); });
});

$('simpleQuality').addEventListener('input', e => { $('simpleQualVal').textContent = e.target.value; });
$('simpleExportFmt').addEventListener('change', e => { $('simpleQualityRow').style.display = e.target.value === 'png' ? 'none' : ''; });

function simpleSchedule(d = 350) {
  clearTimeout(simple.debounce);
  simple.debounce = setTimeout(() => simpleProcess(), d);
}

async function simpleProcess() {
  if (!simple.fileId) return;
  simpleShowProcessing(true);
  try {
    const r = await fetch('/api/process', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        file_id: simple.fileId, original_ext: simple.originalExt,
        adjustments: {...simple.adj}, filters: [...simple.filters],
        transforms: {...simple.transforms}, crop: simple.activeCrop
      })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    $('simpleImage').src = d.preview;
    simpleMiniPreview(d.preview);
    $('simpleImgDim').textContent = `${d.width} × ${d.height}`;
    simpleUpdateInfo(d.width, d.height, simple.mode);
  } catch(e) { showToast('Erreur traitement', 'error'); }
  finally { simpleShowProcessing(false); }
}

// --- Filters ---
$$('.filter-btn:not(.lfilter-btn)').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!simple.fileId) { showToast('Chargez une image d\'abord', 'info'); return; }
    const f = btn.dataset.filter;
    btn.classList.toggle('active');
    if (btn.classList.contains('active')) simple.filters.push(f);
    else simple.filters = simple.filters.filter(x => x !== f);
    simpleUpdateActiveFilters();
    simpleSchedule(100);
    simplePushHistory('Filtre : ' + f);
  });
});

$('clearFiltersBtn').addEventListener('click', () => {
  simple.filters = [];
  $$('.filter-btn:not(.lfilter-btn)').forEach(b => b.classList.remove('active'));
  simpleUpdateActiveFilters();
  if (simple.fileId) { simpleSchedule(100); simplePushHistory('Filtres effacés'); }
});

function simpleUpdateActiveFilters() {
  const el = $('simpleActiveFilters');
  el.querySelectorAll('.filter-tag').forEach(t => t.remove());
  const no = el.querySelector('.no-filters');
  if (simple.filters.length === 0) {
    if (!no) { const s = document.createElement('span'); s.className='no-filters'; s.textContent='Aucun'; el.appendChild(s); }
  } else {
    if (no) no.remove();
    simple.filters.forEach(f => { const t = document.createElement('span'); t.className='filter-tag'; t.textContent=f; el.appendChild(t); });
  }
}

// --- Reset ---
$('resetAdjBtn').addEventListener('click', () => {
  const def = { brightness:100, contrast:100, saturation:100, sharpness:100, exposure:0, highlights:0, shadows:0, temperature:0 };
  Object.entries(def).forEach(([k,v]) => {
    const s = $('s_' + k); if (s) { s.value = v; simple.adj[k] = v; }
    const val = $('v_' + k); if (val) val.textContent = v;
  });
  if (simple.fileId) { simpleSchedule(100); simplePushHistory('Réinitialisation'); }
});

// --- Transforms ---
$('rotL').addEventListener('click',  () => simpleTransform(() => simple.transforms.rotation = (simple.transforms.rotation - 90 + 360) % 360, 'Rotation −90°'));
$('rotR').addEventListener('click',  () => simpleTransform(() => simple.transforms.rotation = (simple.transforms.rotation + 90) % 360, 'Rotation +90°'));
$('flipH').addEventListener('click', () => simpleTransform(() => simple.transforms.flip_horizontal = !simple.transforms.flip_horizontal, 'Miroir H'));
$('flipV').addEventListener('click', () => simpleTransform(() => simple.transforms.flip_vertical = !simple.transforms.flip_vertical, 'Miroir V'));
$('resetTransformBtn').addEventListener('click', () => {
  simple.transforms = { rotation:0, flip_horizontal:false, flip_vertical:false };
  simpleUpdateTransformState();
  if (simple.fileId) { simpleSchedule(100); simplePushHistory('Transforms réinitialisés'); }
});

function simpleTransform(fn, label) {
  if (!simple.fileId) return;
  fn(); simpleUpdateTransformState(); simpleSchedule(100); simplePushHistory(label);
}
function simpleUpdateTransformState() {
  $('stateRot').textContent   = simple.transforms.rotation + '°';
  $('stateFlipH').textContent = simple.transforms.flip_horizontal ? 'Oui' : 'Non';
  $('stateFlipV').textContent = simple.transforms.flip_vertical   ? 'Oui' : 'Non';
}

// --- Crop ---
$('cropToggleBtn').addEventListener('click', () => {
  if (!simple.fileId) { showToast('Chargez une image', 'info'); return; }
  simple.cropActive = !simple.cropActive;
  if (simple.cropActive) {
    $('cropOverlay').style.display = 'block';
    $('cropToggleBtn').textContent  = '✕ Annuler recadrage';
    $('cropToggleBtn').classList.add('active-tool');
    $('applyCropBtn').style.display  = '';
    $('cancelCropBtn').style.display = '';
    showToast('Dessinez une zone de recadrage', 'info');
  } else { simpleCancelCrop(); }
});
$('applyCropBtn').addEventListener('click', () => {
  if (!simple.cropRect) { showToast('Dessinez une zone', 'info'); return; }
  const ir = $('simpleImage').getBoundingClientRect();
  const scaleX = simple.width  / (ir.width  / simple.zoom);
  const scaleY = simple.height / (ir.height / simple.zoom);
  const br = $('cropBox').getBoundingClientRect();
  simple.activeCrop = {
    x: Math.round((br.left - ir.left) / simple.zoom * scaleX),
    y: Math.round((br.top  - ir.top)  / simple.zoom * scaleY),
    width:  Math.round(br.width  / simple.zoom * scaleX),
    height: Math.round(br.height / simple.zoom * scaleY)
  };
  simpleCancelCrop(); simpleSchedule(100); simplePushHistory('Recadrage'); showToast('Recadrage appliqué', 'success');
});
$('cancelCropBtn').addEventListener('click', simpleCancelCrop);

function simpleCancelCrop() {
  simple.cropActive = false;
  $('cropOverlay').style.display = 'none';
  $('cropBox').style.display = 'none'; $('cropBox').style.width = '0'; $('cropBox').style.height = '0';
  simple.cropRect = null;
  $('cropToggleBtn').textContent = '✂ Activer'; $('cropToggleBtn').classList.remove('active-tool');
  $('applyCropBtn').style.display = 'none'; $('cancelCropBtn').style.display = 'none';
}

let cDragging = false, cSX, cSY;
$('cropOverlay').addEventListener('mousedown', e => {
  if (!simple.cropActive) return;
  const r = $('cropOverlay').getBoundingClientRect();
  cSX = e.clientX - r.left; cSY = e.clientY - r.top; cDragging = true;
  $('cropBox').style.cssText = `display:block;left:${cSX}px;top:${cSY}px;width:0;height:0`;
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!cDragging) return;
  const r = $('cropOverlay').getBoundingClientRect();
  const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
  const cy = Math.max(0, Math.min(e.clientY - r.top,  r.height));
  const x = Math.min(cSX,cx), y = Math.min(cSY,cy), w = Math.abs(cx-cSX), h = Math.abs(cy-cSY);
  $('cropBox').style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  simple.cropRect = {x,y,width:w,height:h};
});
document.addEventListener('mouseup', () => { cDragging = false; });

// --- Zoom ---
$('zoomIn').addEventListener('click',  () => { simple.zoom = Math.min(simple.zoom * 1.25, 5); simpleUpdateZoom(); });
$('zoomOut').addEventListener('click', () => { simple.zoom = Math.max(simple.zoom * .8, .1);  simpleUpdateZoom(); });
$('zoomFit').addEventListener('click', simpleFitZoom);

function simpleFitZoom() {
  if (!simple.fileId) return;
  const a = $('simpleCanvas').getBoundingClientRect();
  simple.zoom = Math.min((a.width-60)/simple.width, (a.height-80)/simple.height, 1);
  simpleUpdateZoom();
}
function simpleUpdateZoom() {
  $('zoomLevel').textContent = Math.round(simple.zoom*100) + '%';
  $('simpleImageWrapper').style.transform = `scale(${simple.zoom})`;
}

$('simpleCanvas').addEventListener('wheel', e => {
  if (!simple.fileId) return;
  e.preventDefault();
  simple.zoom = Math.max(.1, Math.min(simple.zoom * (e.deltaY > 0 ? .9 : 1.1), 5));
  simpleUpdateZoom();
}, { passive:false });

// --- Drag & Drop ---
$('simpleCanvas').addEventListener('dragover',  e => { e.preventDefault(); $('simpleCanvas').classList.add('drag-over'); });
$('simpleCanvas').addEventListener('dragleave', () => $('simpleCanvas').classList.remove('drag-over'));
$('simpleCanvas').addEventListener('drop', e => {
  e.preventDefault(); $('simpleCanvas').classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) simpleUpload(f);
});

// --- Tabs ---
$$('.tab').forEach(tab => {
  if (!tab.dataset.tab) return;
  tab.addEventListener('click', () => {
    const tabs = tab.closest('.tabs').querySelectorAll('.tab');
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const parent = tab.closest('.panel-left') || tab.closest('.panel');
    const all = parent ? parent.querySelectorAll('.tab-content') : $$('.tab-content');
    all.forEach(c => c.classList.remove('active'));
    const tc = $('tab-' + tab.dataset.tab);
    if (tc) tc.classList.add('active');
  });
});

// Layer tabs
$$('[data-ltab]').forEach(tab => {
  tab.addEventListener('click', () => {
    tab.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.ltab-content').forEach(c => c.classList.remove('active'));
    $('ltab-' + tab.dataset.ltab).classList.add('active');
  });
});

// --- History ---
function simplePushHistory(label) {
  const entry = { label, adj:{...simple.adj}, filters:[...simple.filters], transforms:{...simple.transforms}, activeCrop: simple.activeCrop ? {...simple.activeCrop} : null };
  simple.history = simple.history.slice(0, simple.historyIndex + 1);
  simple.history.push(entry);
  if (simple.history.length > 20) { simple.history.shift(); }
  else { simple.historyIndex++; }
  simple.historyIndex = simple.history.length - 1;
  simpleRenderHistory();
  $('undoBtn').disabled = simple.historyIndex <= 0;
}

function simpleRenderHistory() {
  const list = $('historyList'); list.innerHTML = '';
  if (!simple.history.length) { list.innerHTML = '<p class="no-history">Aucune modification</p>'; return; }
  [...simple.history].reverse().forEach((e, ri) => {
    const idx = simple.history.length - 1 - ri;
    const item = document.createElement('div');
    item.className = 'history-item' + (idx === simple.historyIndex ? ' current' : '');
    item.innerHTML = `<div class="history-dot"></div><span>${e.label}</span>`;
    item.addEventListener('click', () => simpleRestoreHistory(idx));
    list.appendChild(item);
  });
}

function simpleRestoreHistory(idx) {
  const e = simple.history[idx]; if (!e) return;
  simple.historyIndex = idx;
  Object.assign(simple.adj, e.adj);
  simple.filters = [...e.filters]; simple.transforms = {...e.transforms}; simple.activeCrop = e.activeCrop ? {...e.activeCrop} : null;
  Object.entries(simple.adj).forEach(([k,v]) => { const s=$('s_'+k); if(s) s.value=v; const val=$('v_'+k); if(val) val.textContent=v; });
  $$('.filter-btn:not(.lfilter-btn)').forEach(b => b.classList.toggle('active', simple.filters.includes(b.dataset.filter)));
  simpleUpdateActiveFilters(); simpleUpdateTransformState(); simpleRenderHistory();
  simpleSchedule(100);
  $('undoBtn').disabled = simple.historyIndex <= 0;
}

$('undoBtn').addEventListener('click', () => { if (simple.historyIndex > 0) simpleRestoreHistory(simple.historyIndex - 1); });

// --- Download ---
$('simpleDownloadBtn').addEventListener('click', async () => {
  if (!simple.fileId) return;
  simpleShowProcessing(true);
  showToast('Préparation…', 'info');
  try {
    const res = await fetch('/api/download', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        file_id: simple.fileId, original_ext: simple.originalExt,
        adjustments: {...simple.adj}, filters: [...simple.filters],
        transforms: {...simple.transforms}, crop: simple.activeCrop,
        format: $('simpleExportFmt').value,
        quality: parseInt($('simpleQuality').value)
      })
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `edited.${$('simpleExportFmt').value}`; a.click();
    URL.revokeObjectURL(url);
    showToast('Téléchargé !', 'success');
  } catch(e) { showToast('Erreur téléchargement', 'error'); }
  finally { simpleShowProcessing(false); }
});

// --- Send to compose ---
$('sendToComposeBtn').addEventListener('click', async () => {
  if (!simple.fileId) return;
  setMode('compose');
  if (!compose.projectId) await composeNewProject(simple.width, simple.height);
  await composeAddImageLayer(simple.fileId, 'Image principale');
  showToast('Image ajoutée au mode Calques', 'success');
});

// ══════════════════════════════════════════════════════════════
// COMPOSE MODE (LAYERS)
// ══════════════════════════════════════════════════════════════

const compose = {
  projectId: null,
  layers: [],            // local layer metadata (no image_data)
  selectedLayerIds: [],  // multi-select
  activeLayerId: null,
  zoom: 1,
  canvasW: 1920, canvasH: 1080,
  debounce: null
};

// --- New project ---
async function composeNewProject(w, h) {
  const r = await fetch('/api/project/new', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ width: w || parseInt($('canvasW').value), height: h || parseInt($('canvasH').value) })
  });
  const d = await r.json();
  compose.projectId = d.project_id;
  compose.canvasW   = d.width;
  compose.canvasH   = d.height;
  compose.layers    = [];
  compose.activeLayerId = null;
  compose.selectedLayerIds = [];
  renderLayersList();
  $('exportCompBtn').disabled = false;
  $('flattenAllBtn').disabled = false;
  $('compImgDim').textContent = `${d.width} × ${d.height}`;
  $('composeInfoBar').style.display = 'flex';
}

$('newProjectBtn').addEventListener('click', async () => {
  await composeNewProject();
  $('composeEmptyState').style.display = 'none';
  $('composeWrapper').style.display    = 'inline-block';
  showToast(`Nouveau projet ${compose.canvasW}×${compose.canvasH}`, 'success');
});

$('startProjectBtn').addEventListener('click', () => $('newProjectBtn').click());

$('canvasW').addEventListener('change', () => {});
$('canvasH').addEventListener('change', () => {});

// --- Add layers ---
$('addImageInput').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  simpleShowProcessing(true);
  const fd = new FormData(); fd.append('file', f);
  try {
    const r = await fetch('/api/upload', {method:'POST', body:fd});
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    if (!compose.projectId) await composeNewProject(d.width, d.height);
    await composeAddImageLayer(d.file_id, f.name.replace(/\.[^.]+$/, ''));
  } catch(e) { showToast('Erreur : ' + e.message, 'error'); }
  finally { simpleShowProcessing(false); e.target.value = ''; }
});

async function composeAddImageLayer(fileId, name) {
  if (!compose.projectId) { showToast('Créez d\'abord un projet', 'info'); return; }
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layer/add`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type:'image', file_id: fileId, name: name || 'Image' })
    });
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    compose.canvasW = d.canvas_width; compose.canvasH = d.canvas_height;
    compose.layers.push(d.layer);
    composeSetPreview(d.preview);
    renderLayersList();
    setActiveLayer(d.layer.id);
    $('composeEmptyState').style.display = 'none';
    $('composeWrapper').style.display    = 'inline-block';
    showToast('Calque image ajouté', 'success');
  } catch(e) { showToast('Erreur : ' + e.message, 'error'); }
  finally { composeShowProcessing(false); }
}

$('addSolidBtn').addEventListener('click', async () => {
  if (!compose.projectId) await composeNewProject();
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layer/add`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type:'solid', color:'#3a3a5c', name:'Couleur unie' })
    });
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    compose.layers.push(d.layer);
    composeSetPreview(d.preview);
    renderLayersList();
    setActiveLayer(d.layer.id);
    $('composeEmptyState').style.display = 'none';
    $('composeWrapper').style.display    = 'inline-block';
    showToast('Calque couleur ajouté', 'success');
  } catch(e) { showToast('Erreur', 'error'); }
  finally { composeShowProcessing(false); }
});

$('addGradientBtn').addEventListener('click', async () => {
  if (!compose.projectId) await composeNewProject();
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layer/add`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type:'gradient', color1:'#1a1a2e', color2:'#e8c547', angle:135, name:'Dégradé' })
    });
    const d = await r.json();
    compose.layers.push(d.layer);
    composeSetPreview(d.preview);
    renderLayersList();
    setActiveLayer(d.layer.id);
    $('composeEmptyState').style.display = 'none';
    $('composeWrapper').style.display    = 'inline-block';
    showToast('Calque dégradé ajouté', 'success');
  } catch(e) { showToast('Erreur', 'error'); }
  finally { composeShowProcessing(false); }
});

$('addTextBtn').addEventListener('click', async () => {
  if (!compose.projectId) await composeNewProject();
  const text = prompt('Texte :', 'Open Photo Editor');
  if (!text) return;
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layer/add`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type:'text', text, font_size:72, color:'#ffffff', x:80, y:80, name:`Texte: ${text.substring(0,12)}` })
    });
    const d = await r.json();
    compose.layers.push(d.layer);
    composeSetPreview(d.preview);
    renderLayersList();
    setActiveLayer(d.layer.id);
    $('composeEmptyState').style.display = 'none';
    $('composeWrapper').style.display    = 'inline-block';
    showToast('Calque texte ajouté', 'success');
  } catch(e) { showToast('Erreur', 'error'); }
  finally { composeShowProcessing(false); }
});

// --- Layer selection & properties ---
function setActiveLayer(id) {
  compose.activeLayerId = id;
  const layer = compose.layers.find(l => l.id === id);

  // Show panels
  $('layerAdjPanel').style.display  = id ? '' : 'none';
  $('layerPropsPanel').style.display = id ? '' : 'none';

  if (!layer) return;

  // Sync sliders to layer adjustments
  const adj = layer.adjustments || {};
  $$('.lslider').forEach(sl => {
    const p = sl.dataset.lparam;
    sl.value = adj[p] !== undefined ? adj[p] : (p.includes('brightness')||p.includes('contrast')||p.includes('saturation')||p.includes('sharpness') ? 100 : 0);
    const vEl = document.querySelector(`.lv_${p}`);
    if (vEl) vEl.textContent = sl.value;
  });

  // Sync filter buttons
  $$('.lfilter-btn').forEach(b => b.classList.toggle('active', (layer.filters||[]).includes(b.dataset.filter)));

  // Blend mode / opacity
  $('layerOpacity').value        = layer.opacity || 100;
  $('layerOpacityVal').textContent = layer.opacity || 100;
  $('layerBlendMode').value      = layer.blend_mode || 'normal';

  // Type-specific props
  $('solidColorRow').style.display  = layer.type === 'solid' ? '' : 'none';
  $('gradientRow').style.display    = layer.type === 'gradient' ? '' : 'none';
  $('textPropsRow').style.display   = layer.type === 'text' ? '' : 'none';

  if (layer.type === 'solid')    $('solidColorPicker').value = layer.color || '#3a3a5c';
  if (layer.type === 'gradient') {
    $('grad1Picker').value  = layer.color1 || '#1a1a2e';
    $('grad2Picker').value  = layer.color2 || '#e8c547';
    $('gradAngle').value    = layer.angle  || 135;
    $('gradAngleVal').textContent = (layer.angle || 135) + '°';
  }
  if (layer.type === 'text') {
    $('textContent').value         = layer.text || '';
    $('textSize').value            = layer.font_size || 72;
    $('textSizeVal').textContent   = layer.font_size || 72;
    $('textColorPicker').value     = layer.color || '#ffffff';
  }

  // Position
  $('layerX').value = layer.x || 0;
  $('layerY').value = layer.y || 0;
}

// --- Layer adj sliders (per layer) ---
$$('.lslider').forEach(sl => {
  sl.addEventListener('input', () => {
    const p = sl.dataset.lparam;
    const vEl = document.querySelector(`.lv_${p}`);
    if (vEl) vEl.textContent = sl.value;
    if (!compose.activeLayerId) return;
    const layer = compose.layers.find(l => l.id === compose.activeLayerId);
    if (layer) { if (!layer.adjustments) layer.adjustments = {}; layer.adjustments[p] = parseFloat(sl.value); }
    clearTimeout(compose.debounce);
    compose.debounce = setTimeout(() => layerUpdate(compose.activeLayerId, { adjustments: layer.adjustments }), 300);
  });
});

$('resetLayerAdjBtn').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  const def = { brightness:100,contrast:100,saturation:100,sharpness:100,exposure:0,highlights:0,shadows:0,temperature:0 };
  $$('.lslider').forEach(sl => {
    const p = sl.dataset.lparam; sl.value = def[p] !== undefined ? def[p] : 0;
    const vEl = document.querySelector(`.lv_${p}`); if (vEl) vEl.textContent = sl.value;
  });
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (layer) layer.adjustments = {...def};
  layerUpdate(compose.activeLayerId, { adjustments: {...def} });
});

// --- Layer filters ---
$$('.lfilter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!compose.activeLayerId) { showToast('Sélectionnez un calque', 'info'); return; }
    const f = btn.dataset.filter; btn.classList.toggle('active');
    const layer = compose.layers.find(l => l.id === compose.activeLayerId);
    if (!layer.filters) layer.filters = [];
    if (btn.classList.contains('active')) layer.filters.push(f);
    else layer.filters = layer.filters.filter(x => x !== f);
    layerUpdate(compose.activeLayerId, { filters: layer.filters });
  });
});

$('clearLayerFiltersBtn').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  $$('.lfilter-btn').forEach(b => b.classList.remove('active'));
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (layer) layer.filters = [];
  layerUpdate(compose.activeLayerId, { filters: [] });
});

// --- Layer transforms ---
$('lRotL').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  layer.transforms.rotation = (layer.transforms.rotation - 90 + 360) % 360;
  layerUpdate(compose.activeLayerId, { transforms: layer.transforms });
});
$('lRotR').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  layer.transforms.rotation = (layer.transforms.rotation + 90) % 360;
  layerUpdate(compose.activeLayerId, { transforms: layer.transforms });
});
$('lFlipH').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  layer.transforms.flip_horizontal = !layer.transforms.flip_horizontal;
  layerUpdate(compose.activeLayerId, { transforms: layer.transforms });
});
$('lFlipV').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (!layer.transforms) layer.transforms = {rotation:0,flip_horizontal:false,flip_vertical:false};
  layer.transforms.flip_vertical = !layer.transforms.flip_vertical;
  layerUpdate(compose.activeLayerId, { transforms: layer.transforms });
});

$('applyPosBtn').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  layerUpdate(compose.activeLayerId, { x: parseInt($('layerX').value)||0, y: parseInt($('layerY').value)||0 });
});

// --- Opacity / blend mode ---
$('layerOpacity').addEventListener('input', e => {
  $('layerOpacityVal').textContent = e.target.value;
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (layer) layer.opacity = parseInt(e.target.value);
  clearTimeout(compose.debounce);
  compose.debounce = setTimeout(() => layerUpdate(compose.activeLayerId, { opacity: parseInt(e.target.value) }), 200);
});

$('layerBlendMode').addEventListener('change', e => {
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (layer) layer.blend_mode = e.target.value;
  layerUpdate(compose.activeLayerId, { blend_mode: e.target.value });
});

$('gradAngle').addEventListener('input', e => { $('gradAngleVal').textContent = e.target.value + '°'; });
$('textSize').addEventListener('input',  e => { $('textSizeVal').textContent = e.target.value; });

// --- Apply layer props ---
$('applyLayerPropsBtn').addEventListener('click', () => {
  if (!compose.activeLayerId) return;
  const layer = compose.layers.find(l => l.id === compose.activeLayerId);
  if (!layer) return;
  const upd = {};
  if (layer.type === 'solid')    { upd.color = $('solidColorPicker').value; }
  if (layer.type === 'gradient') { upd.color1 = $('grad1Picker').value; upd.color2 = $('grad2Picker').value; upd.angle = parseInt($('gradAngle').value); }
  if (layer.type === 'text')     { upd.text = $('textContent').value; upd.font_size = parseInt($('textSize').value); upd.color = $('textColorPicker').value; }
  Object.assign(layer, upd);
  layerUpdate(compose.activeLayerId, upd);
});

// --- Core layer update call ---
async function layerUpdate(layerId, data) {
  if (!compose.projectId || !layerId) return;
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layer/${layerId}/update`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    const d = await r.json();
    if (d.success) {
      const idx = compose.layers.findIndex(l => l.id === layerId);
      if (idx >= 0) Object.assign(compose.layers[idx], d.layer);
      composeSetPreview(d.preview);
      renderLayersList();
    }
  } catch(e) { showToast('Erreur mise à jour', 'error'); }
  finally { composeShowProcessing(false); }
}

// --- Render layers list ---
function renderLayersList() {
  const list = $('layersList'); list.innerHTML = '';
  $('layerCountBadge').textContent = compose.layers.length;

  if (!compose.layers.length) {
    list.innerHTML = '<p class="no-history">Aucun calque</p>';
    $('mergeSelectedBtn').disabled = true;
    return;
  }

  // Render top-to-bottom (reversed from server order)
  [...compose.layers].reverse().forEach(layer => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === compose.activeLayerId ? ' selected' : '');
    item.dataset.id = layer.id;

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    if (layer.type === 'solid') {
      const fill = document.createElement('div');
      fill.className = 'layer-thumb-solid';
      fill.style.background = layer.color || '#333';
      thumb.appendChild(fill);
    } else if (layer.type === 'gradient') {
      const fill = document.createElement('div');
      fill.className = 'layer-thumb-solid';
      fill.style.background = `linear-gradient(${layer.angle||135}deg, ${layer.color1||'#000'}, ${layer.color2||'#fff'})`;
      thumb.appendChild(fill);
    } else if (layer.type === 'text') {
      const t = document.createElement('span');
      t.style.cssText = 'font-size:9px;color:#aaa;font-family:serif;padding:2px';
      t.textContent = 'T';
      thumb.appendChild(t);
    } else {
      const icon = document.createElement('span');
      icon.style.cssText = 'font-size:9px;color:var(--text-3)';
      icon.textContent = '🖼';
      thumb.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'layer-info';
    info.innerHTML = `<div class="layer-name">${layer.name||'Calque'}</div>
      <div class="layer-meta">${layer.blend_mode||'normal'} · ${layer.opacity||100}%</div>`;

    const acts = document.createElement('div');
    acts.className = 'layer-actions';

    // Visibility
    const visBtn = document.createElement('button');
    visBtn.className = 'layer-action-btn layer-vis-btn' + (layer.visible === false ? ' hidden' : '');
    visBtn.title = 'Visibilité';
    visBtn.textContent = layer.visible === false ? '○' : '●';
    visBtn.addEventListener('click', async e => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      await layerUpdate(layer.id, { visible: layer.visible });
    });

    // Duplicate
    const dupBtn = document.createElement('button');
    dupBtn.className = 'layer-action-btn';
    dupBtn.title = 'Dupliquer';
    dupBtn.textContent = '⧉';
    dupBtn.addEventListener('click', async e => {
      e.stopPropagation();
      composeShowProcessing(true);
      try {
        const r = await fetch(`/api/project/${compose.projectId}/layer/${layer.id}/duplicate`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
        const d = await r.json();
        if (d.success) {
          const idx = compose.layers.findIndex(l => l.id === layer.id);
          compose.layers.splice(idx+1, 0, d.layer);
          composeSetPreview(d.preview);
          renderLayersList();
          setActiveLayer(d.layer.id);
          showToast('Calque dupliqué', 'success');
        }
      } catch(e) { showToast('Erreur', 'error'); }
      finally { composeShowProcessing(false); }
    });

    // Delete
    const delBtn = document.createElement('button');
    delBtn.className = 'layer-action-btn danger';
    delBtn.title = 'Supprimer';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Supprimer "${layer.name}" ?`)) return;
      composeShowProcessing(true);
      try {
        const r = await fetch(`/api/project/${compose.projectId}/layer/${layer.id}/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
        const d = await r.json();
        if (d.success) {
          compose.layers = compose.layers.filter(l => l.id !== layer.id);
          if (compose.activeLayerId === layer.id) { compose.activeLayerId = null; setActiveLayer(null); }
          composeSetPreview(d.preview);
          renderLayersList();
          showToast('Calque supprimé', 'info');
        }
      } catch(e) { showToast('Erreur', 'error'); }
      finally { composeShowProcessing(false); }
    });

    // Move up
    const upBtn = document.createElement('button');
    upBtn.className = 'layer-action-btn';
    upBtn.title = 'Monter'; upBtn.textContent = '↑';
    upBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const idx = compose.layers.findIndex(l => l.id === layer.id);
      if (idx < compose.layers.length - 1) {
        [compose.layers[idx], compose.layers[idx+1]] = [compose.layers[idx+1], compose.layers[idx]];
        await reorderLayers();
      }
    });

    // Move down
    const downBtn = document.createElement('button');
    downBtn.className = 'layer-action-btn';
    downBtn.title = 'Descendre'; downBtn.textContent = '↓';
    downBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const idx = compose.layers.findIndex(l => l.id === layer.id);
      if (idx > 0) {
        [compose.layers[idx], compose.layers[idx-1]] = [compose.layers[idx-1], compose.layers[idx]];
        await reorderLayers();
      }
    });

    acts.append(visBtn, upBtn, downBtn, dupBtn, delBtn);
    item.append(thumb, info, acts);
    item.addEventListener('click', () => { setActiveLayer(layer.id); renderLayersList(); });
    list.appendChild(item);
  });

  $('mergeSelectedBtn').disabled = compose.layers.length < 2;
  $('compLayerCount').textContent = `${compose.layers.length} calque(s)`;
}

async function reorderLayers() {
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layers/reorder`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ order: compose.layers.map(l => l.id) })
    });
    const d = await r.json();
    if (d.success) { composeSetPreview(d.preview); renderLayersList(); }
  } catch(e) { showToast('Erreur réordonnancement', 'error'); }
  finally { composeShowProcessing(false); }
}

// --- Merge ---
$('mergeSelectedBtn').addEventListener('click', async () => {
  if (compose.layers.length < 2) { showToast('Il faut au moins 2 calques', 'info'); return; }
  if (!confirm('Fusionner tous les calques visibles ?')) return;
  const ids = compose.layers.filter(l => l.visible !== false).map(l => l.id);
  if (ids.length < 2) { showToast('Il faut au moins 2 calques visibles', 'info'); return; }
  composeShowProcessing(true);
  try {
    const r = await fetch(`/api/project/${compose.projectId}/layers/merge`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ layer_ids: ids })
    });
    const d = await r.json();
    if (d.success) {
      compose.layers = [d.layer];
      composeSetPreview(d.preview);
      renderLayersList();
      setActiveLayer(d.layer.id);
      showToast('Calques fusionnés', 'success');
    }
  } catch(e) { showToast('Erreur fusion', 'error'); }
  finally { composeShowProcessing(false); }
});

$('flattenAllBtn').addEventListener('click', () => $('mergeSelectedBtn').click());

// --- Export ---
$('exportCompBtn').addEventListener('click', async () => {
  if (!compose.projectId) return;
  composeShowProcessing(true); showToast('Export en cours…', 'info');
  try {
    const res = await fetch(`/api/project/${compose.projectId}/export`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ format: $('compExportFmt').value, quality: parseInt($('compQuality').value) })
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`composition.${$('compExportFmt').value}`; a.click();
    URL.revokeObjectURL(url);
    showToast('Composition exportée !', 'success');
  } catch(e) { showToast('Erreur export', 'error'); }
  finally { composeShowProcessing(false); }
});

$('compQuality').addEventListener('input', e => { $('compQualVal').textContent = e.target.value; });

// --- Compose zoom ---
$('czoomIn').addEventListener('click',  () => { compose.zoom = Math.min(compose.zoom*1.25, 5); composeUpdateZoom(); });
$('czoomOut').addEventListener('click', () => { compose.zoom = Math.max(compose.zoom*.8,  .1); composeUpdateZoom(); });
$('czoomFit').addEventListener('click', composeFitZoom);

function composeFitZoom() {
  if (!compose.projectId) return;
  const a = $('composeCanvas').getBoundingClientRect();
  compose.zoom = Math.min((a.width-60)/compose.canvasW, (a.height-80)/compose.canvasH, 1);
  composeUpdateZoom();
}
function composeUpdateZoom() {
  $('czoomLevel').textContent = Math.round(compose.zoom*100) + '%';
  $('composeWrapper').style.transform = `scale(${compose.zoom})`;
}

$('composeCanvas').addEventListener('wheel', e => {
  if (!compose.projectId) return;
  e.preventDefault();
  compose.zoom = Math.max(.1, Math.min(compose.zoom * (e.deltaY>0 ? .9 : 1.1), 5));
  composeUpdateZoom();
}, { passive:false });

$('composeCanvas').addEventListener('dragover',  e => { e.preventDefault(); $('composeCanvas').classList.add('drag-over'); });
$('composeCanvas').addEventListener('dragleave', () => $('composeCanvas').classList.remove('drag-over'));
$('composeCanvas').addEventListener('drop', async e => {
  e.preventDefault(); $('composeCanvas').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!compose.projectId) await composeNewProject();
  const fd = new FormData(); fd.append('file', f);
  composeShowProcessing(true);
  try {
    const r = await fetch('/api/upload', {method:'POST',body:fd});
    const d = await r.json(); if (!d.success) throw new Error(d.error);
    await composeAddImageLayer(d.file_id, f.name.replace(/\.[^.]+$/, ''));
  } catch(e) { showToast('Erreur', 'error'); }
  finally { composeShowProcessing(false); }
});

function composeShowProcessing(v) {
  $('composeProcessing').style.display = v ? 'flex' : 'none';
}

function composeSetPreview(src) {
  $('composeImage').src = src;
  $('compImgDim').textContent = `${compose.canvasW} × ${compose.canvasH}`;
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); if (currentMode === 'simple') $('undoBtn').click(); }
    if (e.key === 's') { e.preventDefault(); if (currentMode === 'simple') $('simpleDownloadBtn').click(); else $('exportCompBtn').click(); }
    if (e.key === 'o') { e.preventDefault(); if (currentMode === 'simple') $('fileInputSimple').click(); else $('addImageInput').click(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); if (currentMode === 'simple') $('zoomIn').click(); else $('czoomIn').click(); }
    if (e.key === '-') { e.preventDefault(); if (currentMode === 'simple') $('zoomOut').click(); else $('czoomOut').click(); }
    if (e.key === '0') { e.preventDefault(); if (currentMode === 'simple') simpleFitZoom(); else composeFitZoom(); }
  }
  if (e.key === 'Escape') {
    simpleCancelCrop();
    $('modalOverlay').style.display = 'none';
  }
  if (e.key === 'Delete' && currentMode === 'compose' && compose.activeLayerId) {
    if (document.activeElement === document.body) {
      $('layersList').querySelector(`[data-id="${compose.activeLayerId}"] .danger`)?.click();
    }
  }
});

// Modal utility
function showModal(title, bodyHTML, onConfirm) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  $('modalOverlay').style.display = 'flex';
  $('modalConfirm').onclick = () => { onConfirm(); $('modalOverlay').style.display = 'none'; };
  $('modalCancel').onclick  = () => { $('modalOverlay').style.display = 'none'; };
}

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

simpleUpdateTransformState();
simpleUpdateActiveFilters();
console.log('%cOpen Photo Editor v2.0', 'color:#e8c547;font-family:monospace;font-size:14px;font-weight:bold');
console.log('%cCalques + Retouche · Open Source · Local-first', 'color:#666678;font-family:monospace');
