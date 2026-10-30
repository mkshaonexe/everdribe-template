# EverDribe template: rules for AI agents

You are helping someone (often a beginner) turn this template into their own 3D driving game. Explain things in simple words. Work in small steps, test each step, and commit.

## What this is

- An endless countryside driving game that runs in the browser. Code: `everdribe-game/` (Vite + React + TypeScript + three.js via @react-three/fiber, zustand, howler).
- The code is complete, but **the template ships with no assets**. Without them the game still runs: a blue placeholder car, plain-coloured ground, simple stand-in rocks, houses and fences, code-grown trees with drawn leaves, and no sound.
- Every real asset is made with the **Higgsfield MCP** and dropped into `resources/higgsfield/`. Then `bash scripts/build-assets.sh` converts it into `everdribe-game/public/assets/`, and the game picks it up on refresh. `everdribe-game/ASSETS.md` lists every file the game reads.

## Run it

```bash
npm --prefix everdribe-game install
npm --prefix everdribe-game run dev
```

Open http://localhost:5173 (on a Mac with Brave: `open -a "Brave Browser" http://localhost:5173`).
Asset tools: python3 with numpy and Pillow, ffmpeg, cwebp, node. Install whatever is missing (on a Mac: `brew install ffmpeg webp` and `python3 -m pip install numpy pillow`).

## Making assets with Higgsfield: the recipe

`higgsfield-recipe.json` holds the **exact** Higgsfield jobs (model, settings, prompt, reference/input images, output file) that made the original EverDribe look. It is the default.

1. **Cost first, always.** Before generating, call `get_cost` for each job in the batch, show the user one table (asset → model → credits, plus the total), and wait for a clear "yes". Never generate without it.
2. **Default:** if the user gives no reference and asks for no change, run the recipe jobs exactly as written: same model, same settings, same prompt. AI output varies a little each time, which is fine.
3. **The user's own car:** if the user gives a car image, a reference photo, or a description:
   - Make one front three-quarter "product render" in the same style as the recipe's `car-a-emerald.png` prompt, with their design and colour. Use their image as a reference. If their car is a real brand, still remove every logo, badge, emblem, text and licence plate.
   - Show it and wait for approval.
   - Make the four views (front, left, rear, right) with the recipe's four view prompts. Replace "emerald-green paint, black roof and wheels" with their colours and use the approved render as the reference.
   - Make the 3D model with the recipe's `tripo_h3_1_multiview_to_3d` settings (30k faces, PBR, detailed texture), using the 4 views in the same order.
   - Save it as `resources/higgsfield/models/car-a.glb` so the code picks it up. If it faces the wrong way or sits too high or low, adjust `everdribe-game/src/assets.config.ts` only.
4. **Other changes** (a different texture, trees, sounds, music): edit only the matching recipe prompt and keep the same model and settings.
5. Save every finished file at the exact `file` path from the recipe (the URL result → download → that path). Then run `bash scripts/build-assets.sh`, refresh the browser, and show the user the result.
6. Run independent jobs in parallel. A 3D job needs its input image to finish first.

## Game rules (learned the hard way, keep them)

- **Physics** (`src/vehicle/VehiclePhysics.ts`, tuning constants at the top) runs in fixed steps of at most 1/240 s. Grip: asphalt 1.0, gravel shoulder 0.82 → 0.70, grass 0.68. Steering shrinks with speed. Stability control stops normal fast turns from spinning the car. S brakes and only reverses after a stop. Space is a hard brake. Every value is guarded against NaN, and a broken state resets the car onto the road. Details: `docs/DRIVING-PHYSICS.md`.
- **Handling and settings:** every handling value (steering, grip, drift, brakes, acceleration) and every graphics option is a slider in the menu, saved in localStorage. Add new tunables there, not as hidden constants.
- **Graphics:** all quality numbers live in `src/graphics/GraphicsProfile.ts`. Tone mapping happens once, in the output pass. Colour textures use sRGB, mipmaps and maximum anisotropy (blurry or washed-out textures almost always mean one of these is wrong). The gameplay world (tree positions, colliders) never depends on the quality level. Keep High at 60 FPS.
- **Trees and grass are grown in code** (`world/TreeFactory.ts`, `world/Grass.tsx`). Only the leaf picture comes from Higgsfield. Do not swap them for 3D tree models: that costs more and runs slower.
- **Original content only:** no real car brands, logos, other games' names, models, textures or screenshots.
- After every visible change: run it, look at it, and commit. Never say something works without running it.
