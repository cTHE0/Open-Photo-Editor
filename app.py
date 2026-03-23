"""
Open Photo Editor — Flask Application
Open Source photo editor with layer-based compositing.
All processing is local — no third-party services.
"""

import os
import uuid
import copy
import numpy as np
from flask import Flask, render_template, request, jsonify, send_file
from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageDraw, ImageFont
import io
import base64

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024  # 64MB max
app.config['UPLOAD_FOLDER'] = 'uploads'

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif'}

# In-memory project store  { project_id: project_dict }
PROJECTS = {}

# ══════════════════════════════════════════════════════════════
# IMAGE UTILITIES
# ══════════════════════════════════════════════════════════════

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def image_to_base64(img, fmt='PNG', quality=90):
    buf = io.BytesIO()
    if fmt == 'JPEG' and img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGB')
    kw = {'format': fmt}
    if fmt in ('JPEG', 'WEBP'):
        kw['quality'] = quality
    img.save(buf, **kw)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('utf-8')

def base64_to_image(b64str):
    if b64str.startswith('data:'):
        b64str = b64str.split(',', 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64str))).convert('RGBA')

# ── Per-layer processing ──────────────────────────────────────

def apply_adjustments(img, adj):
    alpha = img.split()[3] if img.mode == 'RGBA' else None
    rgb = img.convert('RGB')

    v = adj.get('brightness', 100) / 100.0
    if v != 1.0: rgb = ImageEnhance.Brightness(rgb).enhance(v)

    v = adj.get('contrast', 100) / 100.0
    if v != 1.0: rgb = ImageEnhance.Contrast(rgb).enhance(v)

    v = adj.get('saturation', 100) / 100.0
    if v != 1.0: rgb = ImageEnhance.Color(rgb).enhance(v)

    v = adj.get('sharpness', 100) / 100.0
    if v != 1.0: rgb = ImageEnhance.Sharpness(rgb).enhance(v)

    exposure = adj.get('exposure', 0)
    if exposure != 0:
        arr = np.array(rgb, np.float32)
        arr = np.clip(arr * 2 ** (exposure / 100.0), 0, 255).astype(np.uint8)
        rgb = Image.fromarray(arr)

    hl = adj.get('highlights', 0)
    sh = adj.get('shadows', 0)
    if hl != 0 or sh != 0:
        arr = np.array(rgb, np.float32)
        lum = 0.299*arr[:,:,0] + 0.587*arr[:,:,1] + 0.114*arr[:,:,2]
        if hl != 0:
            hl_factor = hl * (lum/255.0)**2
            arr[:,:,0] += hl_factor
            arr[:,:,1] += hl_factor
            arr[:,:,2] += hl_factor
        if sh != 0:
            sh_factor = sh * (1-lum/255.0)**2
            arr[:,:,0] += sh_factor
            arr[:,:,1] += sh_factor
            arr[:,:,2] += sh_factor
        rgb = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    temp = adj.get('temperature', 0)
    if temp != 0:
        arr = np.array(rgb, np.float32)
        arr[:,:,0] = np.clip(arr[:,:,0] + temp, 0, 255)
        arr[:,:,2] = np.clip(arr[:,:,2] - temp, 0, 255)
        rgb = Image.fromarray(arr.astype(np.uint8))

    result = rgb.convert('RGBA')
    if alpha:
        result.putalpha(alpha)
    return result

