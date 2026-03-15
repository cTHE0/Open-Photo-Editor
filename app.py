"""
Open Photo Editor - Flask Application
Open Source photo editing tool with client-friendly local processing
"""

import os
import uuid
import json
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
import io
import base64

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024  # 32MB max upload
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['PROCESSED_FOLDER'] = 'processed'

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def image_to_base64(img, fmt='JPEG'):
    """Convert PIL Image to base64 string."""
    buffer = io.BytesIO()
    if fmt == 'JPEG' and img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGB')
    img.save(buffer, format=fmt, quality=95)
    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode('utf-8')

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/upload', methods=['POST'])
def upload_image():
    """Handle image upload and return base64 preview."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': 'File type not supported'}), 400
    
    file_id = str(uuid.uuid4())
    ext = file.filename.rsplit('.', 1)[1].lower()
    
    img = Image.open(file.stream)
    original_size = img.size
    original_mode = img.mode
    
    # Save original
    original_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{file_id}_original.{ext}")
    img.save(original_path)
    
    # Convert for web preview
    preview_img = img.copy()
    if preview_img.mode not in ('RGB', 'RGBA'):
        preview_img = preview_img.convert('RGB')
    
    # Resize for preview if too large
    max_preview = 2048
    if max(preview_img.size) > max_preview:
        preview_img.thumbnail((max_preview, max_preview), Image.LANCZOS)
    
    fmt = 'PNG' if img.mode == 'RGBA' else 'JPEG'
    b64 = image_to_base64(preview_img, fmt)
    
    return jsonify({
        'success': True,
        'file_id': file_id,
        'original_ext': ext,
        'width': original_size[0],
        'height': original_size[1],
        'mode': original_mode,
        'preview': f'data:image/{fmt.lower()};base64,{b64}'
    })

@app.route('/api/process', methods=['POST'])
def process_image():
    """Apply edits to image and return result."""
    data = request.get_json()
    
    file_id = data.get('file_id')
    original_ext = data.get('original_ext', 'jpg')
    adjustments = data.get('adjustments', {})
    filters = data.get('filters', [])
    transforms = data.get('transforms', {})
    crop = data.get('crop', None)
    
    # Load original
    original_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{file_id}_original.{original_ext}")
    if not os.path.exists(original_path):
        return jsonify({'error': 'Original file not found'}), 404
    
    img = Image.open(original_path)
    
    # 1. CROP
    if crop:
        x = int(crop.get('x', 0))
        y = int(crop.get('y', 0))
        w = int(crop.get('width', img.width))
        h = int(crop.get('height', img.height))
        img = img.crop((x, y, x + w, y + h))
    
    # 2. TRANSFORMS
    if transforms.get('flip_horizontal'):
        img = ImageOps.mirror(img)
    if transforms.get('flip_vertical'):
        img = ImageOps.flip(img)
    
    rotation = transforms.get('rotation', 0)
    if rotation != 0:
        img = img.rotate(-rotation, expand=True, resample=Image.BICUBIC)
    
    # 3. ADJUSTMENTS (work on RGB copy)
    has_alpha = img.mode == 'RGBA'
    if has_alpha:
        alpha = img.split()[3]
        rgb_img = img.convert('RGB')
    else:
        rgb_img = img.convert('RGB')
    
    # Brightness
    brightness = adjustments.get('brightness', 100) / 100.0
    if brightness != 1.0:
        rgb_img = ImageEnhance.Brightness(rgb_img).enhance(brightness)
    
    # Contrast
    contrast = adjustments.get('contrast', 100) / 100.0
    if contrast != 1.0:
        rgb_img = ImageEnhance.Contrast(rgb_img).enhance(contrast)
    
    # Saturation
    saturation = adjustments.get('saturation', 100) / 100.0
    if saturation != 1.0:
        rgb_img = ImageEnhance.Color(rgb_img).enhance(saturation)
    
    # Sharpness
    sharpness = adjustments.get('sharpness', 100) / 100.0
    if sharpness != 1.0:
        rgb_img = ImageEnhance.Sharpness(rgb_img).enhance(sharpness)
    
    # Exposure (gamma correction)
    exposure = adjustments.get('exposure', 0)
    if exposure != 0:
        import numpy as np
        arr = np.array(rgb_img, dtype=np.float32)
        factor = 2 ** (exposure / 100.0)
        arr = np.clip(arr * factor, 0, 255).astype(np.uint8)
        rgb_img = Image.fromarray(arr)
    
    # Highlights & Shadows
    highlights = adjustments.get('highlights', 0)
    shadows = adjustments.get('shadows', 0)
    if highlights != 0 or shadows != 0:
        import numpy as np
        arr = np.array(rgb_img, dtype=np.float32)
        luminance = 0.299 * arr[:,:,0] + 0.587 * arr[:,:,1] + 0.114 * arr[:,:,2]
        
        if highlights != 0:
            mask = (luminance / 255.0) ** 2
            arr = arr + highlights * mask[:,:,np.newaxis]
        
        if shadows != 0:
            mask = (1.0 - luminance / 255.0) ** 2
            arr = arr + shadows * mask[:,:,np.newaxis]
        
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        rgb_img = Image.fromarray(arr)
    
    # Temperature (warm/cool)
    temperature = adjustments.get('temperature', 0)
    if temperature != 0:
        import numpy as np
        arr = np.array(rgb_img, dtype=np.float32)
        arr[:,:,0] = np.clip(arr[:,:,0] + temperature, 0, 255)
        arr[:,:,2] = np.clip(arr[:,:,2] - temperature, 0, 255)
        rgb_img = Image.fromarray(arr.astype(np.uint8))
    
    # 4. FILTERS
    for f in filters:
        if f == 'grayscale':
            rgb_img = ImageOps.grayscale(rgb_img).convert('RGB')
        elif f == 'sepia':
            import numpy as np
            arr = np.array(rgb_img, dtype=np.float32)
            r = arr[:,:,0] * 0.393 + arr[:,:,1] * 0.769 + arr[:,:,2] * 0.189
            g = arr[:,:,0] * 0.349 + arr[:,:,1] * 0.686 + arr[:,:,2] * 0.168
            b = arr[:,:,0] * 0.272 + arr[:,:,1] * 0.534 + arr[:,:,2] * 0.131
            sepia = np.stack([r, g, b], axis=2)
            rgb_img = Image.fromarray(np.clip(sepia, 0, 255).astype(np.uint8))
        elif f == 'blur':
            rgb_img = rgb_img.filter(ImageFilter.GaussianBlur(radius=2))
        elif f == 'sharpen':
            rgb_img = rgb_img.filter(ImageFilter.SHARPEN)
        elif f == 'edge_enhance':
            rgb_img = rgb_img.filter(ImageFilter.EDGE_ENHANCE)
        elif f == 'emboss':
            rgb_img = rgb_img.filter(ImageFilter.EMBOSS)
        elif f == 'invert':
            rgb_img = ImageOps.invert(rgb_img)
        elif f == 'auto_contrast':
            rgb_img = ImageOps.autocontrast(rgb_img)
        elif f == 'equalize':
            rgb_img = ImageOps.equalize(rgb_img)
        elif f == 'vignette':
            import numpy as np
            arr = np.array(rgb_img, dtype=np.float32)
            h, w = arr.shape[:2]
            Y, X = np.ogrid[:h, :w]
            cx, cy = w / 2, h / 2
            dist = np.sqrt(((X - cx) / cx) ** 2 + ((Y - cy) / cy) ** 2)
            mask = np.clip(1.0 - dist * 0.6, 0, 1)
            arr = arr * mask[:,:,np.newaxis]
            rgb_img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    
    # Restore alpha if needed
    if has_alpha and rgb_img.mode == 'RGB':
        rgb_img.putalpha(alpha)
        img = rgb_img
    else:
        img = rgb_img
    
    # Return base64 preview
    fmt = 'PNG' if has_alpha else 'JPEG'
    b64 = image_to_base64(img, fmt)
    
    # Save processed version
    processed_path = os.path.join(app.config['PROCESSED_FOLDER'], f"{file_id}_processed.{original_ext}")
    if img.mode in ('RGBA', 'LA') and original_ext in ('jpg', 'jpeg'):
        img.convert('RGB').save(processed_path, quality=95)
    else:
        img.save(processed_path, quality=95)
    
    return jsonify({
        'success': True,
        'preview': f'data:image/{fmt.lower()};base64,{b64}',
        'width': img.width,
        'height': img.height
    })

@app.route('/api/download', methods=['POST'])
def download_image():
    """Download the processed image in chosen format."""
    data = request.get_json()
    
    file_id = data.get('file_id')
    original_ext = data.get('original_ext', 'jpg')
    export_format = data.get('format', 'jpeg').lower()
    quality = data.get('quality', 95)
    adjustments = data.get('adjustments', {})
    filters = data.get('filters', [])
    transforms = data.get('transforms', {})
    crop = data.get('crop', None)
    
    # Re-process original at full resolution
    original_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{file_id}_original.{original_ext}")
    if not os.path.exists(original_path):
        return jsonify({'error': 'Original file not found'}), 404
    
    # Call process logic inline
    process_request = app.test_request_context(
        '/api/process',
        method='POST',
        json={
            'file_id': file_id,
            'original_ext': original_ext,
            'adjustments': adjustments,
            'filters': filters,
            'transforms': transforms,
            'crop': crop
        }
    )
    
    # Reload and reprocess
    img = Image.open(original_path)
    
    if crop:
        x = int(crop.get('x', 0)); y = int(crop.get('y', 0))
        w = int(crop.get('width', img.width)); h = int(crop.get('height', img.height))
        img = img.crop((x, y, x + w, y + h))
    
    if transforms.get('flip_horizontal'):
        img = ImageOps.mirror(img)
    if transforms.get('flip_vertical'):
        img = ImageOps.flip(img)
    rotation = transforms.get('rotation', 0)
    if rotation != 0:
        img = img.rotate(-rotation, expand=True, resample=Image.BICUBIC)
    
    has_alpha = img.mode == 'RGBA'
    if has_alpha:
        alpha = img.split()[3]
    rgb_img = img.convert('RGB')
    
    brightness = adjustments.get('brightness', 100) / 100.0
    if brightness != 1.0:
        rgb_img = ImageEnhance.Brightness(rgb_img).enhance(brightness)
    contrast = adjustments.get('contrast', 100) / 100.0
    if contrast != 1.0:
        rgb_img = ImageEnhance.Contrast(rgb_img).enhance(contrast)
    saturation = adjustments.get('saturation', 100) / 100.0
    if saturation != 1.0:
        rgb_img = ImageEnhance.Color(rgb_img).enhance(saturation)
    sharpness = adjustments.get('sharpness', 100) / 100.0
    if sharpness != 1.0:
        rgb_img = ImageEnhance.Sharpness(rgb_img).enhance(sharpness)
    
    exposure = adjustments.get('exposure', 0)
    if exposure != 0:
        import numpy as np
        arr = np.array(rgb_img, dtype=np.float32)
        factor = 2 ** (exposure / 100.0)
        arr = np.clip(arr * factor, 0, 255).astype(np.uint8)
        rgb_img = Image.fromarray(arr)
    
    highlights = adjustments.get('highlights', 0)
    shadows = adjustments.get('shadows', 0)
    if highlights != 0 or shadows != 0:
        import numpy as np
        arr = np.array(rgb_img, dtype=np.float32)
        luminance = 0.299 * arr[:,:,0] + 0.587 * arr[:,:,1] + 0.114 * arr[:,:,2]
        if highlights != 0:
            mask = (luminance / 255.0) ** 2
            arr = arr + highlights * mask[:,:,np.newaxis]
        if shadows != 0:
            mask = (1.0 - luminance / 255.0) ** 2
            arr = arr + shadows * mask[:,:,np.newaxis]
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        rgb_img = Image.fromarray(arr)
    
    temperature = adjustments.get('temperature', 0)
    if temperature != 0:
        import numpy as np
        arr = np.array(rgb_img, dtype=np.float32)
        arr[:,:,0] = np.clip(arr[:,:,0] + temperature, 0, 255)
        arr[:,:,2] = np.clip(arr[:,:,2] - temperature, 0, 255)
        rgb_img = Image.fromarray(arr.astype(np.uint8))
    
    for f in filters:
        if f == 'grayscale':
            rgb_img = ImageOps.grayscale(rgb_img).convert('RGB')
        elif f == 'sepia':
            import numpy as np
            arr = np.array(rgb_img, dtype=np.float32)
            r = arr[:,:,0]*0.393 + arr[:,:,1]*0.769 + arr[:,:,2]*0.189
            g = arr[:,:,0]*0.349 + arr[:,:,1]*0.686 + arr[:,:,2]*0.168
            b = arr[:,:,0]*0.272 + arr[:,:,1]*0.534 + arr[:,:,2]*0.131
            rgb_img = Image.fromarray(np.clip(np.stack([r,g,b],axis=2),0,255).astype(np.uint8))
        elif f == 'blur':
            rgb_img = rgb_img.filter(ImageFilter.GaussianBlur(radius=2))
        elif f == 'sharpen':
            rgb_img = rgb_img.filter(ImageFilter.SHARPEN)
        elif f == 'edge_enhance':
            rgb_img = rgb_img.filter(ImageFilter.EDGE_ENHANCE)
        elif f == 'emboss':
            rgb_img = rgb_img.filter(ImageFilter.EMBOSS)
        elif f == 'invert':
            rgb_img = ImageOps.invert(rgb_img)
        elif f == 'auto_contrast':
            rgb_img = ImageOps.autocontrast(rgb_img)
        elif f == 'equalize':
            rgb_img = ImageOps.equalize(rgb_img)
        elif f == 'vignette':
            import numpy as np
            arr = np.array(rgb_img, dtype=np.float32)
            h, w = arr.shape[:2]
            Y, X = np.ogrid[:h, :w]
            cx, cy = w/2, h/2
            dist = np.sqrt(((X-cx)/cx)**2 + ((Y-cy)/cy)**2)
            mask = np.clip(1.0 - dist*0.6, 0, 1)
            arr = arr * mask[:,:,np.newaxis]
            rgb_img = Image.fromarray(np.clip(arr,0,255).astype(np.uint8))
    
    if has_alpha and export_format == 'png':
        rgb_img.putalpha(alpha)
        final_img = rgb_img
    else:
        final_img = rgb_img
    
    # Save to buffer
    buffer = io.BytesIO()
    fmt_map = {'jpeg': 'JPEG', 'jpg': 'JPEG', 'png': 'PNG', 'webp': 'WEBP'}
    pil_fmt = fmt_map.get(export_format, 'JPEG')
    
    if pil_fmt == 'JPEG' and final_img.mode in ('RGBA', 'P'):
        final_img = final_img.convert('RGB')
    
    save_kwargs = {'format': pil_fmt}
    if pil_fmt in ('JPEG', 'WEBP'):
        save_kwargs['quality'] = quality
    
    final_img.save(buffer, **save_kwargs)
    buffer.seek(0)
    
    mime_map = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}
    
    return send_file(
        buffer,
        mimetype=mime_map.get(pil_fmt, 'image/jpeg'),
        as_attachment=True,
        download_name=f'edited_photo.{export_format}'
    )

if __name__ == '__main__':
    os.makedirs('uploads', exist_ok=True)
    os.makedirs('processed', exist_ok=True)
    app.run(debug=True, host='0.0.0.0', port=5000)
