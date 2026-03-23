"""
Open Photo Editor — Flask Application
Open Source photo editor with layer-based compositing.
All processing is local — no third-party services.
"""

import os
import uuid
import copy
import json
import numpy as np
from flask import Flask, render_template, request, jsonify, send_file
from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageDraw, ImageFont, ImageChops
import io
import base64

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024  # 64MB max
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
app.config['PROJECTS_FOLDER'] = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'projects')

# Ensure folders exist
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['PROJECTS_FOLDER'], exist_ok=True)

# In-memory project store with disk persistence
PROJECTS = {}
PROJECTS_FILE = os.path.join(app.config['PROJECTS_FOLDER'], 'projects.json')

def load_projects():
    """Load projects from disk."""
    global PROJECTS
    if os.path.exists(PROJECTS_FILE):
        try:
            with open(PROJECTS_FILE, 'r') as f:
                PROJECTS = json.load(f)
            print(f"Loaded {len(PROJECTS)} projects from disk")
        except Exception as e:
            print(f"Error loading projects: {e}")
            PROJECTS = {}
    else:
        PROJECTS = {}

def save_projects():
    """Save projects to disk."""
    try:
        os.makedirs(app.config['PROJECTS_FOLDER'], exist_ok=True)
        with open(PROJECTS_FILE, 'w') as f:
            json.dump(PROJECTS, f)
        print(f"Saved {len(PROJECTS)} projects to disk")
    except Exception as e:
        print(f"Error saving projects: {e}")
        # Keep projects in memory if disk save fails
        pass

# Load projects on startup
load_projects()

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif'}

# ══════════════════════════════════════════════════════════════
# IMAGE UTILITIES
# ══════════════════════════════════════════════════════════════

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def image_to_base64(img, fmt='PNG', quality=90):
    buf = io.BytesIO()
    # Convert incompatible modes for JPEG
    if fmt == 'JPEG':
        if img.mode in ('RGBA', 'LA', 'P', 'PA'):
            img = img.convert('RGB')
        elif img.mode in ('1', 'F', 'I'):
            img = img.convert('L').convert('RGB')
        elif img.mode == 'L':
            img = img.convert('RGB')
    elif fmt == 'WEBP' and img.mode == 'P':
        img = img.convert('RGBA')
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