def apply_filters(img, filters):
    if not filters:
        return img
    alpha = img.split()[3] if img.mode == 'RGBA' else None
    rgb = img.convert('RGB')

    for f in filters:
        if f == 'grayscale':
            rgb = ImageOps.grayscale(rgb).convert('RGB')
        elif f == 'sepia':
            arr = np.array(rgb, np.float32)
            sepia = np.stack([
                arr[:,:,0]*0.393+arr[:,:,1]*0.769+arr[:,:,2]*0.189,
                arr[:,:,0]*0.349+arr[:,:,1]*0.686+arr[:,:,2]*0.168,
                arr[:,:,0]*0.272+arr[:,:,1]*0.534+arr[:,:,2]*0.131
            ], axis=2)
            rgb = Image.fromarray(np.clip(sepia,0,255).astype(np.uint8))
        elif f == 'blur':
            rgb = rgb.filter(ImageFilter.GaussianBlur(radius=2))
        elif f == 'sharpen':
            rgb = rgb.filter(ImageFilter.SHARPEN)
        elif f == 'edge_enhance':
            rgb = rgb.filter(ImageFilter.EDGE_ENHANCE)
        elif f == 'emboss':
            rgb = rgb.filter(ImageFilter.EMBOSS)
        elif f == 'invert':
            rgb = ImageOps.invert(rgb)
        elif f == 'auto_contrast':
            rgb = ImageOps.autocontrast(rgb)
        elif f == 'equalize':
            rgb = ImageOps.equalize(rgb)
        elif f == 'vignette':
            arr = np.array(rgb, np.float32)
            h, w = arr.shape[:2]
            Y, X = np.ogrid[:h, :w]
            dist = np.sqrt(((X-w/2)/(w/2))**2 + ((Y-h/2)/(h/2))**2)
            mask = np.clip(1.0-dist*0.65, 0, 1)
            rgb = Image.fromarray(np.clip(arr*mask[:,:,np.newaxis],0,255).astype(np.uint8))
        elif f == 'noise':
            arr = np.array(rgb, np.float32)
            rgb = Image.fromarray(np.clip(arr+np.random.normal(0,18,arr.shape),0,255).astype(np.uint8))

    result = rgb.convert('RGBA')
    if alpha:
        result.putalpha(alpha)
    return result

def apply_transforms(img, transforms):
    if transforms.get('flip_horizontal'):
        img = ImageOps.mirror(img)
    if transforms.get('flip_vertical'):
        img = ImageOps.flip(img)
    rot = transforms.get('rotation', 0)
    if rot:
        img = img.rotate(-rot, expand=True, resample=Image.BICUBIC)
    return img

def apply_crop(img, crop):
    if not crop:
        return img
    x, y = int(crop.get('x',0)), int(crop.get('y',0))
    w, h = int(crop.get('width',img.width)), int(crop.get('height',img.height))
    return img.crop((x, y, x+w, y+h))

# ── Blend modes ───────────────────────────────────────────────

def blend_mode(base, over, mode):
    """Float32 [0-1] arrays, returns blended float32 [0-1]."""
    b, a = base, over
    if mode == 'normal':    return a
    if mode == 'multiply':  return b * a
    if mode == 'screen':    return 1-(1-b)*(1-a)
    if mode == 'overlay':   return np.where(b<.5, 2*b*a, 1-2*(1-b)*(1-a))
    if mode == 'soft_light':
        return np.where(a<=.5,
            b-(1-2*a)*b*(1-b),
            b+(2*a-1)*(np.where(b<=.25,((16*b-12)*b+4)*b,np.sqrt(np.clip(b,0,1)))-b))
    if mode == 'hard_light': return np.where(a<.5, 2*b*a, 1-2*(1-b)*(1-a))
    if mode == 'difference': return np.abs(b-a)
    if mode == 'exclusion':  return b+a-2*b*a
    if mode == 'darken':     return np.minimum(b, a)
    if mode == 'lighten':    return np.maximum(b, a)
    if mode == 'color_dodge':
        result = np.clip(b / np.clip(a, 1e-6, 1), 0, 1)
        return np.where(a >= 1, 1, result)
    if mode == 'color_burn':
        result = np.clip(1 - (1 - b) / np.clip(a, 1e-6, 1), 0, 1)
        return np.where(a <= 0, 0, result)
    if mode == 'luminosity':
        lum_b = (0.299*b[:,:,0]+0.587*b[:,:,1]+0.114*b[:,:,2])[:,:,np.newaxis]
        lum_a = (0.299*a[:,:,0]+0.587*a[:,:,1]+0.114*a[:,:,2])[:,:,np.newaxis]
        return np.clip(b + (lum_a-lum_b), 0, 1)
    return a

# ── Layer renderers ───────────────────────────────────────────

def render_layer_image(layer, canvas_w, canvas_h):
    b64 = layer.get('image_data', '')
    if not b64:
        return Image.new('RGBA', (canvas_w, canvas_h), (0,0,0,0))
    img = base64_to_image(b64)
    img = apply_crop(img, layer.get('crop'))
    img = apply_transforms(img, layer.get('transforms', {}))
    img = apply_adjustments(img, layer.get('adjustments', {}))
    img = apply_filters(img, layer.get('filters', []))
    return img

