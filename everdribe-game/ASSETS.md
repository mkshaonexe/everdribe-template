# EverDribe assets

This template ships with `public/assets/` **empty** (only `.gitkeep` files in `models/`, `textures/` and `audio/`).
The game still runs: every missing file is replaced by a stand-in built in code. Drop any of the files below into
`public/assets/` with the exact name and **refresh the page**; the game finds it and uses it instead of the stand-in.
The title menu shows how many were found ("Assets: N/39 loaded", bottom right).

How it works: `src/assets/availability.ts` probes every path below once at start-up (HEAD requests, in parallel).
A file counts as present when the server answers 200 and the answer is not HTML (Vite's dev server and many static
hosts answer a missing file with `index.html`). The 3D scene mounts only after that check.

Car fitting knobs (file name, length, rotation, height, paint colour) are in `src/assets.config.ts`.

## Models (`public/assets/models/`)

GLB (glTF binary). The originals were Tripo/Higgsfield exports fitted in a unit box with WebP textures
(`EXT_texture_webp`); any size or origin works because the code rescales each model. One mesh per scenery model
(Scenery uses the first mesh it finds).

| File | What it is | Fitted to | Original size | Read by | Stand-in without it |
|---|---|---|---|---|---|
| `car-a.glb` | The player's car | Longest side 4.75 m, turned by `yawDegrees` (90: nose along +X in the file), lowest point at `yOffset` (−0.02 m) | 1.3 MB | `src/vehicle/VehicleModel.tsx` (path from `src/assets.config.ts`) | Blue coupe from primitives (`src/vehicle/ProceduralCar.ts`) |
| `rock.glb` | Boulder near the road | 1.4 m tall | 250 KB | `src/world/Scenery.tsx` | Grey low-poly rock (`src/world/PropStandIns.ts`) |
| `rock-lod.glb` | Lighter rock for distance | 1.4 m tall | 32 KB | `src/world/Scenery.tsx` | `rock.glb`, else the stand-in rock |
| `house.glb` | Farm house | 7.5 m tall (~7.7 × 9.1 m) | 270 KB | `src/world/Scenery.tsx` | Box house with gable roof |
| `barn.glb` | Barn | 9 m tall (~14.3 × 9.9 m) | 260 KB | `src/world/Scenery.tsx` | Red barn with grey roof |
| `fence.glb` | One wooden fence section | Longest side 4.1 m (laid along the road) | 150 KB | `src/world/Scenery.tsx` | Two posts and three rails |
| `guardrail.glb` | One steel guardrail section | Longest side 4.1 m (laid along the road) | 84 KB | `src/world/Scenery.tsx` | Post and W-beam |

Trees and shrubs are grown in code (`src/world/TreeFactory.ts`); they need no model files.

## Textures (`public/assets/textures/`)

| File | What it is | Format / size | Read by | Stand-in without it |
|---|---|---|---|---|
| `leaves.webp` | Leaf atlas, 2 × 2 tiles of leaf clusters on transparent background. Bottom-left: broadleaf, bottom-right: birch, top-left: autumn, top-right: spruce | WebP with alpha, 2048 × 2048, 1.6 MB | `src/world/Scenery.tsx` (`setupLeafAtlas` in `TreeFactory.ts`) | Leaves drawn on a canvas, same layout (`makeLeafAtlas`) |
| `grass.jpg` | Meadow ground, seamless tile | JPEG 1024 × 1024, ~580 KB | `src/terrain/TerrainMaterial.ts` | Green speckled tile |
| `dirt.jpg` | Bare soil, seamless tile | JPEG 1024 × 1024, ~530 KB | `src/terrain/TerrainMaterial.ts` | Brown speckled tile |
| `gravel.jpg` | Stone / gravel, seamless tile (shown greyed) | JPEG 1024 × 1024, ~590 KB | `src/terrain/TerrainMaterial.ts` | Grey-beige speckled tile |
| `riverbed.jpg` | Sand and pebbles by water, seamless tile | JPEG 1024 × 1024, ~470 KB | `src/terrain/TerrainMaterial.ts` | Sandy speckled tile |
| `dust.png` | Soft dust puff sprite (wheel dust) | PNG with alpha, 256 × 256, 75 KB | `src/graphics/SurfaceEffects.tsx` | Radial gradient drawn on a canvas |