def apply_layer_styles(img, styles):
    """Apply layer effects: drop shadow, stroke, glow, bevel."""
    if not styles:
        return img
    
    result = img.convert('RGBA')
    
    # Drop Shadow
    if styles.get('drop_shadow', {}).get('enabled'):
        ds = styles['drop_shadow']
        shadow_offset = ds.get('offset', 10)
        shadow_blur = ds.get('blur', 10)
        shadow_color = ds.get('color', '#000000')
        shadow_opacity = ds.get('opacity', 50) / 100.0
        
        # Parse shadow color
        if shadow_color.startswith('#'):
            sr, sg, sb = int(shadow_color[1:3], 16), int(shadow_color[3:5], 16), int(shadow_color[5:7], 16)
        else:
            sr, sg, sb = 0, 0, 0
        
        # Create shadow mask from alpha channel
        alpha = result.split()[3]
        shadow_mask = alpha.point(lambda x: int(x * shadow_opacity))
        shadow = Image.new('RGBA', result.size, (sr, sg, sb, 0))
        shadow.paste((sr, sg, sb, int(255 * shadow_opacity)), mask=shadow_mask)
        
        # Apply blur to shadow
        if shadow_blur > 0:
            shadow = shadow.filter(ImageFilter.GaussianBlur(radius=shadow_blur))
        
        # Offset shadow
        shadow_layer = Image.new('RGBA', result.size, (0, 0, 0, 0))
        shadow_layer.paste(shadow, (shadow_offset, shadow_offset))
        
        # Composite shadow below result
        result = Image.alpha_composite(shadow_layer, result)
    
    # Outer Glow
    if styles.get('outer_glow', {}).get('enabled'):
        glow = styles['outer_glow']
        glow_color = glow.get('color', '#ffffff')
        glow_size = glow.get('size', 10)
        glow_opacity = glow.get('opacity', 50) / 100.0
        glow_spread = glow.get('spread', 0) / 100.0
        
        if glow_color.startswith('#'):
            gr, gg, gb = int(glow_color[1:3], 16), int(glow_color[3:5], 16), int(glow_color[5:7], 16)
        else:
            gr, gg, gb = 255, 255, 255
        
        alpha = result.split()[3]
        glow_mask = alpha.point(lambda x: 255 - x)  # Invert alpha for outer glow
        
        if glow_spread > 0:
            glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(radius=glow_size * (1 - glow_spread)))
        else:
            glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(radius=glow_size))
        
        glow_layer = Image.new('RGBA', result.size, (gr, gg, gb, 0))
        glow_layer.putalpha(glow_mask.point(lambda x: int(x * glow_opacity)))
        result = Image.alpha_composite(glow_layer, result)
    
    # Inner Glow
    if styles.get('inner_glow', {}).get('enabled'):
        glow = styles['inner_glow']
        glow_color = glow.get('color', '#ffffff')
        glow_size = glow.get('size', 10)
        glow_opacity = glow.get('opacity', 50) / 100.0
        
        if glow_color.startswith('#'):
            gr, gg, gb = int(glow_color[1:3], 16), int(glow_color[3:5], 16), int(glow_color[5:7], 16)
        else:
            gr, gg, gb = 255, 255, 255
        
        # Create inner glow mask
        alpha = result.split()[3]
        alpha_blur = alpha.filter(ImageFilter.GaussianBlur(radius=glow_size))
        inner_mask = alpha.point(lambda x: 255 - x)
        inner_mask = ImageChops.subtract(inner_mask, alpha_blur)
        inner_mask = inner_mask.point(lambda x: max(0, min(255, int(x * glow_opacity))))
        
        glow_layer = Image.new('RGBA', result.size, (0, 0, 0, 0))
        glow_layer.paste((gr, gg, gb), mask=inner_mask)
        result = Image.alpha_composite(glow_layer, result)
    
    # Stroke
    if styles.get('stroke', {}).get('enabled'):
        stroke = styles['stroke']
        stroke_size = stroke.get('size', 3)
        stroke_color = stroke.get('color', '#000000')
        stroke_opacity = stroke.get('opacity', 100) / 100.0
        stroke_position = stroke.get('position', 'outside')  # outside, inside, center
        
        if stroke_color.startswith('#'):
            str_r, str_g, str_b = int(stroke_color[1:3], 16), int(stroke_color[3:5], 16), int(stroke_color[5:7], 16)
        else:
            str_r, str_g, str_b = 0, 0, 0
        
        alpha = result.split()[3]
        
        # Create stroke mask (edge detection)
        alpha_arr = np.array(alpha, dtype=np.float32) / 255.0
        
        # Dilate and erode for stroke
        from PIL import ImageFilter
        if stroke_position == 'outside':
            stroke_mask = alpha.filter(ImageFilter.MaxFilter(stroke_size * 2 + 1))
            stroke_mask = ImageChops.subtract(stroke_mask, alpha)
        elif stroke_position == 'inside':
            eroded = alpha.filter(ImageFilter.MinFilter(stroke_size * 2 + 1))
            stroke_mask = ImageChops.subtract(alpha, eroded)
        else:  # center
            dilated = alpha.filter(ImageFilter.MaxFilter(stroke_size + 1))
            eroded = alpha.filter(ImageFilter.MinFilter(stroke_size + 1))
            stroke_mask = ImageChops.subtract(dilated, eroded)
        
        stroke_mask = stroke_mask.point(lambda x: int(x * stroke_opacity))
        
        stroke_layer = Image.new('RGBA', result.size, (0, 0, 0, 0))
        stroke_layer.paste((str_r, str_g, str_b), mask=stroke_mask)
        
        # Composite stroke based on position
        if stroke_position == 'outside':
            result = Image.alpha_composite(stroke_layer, result)
        else:
            result = Image.alpha_composite(stroke_layer, result)
    
    # Bevel/Emboss
    if styles.get('bevel', {}).get('enabled'):
        bevel = styles['bevel']
        bevel_size = bevel.get('size', 5)
        bevel_opacity = bevel.get('opacity', 50) / 100.0
        bevel_angle = bevel.get('angle', 135)
        bevel_height = bevel.get('height', 5)
        
        # Convert to numpy for emboss calculation
        arr = np.array(result, dtype=np.float32)
        alpha = arr[:, :, 3] / 255.0
        
        # Create emboss kernel
        import math
        angle_rad = math.radians(bevel_angle)
        light_x = math.cos(angle_rad)
        light_y = math.sin(angle_rad)
        
        # Sobel filters for normal calculation
        sobel_x = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
        sobel_y = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float32)
        
        from scipy import ndimage
        try:
            gx = ndimage.convolve(alpha, sobel_x)
            gy = ndimage.convolve(alpha, sobel_y)
            
            # Calculate lighting
            dzdx = gx * bevel_height
            dzdy = gy * bevel_height
            
            # Normalize
            magnitude = np.sqrt(dzdx**2 + dzdy**2 + 1)
            nx = -dzdx / magnitude
            ny = -dzdy / magnitude
            nz = 1 / magnitude
            
            # Dot product with light direction
            lighting = nx * light_x + ny * light_y + nz * 0.5
            lighting = np.clip(lighting * bevel_opacity + (1 - bevel_opacity) * 0.5, 0, 1)
            
            # Apply lighting to RGB
            result_arr = arr.copy()
            result_arr[:, :, :3] *= lighting[:, :, np.newaxis]
            result = Image.fromarray(result_arr.astype(np.uint8))
        except ImportError:
            # Fallback: use PIL emboss filter
            emboss_filter = ImageFilter.EMBOSS
            embossed = result.filter(emboss_filter)
            result = Image.blend(result, embossed, bevel_opacity * 0.5)
    
    return result

