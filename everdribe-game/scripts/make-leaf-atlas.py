"""
Leaf atlas for the trees (world/TreeFactory.ts) from the Higgsfield leaf sheet.

Input:  resources/higgsfield/images/leaf-sheet.png  (2048 x 2048, transparent, four clusters in a 2 x 2 grid:
        beech top-left, birch top-right, autumn bottom-left, spruce bottom-right)
Output: everdribe-game/public/assets/textures/leaves.webp  (2048 x 2048 with alpha)

Atlas layout, as TreeFactory reads it (UV v runs up, tile i at u = (i % 2) / 2, v = floor(i / 2) / 2):
    image top row:    2 autumn   | 3 spruce
    image bottom row: 0 broadleaf | 1 birch

Each cluster is cropped to its leaves, centred, and scaled to fill its tile with a small margin. The colour
under transparent pixels is filled with the nearby leaf colour, so mip levels (which average colour and
alpha together) do not grow dark or white fringes around the leaves.

Run from the repo root:  python3 everdribe-game/scripts/make-leaf-atlas.py
Needs Python 3, numpy, Pillow and `cwebp` on the PATH.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'resources/higgsfield/images/leaf-sheet.png'
OUT = ROOT / 'everdribe-game/public/assets/textures/leaves.webp'
TILE = 1024
MARGIN = 0.03   # share of the tile left empty around each cluster

# Sheet quadrant (column, row from the top) -> atlas position (column, row from the top)
PLACE = {
    (0, 0): (0, 1),   # beech  -> tile 0 (bottom-left)
    (1, 0): (1, 1),   # birch  -> tile 1 (bottom-right)
    (0, 1): (0, 0),   # autumn -> tile 2 (top-left)
    (1, 1): (1, 0),   # spruce -> tile 3 (top-right)
}


def bleed(img: Image.Image) -> Image.Image:
    """Fill the colour of transparent pixels with an alpha-weighted blur of the leaves around them."""
    a = np.asarray(img.getchannel('A'), dtype=np.float32) / 255.0
    rgb = np.asarray(img.convert('RGB'), dtype=np.float32)
    filled = a >= 0.5
    mean = rgb[filled].mean(axis=0)

    def box(x: np.ndarray, r: int, axis: int) -> np.ndarray:
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(x, pad, mode='edge'), axis=axis)
        n = x.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        return (hi - lo) / (2 * r + 1)

    def blur(x: np.ndarray, radius: int) -> np.ndarray:
        # Three box passes each way, close to a Gaussian, in float so faint weights are not rounded away
        for _ in range(3):
            x = box(box(x, radius, 0), radius, 1)
        return x

    # Grow the colour outwards: small blur first, wider ones for what is still empty (the nearest leaves win)
    for radius in (3, 12, 48, 192):
        w = blur(filled.astype(np.float32), radius)
        found = ~filled & (w > 1e-4)
        if not found.any():
            continue
        for c in range(3):
            ch = blur(np.where(filled, rgb[..., c] / 255, 0), radius)
            rgb[..., c] = np.where(found, ch / np.maximum(w, 1e-6) * 255, rgb[..., c])
        filled |= found
    rgb[~filled] = mean
    out = np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def main() -> None:
    sheet = Image.open(SRC).convert('RGBA')
    half = sheet.width // 2
    atlas = Image.new('RGBA', (TILE * 2, TILE * 2), (0, 0, 0, 0))
    for (col, row), (ac, ar) in PLACE.items():
        quad = sheet.crop((col * half, row * half, (col + 1) * half, (row + 1) * half))
        alpha = np.asarray(quad.getchannel('A'))
        ys, xs = np.nonzero(alpha > 24)
        box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        cluster = quad.crop(box)
        side = int(max(cluster.width, cluster.height) / (1 - 2 * MARGIN))
        square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        square.alpha_composite(cluster, ((side - cluster.width) // 2, (side - cluster.height) // 2))
        tile = square.resize((TILE, TILE), Image.LANCZOS)
        atlas.alpha_composite(tile, (ac * TILE, ar * TILE))
    atlas = bleed(atlas)
    tmp = OUT.with_suffix('.png')
    atlas.save(tmp)
    subprocess.run(['cwebp', '-q', '88', '-alpha_q', '100', '-exact', '-quiet', str(tmp), '-o', str(OUT)], check=True)
    tmp.unlink()
    print(f'{OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1024:.0f} KB', file=sys.stderr)


if __name__ == '__main__':
    main()
