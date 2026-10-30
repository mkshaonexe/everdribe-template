#!/usr/bin/env bash
# Turn raw Higgsfield outputs (resources/higgsfield/) into game-ready files (everdribe-game/public/assets/).
# Safe to run any time: it only converts files that exist, so you can run it after each generation.
# Needs: node (npx), python3 with numpy + Pillow, ffmpeg, cwebp.
#   bash scripts/build-assets.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
R="$ROOT/resources/higgsfield"
G="$ROOT/everdribe-game/public/assets"
mkdir -p "$G/textures" "$G/models" "$G/audio"
have() { [ -f "$R/$1" ]; }
say() { printf '  %-28s -> %s\n' "$1" "$2"; }

echo "Textures"
for pair in grass:tex-grass asphalt:tex-asphalt gravel:tex-gravel dirt:tex-dirt riverbed:tex-riverbed; do
  out="${pair%%:*}"; src="images/${pair##*:}.png"
  if have "$src"; then python3 "$ROOT/everdribe-game/scripts/make-tileable.py" "$R/$src" "$G/textures/$out.jpg" 1024 && say "$src" "textures/$out.jpg"; fi
done
if have images/dust-puff.png; then
  python3 -c "from PIL import Image; Image.open('$R/images/dust-puff.png').convert('RGBA').resize((256,256), Image.LANCZOS).save('$G/textures/dust.png')" && say images/dust-puff.png textures/dust.png
fi
if have images/leaf-sheet.png; then
  (cd "$ROOT" && python3 everdribe-game/scripts/make-leaf-atlas.py) && say images/leaf-sheet.png textures/leaves.webp
fi

echo "3D models"
opt() { npx -y @gltf-transform/cli@4 optimize "$1" "$2" --compress false --texture-compress webp "${@:3}" >/dev/null; }
if have models/car-a.glb; then opt "$R/models/car-a.glb" "$G/models/car-a.glb" --texture-size 2048 && say models/car-a.glb models/car-a.glb; fi
for m in house barn fence guardrail rock; do
  if have "models/$m.glb"; then opt "$R/models/$m.glb" "$G/models/$m.glb" --texture-size 1024 && say "models/$m.glb" "models/$m.glb"; fi
done
if have models/rock.glb; then opt "$R/models/rock.glb" "$G/models/rock-lod.glb" --texture-size 256 --simplify-ratio 0.12 && say models/rock.glb models/rock-lod.glb; fi

echo "Sound"
python3 "$ROOT/everdribe-game/scripts/make-loops.py" "$R/audio" "$G/audio" >/dev/null && echo "  engine, skid, gravel, wind, ambience, bump, click"
python3 "$ROOT/scripts/prepare-sfx.py" >/dev/null && echo "  hits, scrapes, landings, splash, horn, surface rolls"
for m in music-drive music-menu; do
  if have "audio/$m.m4a"; then cp "$R/audio/$m.m4a" "$G/audio/$m.m4a" && say "audio/$m.m4a" "audio/$m.m4a"; fi
done
echo "Done. Refresh the game in the browser."