def render_layer_image(layer, canvas_w, canvas_h):
    b64 = layer.get('image_data', '')
    if not b64:
        return Image.new('RGBA', (canvas_w, canvas_h), (0,0,0,0))
    img = base64_to_image(b64)
    img = apply_crop(img, layer.get('crop'))
    img = apply_transforms(img, layer.get('transforms', {}))
    img = apply_adjustments(img, layer.get('adjustments', {}))
    img = apply_filters(img, layer.get('filters', []))
    img = apply_layer_styles(img, layer.get('styles', {}))
    return img

def render_layer_solid(layer, canvas_w, canvas_h):
    c = layer.get('color', '#3a3a5c')
    r, g, b = int(c[1:3],16), int(c[3:5],16), int(c[5:7],16)
    img = Image.new('RGBA', (canvas_w, canvas_h), (r,g,b,255))
    img = apply_layer_styles(img, layer.get('styles', {}))
    return img

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
    img = Image.fromarray(arr, 'RGBA')
    img = apply_layer_styles(img, layer.get('styles', {}))
    return img

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
    img = apply_layer_styles(img, layer.get('styles', {}))
    return img

def render_layer_shape(layer, canvas_w, canvas_h):
    """Render shape layer (rectangle, ellipse)."""
    img = Image.new('RGBA', (canvas_w, canvas_h), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    
    shape_type = layer.get('shape', 'rectangle')
    color = layer.get('color', '#3a3a5c')
    x = layer.get('x', 50)
    y = layer.get('y', 50)
    w = layer.get('width', 200)
    h = layer.get('height', 150)
    
    r,g,b = int(color[1:3],16),int(color[3:5],16),int(color[5:7],16)
    
    if shape_type == 'rectangle':
        draw.rounded_rectangle([x, y, x+w, y+h], radius=10, fill=(r,g,b,255))
    elif shape_type == 'ellipse':
        draw.ellipse([x, y, x+w, y+h], fill=(r,g,b,255))
    
    img = apply_layer_styles(img, layer.get('styles', {}))
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
        elif ltype == 'shape':    limg = render_layer_shape(layer, pw, ph)
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
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file in request'}), 400
        file = request.files['file']
        if not file.filename:
            return jsonify({'error': 'No filename'}), 400
        
        filename = file.filename.lower()
        ext = filename.rsplit('.', 1)[1] if '.' in filename else ''
        if ext not in ALLOWED_EXTENSIONS:
            return jsonify({'error': f'Extension {ext} non supportée'}), 400

        file_id = str(uuid.uuid4())
        img = Image.open(file.stream).convert('RGBA')
        w, h = img.size

        # Reset stream position for saving
        file.stream.seek(0)

        # Ensure upload folder exists
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        
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
    except Exception as e:
        print(f"Upload error: {str(e)}")
        return jsonify({'error': f'Erreur: {str(e)}'}), 500

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
    print(f"Created project: {project_id}")
    save_projects()
    return jsonify({'success': True, 'project_id': project_id,
                    'width': PROJECTS[project_id]['canvas_width'],
                    'height': PROJECTS[project_id]['canvas_height']})

# ── Add layer ─────────────────────────────────────────────────
@app.route('/api/project/<pid>/layer/add', methods=['POST'])
def add_layer(pid):
    print(f"Add layer request - Project: {pid}")
    print(f"Available projects: {list(PROJECTS.keys())}")
    if pid not in PROJECTS:
        print(f"Project not found: {pid}")
        return jsonify({'error': 'Projet non trouvé'}), 404
    project = PROJECTS[pid]
    data    = request.get_json() or {}
    ltype   = data.get('type', 'image')
    print(f"Layer type: {ltype}, data: {data}")

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
        'styles':     {},
    }

    if ltype == 'image':
        fid = data.get('file_id')
        print(f"Image layer - file_id: {fid}")
        if fid:
            p = os.path.join(app.config['UPLOAD_FOLDER'], f"{fid}.png")
            print(f"Looking for file at: {p}")
            if os.path.exists(p):
                print(f"File found, loading...")
                img = Image.open(p).convert('RGBA')
                layer['image_data'] = f"data:image/png;base64,{image_to_base64(img,'PNG')}"
                layer['orig_width']  = img.width
                layer['orig_height'] = img.height
                if not project['layers']:
                    project['canvas_width']  = img.width
                    project['canvas_height'] = img.height
            else:
                print(f"File not found at: {p}")
        elif not layer.get('image_data'):
            layer['image_data'] = data.get('image_data', '')
            if layer['image_data']:
                try:
                    img = base64_to_image(layer['image_data'])
                    layer['orig_width'] = img.width
                    layer['orig_height'] = img.height
                except Exception as e:
                    print(f"Error loading image_data: {e}")

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
    elif ltype == 'shape':
        layer['shape']  = data.get('shape', 'rectangle')
        layer['color']  = data.get('color', '#3a3a5c')
        layer['x']      = data.get('x', 50)
        layer['y']      = data.get('y', 50)
        layer['width']  = data.get('width', 200)
        layer['height'] = data.get('height', 150)

    project['layers'].append(layer)
    print(f"Layer added, total layers: {len(project['layers'])}")
    save_projects()

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
                  'adjustments','filters','transforms','crop','styles',
                  'color','color1','color2','angle','text','font_size',
                  'shape','width','height']:
        if field in data:
            layer[field] = data[field]

    save_projects()
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
    save_projects()
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
    save_projects()
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
    save_projects()

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

    # Get layers to merge in their current order
    layers_to_merge = [l for l in project['layers'] if l['id'] in ids]
    if len(layers_to_merge) < 2:
        return jsonify({'error': 'Need ≥2 existing layers'}), 400

    # Build a sub-project with only those layers (preserving order)
    sub = {
        'canvas_width':  project['canvas_width'],
        'canvas_height': project['canvas_height'],
        'layers': layers_to_merge
    }
    merged_img = composite_layers(sub, 1.0)
    b64 = image_to_base64(merged_img, 'PNG')

    # Replace layers with merged one - insert at position of first merged layer
    first_idx = next(i for i, l in enumerate(project['layers']) if l['id'] in ids)
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
    save_projects()

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

