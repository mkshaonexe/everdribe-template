"""Make a texture tile without visible seams and save it at game size.

The image is cross-faded with a copy of itself shifted by half a tile. The shifted copy has its
seams in the middle, the original at the edges, so a mask that favours the shifted copy near the
edges and the original in the middle hides both. Usage: make-tileable.py in.png out.jpg [size]
"""
import sys
import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
im = np.asarray(Image.open(src).convert('RGB').resize((size, size), Image.LANCZOS), dtype=np.float32)
shifted = np.roll(im, (size // 2, size // 2), axis=(0, 1))
t = np.abs(np.linspace(-1, 1, size))                     # 0 in the middle, 1 at the edges
w1 = np.clip((t - 0.55) / 0.4, 0, 1)
w1 = w1 * w1 * (3 - 2 * w1)
mask = np.maximum(w1[:, None], w1[None, :])[..., None]   # 1 near any edge
out = im * (1 - mask) + shifted * mask
Image.fromarray(out.clip(0, 255).astype(np.uint8)).save(dst, quality=88)
