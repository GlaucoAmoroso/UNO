"""Generates the app icons (PNG) with Pillow. Run: python3 tools/make-icons.py"""
from PIL import Image, ImageDraw
import math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
COLORS = [(230, 57, 70), (247, 184, 1), (42, 157, 88), (37, 99, 214)]

def card_layer(size, w, h, color, angle):
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    card = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=int(w * .16), fill=(255, 255, 255, 255))
    m = int(w * .07)
    d.rounded_rectangle((m, m, w - 1 - m, h - 1 - m), radius=int(w * .12), fill=color + (255,))
    d.ellipse((w * .22, h * .3, w * .78, h * .7), fill=(255, 255, 255, 235))
    card = card.rotate(angle, expand=True, resample=Image.BICUBIC)
    layer.alpha_composite(card, ((size - card.width) // 2, (size - card.height) // 2))
    return layer

def make(size, margin_ratio, rounded=True):
    bg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(bg)
    for y in range(size):  # felt gradient
        t = y / size
        c = (int(34 + (16 - 34) * t), int(121 + (62 - 121) * t), int(90 + (48 - 90) * t), 255)
        d.line((0, y, size, y), fill=c)
    if rounded:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * .22), fill=255)
        bg.putalpha(mask)
    inner = int(size * (1 - 2 * margin_ratio))
    w, h = int(inner * .42), int(inner * .62)
    fan = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for color, angle in zip(COLORS, (28, 9, -9, -28)):
        layer = card_layer(size, w, h, color, angle)
        offset = int(-angle * inner * .0095)
        shifted = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        shifted.alpha_composite(layer, (offset, int(abs(angle) * inner * .0018)))
        fan.alpha_composite(shifted)
    bg.alpha_composite(fan)
    return bg

os.makedirs(OUT, exist_ok=True)
make(512, .12).save(os.path.join(OUT, 'icon-512.png'))
make(192, .12).save(os.path.join(OUT, 'icon-192.png'))
make(512, .22, rounded=False).save(os.path.join(OUT, 'icon-maskable-512.png'))  # full-bleed, content in the safe zone
make(180, .12, rounded=False).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
open(os.path.join(OUT, 'icon.svg'), 'w').write('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f6b4f"/>
<g stroke="#fff" stroke-width="2.5"><rect x="9" y="14" width="18" height="28" rx="4" fill="#e63946" transform="rotate(-24 18 28)"/>
<rect x="17" y="12" width="18" height="28" rx="4" fill="#f7b801" transform="rotate(-8 26 26)"/>
<rect x="27" y="12" width="18" height="28" rx="4" fill="#2a9d58" transform="rotate(8 36 26)"/>
<rect x="36" y="14" width="18" height="28" rx="4" fill="#2563d6" transform="rotate(24 45 28)"/></g></svg>''')
print('icons written')