# ── Save project (JSON with all layers) ───────────────────────
@app.route('/api/project/<pid>/save', methods=['POST'])
def save_project(pid):
    if pid not in PROJECTS: return jsonify({'error': 'Not found'}), 404
    project = PROJECTS[pid]
    
    # Create serializable project data
    project_data = {
        'version': '1.0',
        'canvas_width': project['canvas_width'],
        'canvas_height': project['canvas_height'],
        'layers': []
    }
    
    for layer in project.get('layers', []):
        layer_data = {k: v for k, v in layer.items() if k != 'image_data'}
        layer_data['has_image'] = bool(layer.get('image_data'))
        # Include image data for complete project save
        if layer.get('image_data'):
            layer_data['image_data'] = layer['image_data']
        project_data['layers'].append(layer_data)
    
    return jsonify({
        'success': True,
        'project': project_data,
        'filename': f'project_{pid}.json'
    })

# ── Load project (JSON) ───────────────────────────────────────
@app.route('/api/project/load', methods=['POST'])
def load_project():
    data = request.get_json()
    if not data or 'project' not in data:
        return jsonify({'error': 'No project data'}), 400

    proj = data['project']
    project_id = str(uuid.uuid4())

    PROJECTS[project_id] = {
        'canvas_width': proj.get('canvas_width', 1920),
        'canvas_height': proj.get('canvas_height', 1080),
        'layers': proj.get('layers', [])
    }
    save_projects()

    return jsonify({
        'success': True,
        'project_id': project_id,
        'canvas_width': PROJECTS[project_id]['canvas_width'],
        'canvas_height': PROJECTS[project_id]['canvas_height']
    })

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
    if fmt == 'JPEG':
        if img.mode in ('RGBA', 'LA', 'P', 'PA'):
            img = img.convert('RGB')
        elif img.mode in ('1', 'F', 'I'):
            img = img.convert('L').convert('RGB')
        elif img.mode == 'L':
            img = img.convert('RGB')

    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=quality)
    buf.seek(0)

    mime = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}.get(fmt,'image/jpeg')
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f'edited.{fmt.lower()}')

if __name__ == '__main__':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    print(f"Upload folder: {app.config['UPLOAD_FOLDER']}")
    app.run(debug=True, host='0.0.0.0', port=5000)