The road surface and its white lines are drawn in code (`src/terrain/RoadMesh.tsx`); no texture is needed.

## Sounds (`public/assets/audio/`)

WAV (16-bit PCM) for effects, AAC in `.m4a` for music; any format the browser can decode works with the same name.
All are listed in `SOUND_FILES` in `src/audio/AudioManager.ts`. A missing sound is silent; without the three engine
recordings a synthesized engine hum plays instead (`src/audio/EngineAudio.ts`). The countryside ambience is made in code.

| File | What it is | Original size | Played by |
|---|---|---|---|
| `engine-idle.wav` | Engine loop at idle (~1000 rpm) | 350 KB | `EngineAudio.ts` |
| `engine-mid.wav` | Engine loop at mid revs (~3800 rpm) | 350 KB | `EngineAudio.ts` |
| `engine-high.wav` | Engine loop at high revs (~6200 rpm) | 350 KB | `EngineAudio.ts` |
| `skid.wav` | Tyre squeal loop | 310 KB | `EngineAudio.ts` |
| `gravel.wav` | Rolling on gravel loop | 440 KB | `EngineAudio.ts` |
| `grass-roll.wav` | Rolling on grass loop | 190 KB | `EngineAudio.ts` |
| `dirt-roll.wav` | Rolling on dirt loop | 190 KB | `EngineAudio.ts` |
| `wind.wav` | Wind noise loop | 530 KB | `EngineAudio.ts` |
| `bump.wav` | Bump (loaded, not played at the moment) | 280 KB | — |
| `rail-hit-hard.wav` | Hard guardrail hit | 140 KB | `ImpactAudio.ts` |
| `rail-hit-soft.wav` | Light guardrail hit | 80 KB | `ImpactAudio.ts` |
| `rail-scrape.wav` | Scraping along a guardrail (loop) | 180 KB | `ImpactAudio.ts` |
| `tree-hit-hard.wav` | Hard tree hit | 140 KB | `ImpactAudio.ts` |
| `tree-hit-soft.wav` | Light tree / bush hit | 90 KB | `ImpactAudio.ts` |
| `pine-hit.wav` | Pine hit | 140 KB | `ImpactAudio.ts` |
| `birch-hit.wav` | Birch hit | 90 KB | `ImpactAudio.ts` |
| `tree-scrape.wav` | Scraping along a tree (loop) | 160 KB | `ImpactAudio.ts` |
| `rock-hit.wav` | Rock / building hit | 110 KB | `ImpactAudio.ts` |
| `crash-heavy.wav` | Heavy crash | 160 KB | `ImpactAudio.ts` |
| `land-hard.wav` | Hard landing after a jump | 90 KB | `ImpactAudio.ts` |
| `land-soft.wav` | Soft landing | 50 KB | `ImpactAudio.ts` |
| `splash.wav` | Driving into water | 190 KB | `ImpactAudio.ts` |
| `horn.wav` | Horn (loop while H is held) | 140 KB | `ImpactAudio.ts` |
| `click.wav` | Menu click | 70 KB | `src/ui/MenuOverlay.tsx` |
| `music-menu.m4a` | Menu music (loops) | 1.5 MB | `src/App.tsx` (`MusicDirector`) |
| `music-drive.m4a` | Driving music (plays, then 40–100 s of silence) | 1.5 MB | `src/App.tsx` (`MusicDirector`) |

## How to generate them with Higgsfield

Every file above has its exact Higgsfield job (model, settings, prompt, input images) in [`../higgsfield-recipe.json`](../higgsfield-recipe.json). Save raw outputs at the recipe's `file` paths under `resources/higgsfield/`, then run `bash scripts/build-assets.sh` from the repo root: it makes the tileable JPG textures, the leaf atlas, the WebP-compressed GLB models (plus the rock LOD) and the looped/levelled sounds. See `CLAUDE.md` for the full workflow.