def render_layer_solid(layer, canvas_w, canvas_h):
    c = layer.get('color', '#3a3a5c')
    r, g, b = int(c[1:3],16), int(c[3:5],16), int(c[5:7],16)
    return Image.new('RGBA', (canvas_w, canvas_h), (r,g,b,255))

def render_layer_gradient(layer, canvas_w, canvas_h):
    import math
    c1, c2 = layer.get('color1','#1a1a2e'), layer.get('color2','#e94560')
    angle = layer.get('angle', 90)
    r1,g1,b1 = int(c1[1:3],16),int(c1[3:5],16),int(c1[5:7],16)
    r2,g2,b2 = int(c2[1:3],16),int(c2[3:5],16),int(c2[5:7],16)
    rad = math.radians(angle)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    denom = abs(cos_a)*canvas_w + abs(sin_a)*canvas_h + 1e-9
    y_idx, x_idx = np.mgrid[0:canvas_h, 0:canvas_w]
    t = np.clip((x_idx*cos_a + y_idx*sin_a) / denom, 0, 1)
    arr = np.zeros((canvas_h, canvas_w, 4), np.uint8)
    arr[:,:,0] = np.round(r1 + t*(r2-r1)).astype(np.uint8)
    arr[:,:,1] = np.round(g1 + t*(g2-g1)).astype(np.uint8)
    arr[:,:,2] = np.round(b1 + t*(b2-b1)).astype(np.uint8)
    arr[:,:,3] = 255
    return Image.fromarray(arr, 'RGBA')

def render_layer_text(layer, canvas_w, canvas_h):
    img = Image.new('RGBA', (canvas_w, canvas_h), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    text = layer.get('text', 'Texte')
    size = layer.get('font_size', 72)
    color = layer.get('color', '#ffffff')
    tx = layer.get('x', 50)
    ty = layer.get('y', 50)
    r,g,b = int(color[1:3],16),int(color[3:5],16),int(color[5:7],16)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', size)
    except Exception:
        try:
            font = ImageFont.truetype('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', size)
        except Exception:
            font = ImageFont.load_default()
    draw.text((tx, ty), text, font=font, fill=(r,g,b,255))
    return img

# ── Compositing engine ────────────────────────────────────────

def composite_layers(project, scale=1.0):
    cw = max(1, int(project['canvas_width'] * scale))
    ch = max(1, int(project['canvas_height'] * scale))
    base = np.zeros((ch, cw, 4), np.float32)

    for layer in project.get('layers', []):
        if not layer.get('visible', True):
            continue

        ltype = layer.get('type', 'image')
        opacity = layer.get('opacity', 100) / 100.0
        bmode   = layer.get('blend_mode', 'normal')

        pw = project['canvas_width']
        ph = project['canvas_height']

        if   ltype == 'image':    limg = render_layer_image(layer, pw, ph)
        elif ltype == 'solid':    limg = render_layer_solid(layer, pw, ph)
        elif ltype == 'gradient': limg = render_layer_gradient(layer, pw, ph)
        elif ltype == 'text':     limg = render_layer_text(layer, pw, ph)
        else: continue

        # Display size override (from mouse resize)
        display_w = layer.get('display_w')
        display_h = layer.get('display_h')
        if display_w is not None and display_h is not None:
            if display_w != limg.width or display_h != limg.height:
                limg = limg.resize((max(1, int(display_w)), max(1, int(display_h))), Image.LANCZOS)

        # Display rotation override (from mouse rotate)
        display_rotation = layer.get('display_rotation', 0)
        if display_rotation:
            limg = limg.rotate(-display_rotation, expand=True, resample=Image.BICUBIC)

        # Position & scale
        lx = int(layer.get('x', 0) * scale)
        ly = int(layer.get('y', 0) * scale)

        if scale != 1.0:
            lw = max(1, int(limg.width * scale))
            lh = max(1, int(limg.height * scale))
            limg = limg.resize((lw, lh), Image.LANCZOS)

        # Paste onto full-canvas transparent image
        paste = Image.new('RGBA', (cw, ch), (0,0,0,0))
        paste.paste(limg, (lx, ly))

        arr = np.array(paste, np.float32) / 255.0
        l_rgb   = arr[:,:,:3]
        l_alpha = arr[:,:,3:4] * opacity

        b_rgb   = base[:,:,:3]
        b_alpha = base[:,:,3:4]

        blended = blend_mode(b_rgb, l_rgb, bmode)
        out_alpha = l_alpha + b_alpha * (1 - l_alpha)
        safe = np.where(out_alpha > 0, out_alpha, 1.0)
        out_rgb = (blended*l_alpha + b_rgb*b_alpha*(1-l_alpha)) / safe

        base[:,:,:3] = np.clip(out_rgb, 0, 1)
        base[:,:,3:4] = np.clip(out_alpha, 0, 1)

    return Image.fromarray((base*255).astype(np.uint8), 'RGBA')

def get_scale(project):
    m = max(project['canvas_width'], project['canvas_height'])
    return min(1.0, 2048 / m)

def sanitize_layer(l):
    """Strip heavy image_data from layer dict for JSON responses."""
    d = {k: v for k, v in l.items() if k != 'image_data'}
    d['has_image'] = bool(l.get('image_data'))
    return d

# ══════════════════════════════════════════════════════════════
# ROUTES
# ══════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return render_template('index.html')

# ── Upload ────────────────────────────────────────────────────
@app.route('/api/upload', methods=['POST'])
def upload_image():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['file']
    if not file.filename or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file'}), 400

    file_id = str(uuid.uuid4())
    img = Image.open(file.stream).convert('RGBA')
    w, h = img.size
    
    # Reset stream position for saving
    file.stream.seek(0)
    
    path = os.path.join(app.config['UPLOAD_FOLDER'], f"{file_id}.png")
    img.save(path, 'PNG')

    preview = img.copy()
    if max(preview.size) > 2048:
        preview.thumbnail((2048, 2048), Image.LANCZOS)

    return jsonify({
        'success': True,
        'file_id': file_id,
        'width': w,
        'height': h,
        'preview': f"data:image/png;base64,{image_to_base64(preview,'PNG')}"
    })

# ── Create project ────────────────────────────────────────────
@app.route('/api/project/new', methods=['POST'])
def new_project():
    data = request.get_json() or {}
    project_id = str(uuid.uuid4())
    PROJECTS[project_id] = {
        'canvas_width':  data.get('width', 1920),
        'canvas_height': data.get('height', 1080),
        'layers': []
    }
    return jsonify({'success': True, 'project_id': project_id,
                    'width': PROJECTS[project_id]['canvas_width'],
                    'height': PROJECTS[project_id]['canvas_height']})

# ── Add layer ─────────────────────────────────────────────────
@app.route('/api/project/<pid>/layer/add', methods=['POST'])
def add_layer(pid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    data    = request.get_json() or {}
    ltype   = data.get('type', 'image')

    layer = {
        'id':         str(uuid.uuid4())[:8],
        'type':       ltype,
        'name':       data.get('name', f'Calque {len(project["layers"])+1}'),
        'visible':    True,
        'opacity':    data.get('opacity', 100),
        'blend_mode': data.get('blend_mode', 'normal'),
        'x':          data.get('x', 0),
        'y':          data.get('y', 0),
        'adjustments': {'brightness':100,'contrast':100,'saturation':100,
                        'sharpness':100,'exposure':0,'highlights':0,
                        'shadows':0,'temperature':0},
        'filters':    [],
        'transforms': {'rotation':0,'flip_horizontal':False,'flip_vertical':False},
        'crop':       None,
    }

    if ltype == 'image':
        fid = data.get('file_id')
        if fid:
            p = os.path.join(app.config['UPLOAD_FOLDER'], f"{fid}.png")
            if os.path.exists(p):
                img = Image.open(p).convert('RGBA')
                layer['image_data'] = f"data:image/png;base64,{image_to_base64(img,'PNG')}"
                layer['orig_width']  = img.width
                layer['orig_height'] = img.height
                if not project['layers']:
                    project['canvas_width']  = img.width
                    project['canvas_height'] = img.height
        elif not layer.get('image_data'):
            layer['image_data'] = data.get('image_data', '')
            # If image_data provided directly, extract dimensions from it
            if layer['image_data']:
                try:
                    img = base64_to_image(layer['image_data'])
                    layer['orig_width'] = img.width
                    layer['orig_height'] = img.height
                except Exception:
                    pass

    elif ltype == 'solid':
        layer['color'] = data.get('color', '#3a3a5c')

    elif ltype == 'gradient':
        layer['color1'] = data.get('color1', '#1a1a2e')
        layer['color2'] = data.get('color2', '#e8c547')
        layer['angle']  = data.get('angle', 135)

    elif ltype == 'text':
        layer['text']      = data.get('text', 'Votre texte')
        layer['font_size'] = data.get('font_size', 72)
        layer['color']     = data.get('color', '#ffffff')
        layer['x']         = data.get('x', 80)
        layer['y']         = data.get('y', 80)

    project['layers'].append(layer)

    comp = composite_layers(project, get_scale(project))
    return jsonify({
        'success': True,
        'layer': sanitize_layer(layer),
        'preview': f"data:image/png;base64,{image_to_base64(comp,'PNG')}",
        'canvas_width':  project['canvas_width'],
        'canvas_height': project['canvas_height']
    })

# ── Update layer ──────────────────────────────────────────────
@app.route('/api/project/<pid>/layer/<lid>/update', methods=['POST'])
def update_layer(pid, lid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    layer   = next((l for l in project['layers'] if l['id']==lid), None)
    if not layer: return jsonify({'error': 'Layer not found'}), 404

    data = request.get_json() or {}
    for field in ['visible','opacity','blend_mode','name','x','y',
                  'display_w','display_h','display_rotation',
                  'adjustments','filters','transforms','crop',
                  'color','color1','color2','angle','text','font_size']:
        if field in data:
            layer[field] = data[field]

    comp = composite_layers(project, get_scale(project))
    return jsonify({
        'success': True,
        'layer': sanitize_layer(layer),
        'preview': f"data:image/png;base64,{image_to_base64(comp,'PNG')}"
    })

# ── Delete layer ──────────────────────────────────────────────
@app.route('/api/project/<pid>/layer/<lid>/delete', methods=['POST'])
def delete_layer(pid, lid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    project['layers'] = [l for l in project['layers'] if l['id'] != lid]
    comp = composite_layers(project, get_scale(project))
    return jsonify({'success': True,
                    'preview': f"data:image/png;base64,{image_to_base64(comp,'PNG')}"})

# ── Reorder ───────────────────────────────────────────────────
@app.route('/api/project/<pid>/layers/reorder', methods=['POST'])
def reorder_layers(pid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    order   = request.get_json().get('order', [])
    lmap    = {l['id']: l for l in project['layers']}
    project['layers'] = [lmap[i] for i in order if i in lmap]
    comp = composite_layers(project, get_scale(project))
    return jsonify({'success': True,
                    'preview': f"data:image/png;base64,{image_to_base64(comp,'PNG')}"})

# ── Duplicate ─────────────────────────────────────────────────
@app.route('/api/project/<pid>/layer/<lid>/duplicate', methods=['POST'])
def duplicate_layer(pid, lid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    layer   = next((l for l in project['layers'] if l['id']==lid), None)
    if not layer: return jsonify({'error': 'Layer not found'}), 404

    nl = copy.deepcopy(layer)
    nl['id']   = str(uuid.uuid4())[:8]
    nl['name'] = layer['name'] + ' (copie)'
    idx = project['layers'].index(layer)
    project['layers'].insert(idx+1, nl)

    comp = composite_layers(project, get_scale(project))
    return jsonify({
        'success': True,
        'layer': sanitize_layer(nl),
        'preview': f"data:image/png;base64,{image_to_base64(comp,'PNG')}"
    })

# ── Merge two layers ──────────────────────────────────────────
@app.route('/api/project/<pid>/layers/merge', methods=['POST'])
def merge_layers(pid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    data    = request.get_json() or {}
    ids     = data.get('layer_ids', [])
    if len(ids) < 2: return jsonify({'error': 'Need ≥2 layers'}), 400

    # Build a sub-project with only those layers
    sub = {
        'canvas_width':  project['canvas_width'],
        'canvas_height': project['canvas_height'],
        'layers': [l for l in project['layers'] if l['id'] in ids]
    }
    merged_img = composite_layers(sub, 1.0)
    b64 = image_to_base64(merged_img, 'PNG')

    # Replace layers with merged one
    first_idx = min(project['layers'].index(l) for l in project['layers'] if l['id'] in ids)
    project['layers'] = [l for l in project['layers'] if l['id'] not in ids]
    merged_layer = {
        'id':   str(uuid.uuid4())[:8],
        'type': 'image', 'name': 'Calque fusionné',
        'visible': True, 'opacity': 100, 'blend_mode': 'normal',
        'x': 0, 'y': 0,
        'adjustments': {'brightness':100,'contrast':100,'saturation':100,
                        'sharpness':100,'exposure':0,'highlights':0,'shadows':0,'temperature':0},
        'filters': [], 'transforms': {'rotation':0,'flip_horizontal':False,'flip_vertical':False},
        'crop': None,
        'image_data': f'data:image/png;base64,{b64}',
        'orig_width':  project['canvas_width'],
        'orig_height': project['canvas_height'],
    }
    project['layers'].insert(first_idx, merged_layer)

    comp = composite_layers(project, get_scale(project))
    return jsonify({
        'success': True,
        'layer': sanitize_layer(merged_layer),
        'preview': f"data:image/png;base64,{image_to_base64(comp,'PNG')}"
    })

# ── Export / flatten ──────────────────────────────────────────
@app.route('/api/project/<pid>/export', methods=['POST'])
def export_project(pid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    data    = request.get_json() or {}
    fmt     = data.get('format', 'jpeg').upper()
    quality = data.get('quality', 95)

    final = composite_layers(project, 1.0)
    if fmt == 'JPEG': final = final.convert('RGB')

    buf = io.BytesIO()
    kw = {'format': fmt}
    if fmt in ('JPEG','WEBP'): kw['quality'] = quality
    final.save(buf, **kw)
    buf.seek(0)

    mime = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}.get(fmt,'image/jpeg')
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f'composition.{fmt.lower()}')

# ── Single image quick process (simple mode) ──────────────────
@app.route('/api/process', methods=['POST'])
def process_image():
    data = request.get_json() or {}
    fid  = data.get('file_id')
    path = os.path.join(app.config['UPLOAD_FOLDER'], f"{fid}.png")
    if not os.path.exists(path):
        return jsonify({'error': 'File not found'}), 404

    img = Image.open(path).convert('RGBA')
    if data.get('crop'):    img = apply_crop(img, data['crop'])
    img = apply_transforms(img, data.get('transforms', {}))
    img = apply_adjustments(img, data.get('adjustments', {}))
    img = apply_filters(img, data.get('filters', []))

    preview = img.copy()
    if max(preview.size) > 2048:
        preview.thumbnail((2048, 2048), Image.LANCZOS)

    return jsonify({
        'success': True,
        'preview': f"data:image/png;base64,{image_to_base64(preview,'PNG')}",
        'width': img.width, 'height': img.height
    })

@app.route('/api/download', methods=['POST'])
def download_image():
    data = request.get_json() or {}
    fid  = data.get('file_id')
    path = os.path.join(app.config['UPLOAD_FOLDER'], f"{fid}.png")
    if not os.path.exists(path):
        return jsonify({'error': 'File not found'}), 404

    img = Image.open(path).convert('RGBA')
    if data.get('crop'):    img = apply_crop(img, data['crop'])
    img = apply_transforms(img, data.get('transforms', {}))
    img = apply_adjustments(img, data.get('adjustments', {}))
    img = apply_filters(img, data.get('filters', []))

    fmt = data.get('format', 'jpeg').upper()
    quality = data.get('quality', 95)
    if fmt == 'JPEG': img = img.convert('RGB')

    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=quality)
    buf.seek(0)

    mime = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}.get(fmt,'image/jpeg')
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f'edited.{fmt.lower()}')

if __name__ == '__main__':
    os.makedirs('uploads', exist_ok=True)
    app.run(debug=True, host='0.0.0.0', port=5000)
