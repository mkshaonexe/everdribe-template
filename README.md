# EverDribe template

An endless countryside driving game that runs in the browser, built with Claude Code. The code is complete. **You make the assets yourself** with the Higgsfield MCP: the car, textures, rocks, houses, leaves, sounds and music.

👉 Try Higgsfield MCP: https://higgsfield.ai/s/higgsfield-mcp-general-yt-mkshaon7-rymrVL

## Quick start

```bash
git clone https://github.com/mkshaonexe/everdribe-template.git
cd everdribe-template
npm --prefix everdribe-game install
npm --prefix everdribe-game run dev
```

Open http://localhost:5173. Without assets, you get a blue placeholder car, plain ground, stand-in rocks and houses, and no sound. That is expected.

## Make it yours

Open this folder in Claude Code (or Codex) with the Higgsfield MCP connected, and ask:

> Read CLAUDE.md. Make all the assets from higgsfield-recipe.json with the Higgsfield MCP. Show me the cost first.

To use your own car, attach a picture or describe it. Claude turns it into a 3D model the same way the original car was made. Every step and prompt is in `higgsfield-recipe.json`, and `CLAUDE.md` explains the workflow.

## Controls

W/S drive and brake, A/D steer, Space hard brake, Shift boost, H horn, C camera, R back to the road, Esc menu.

## Folders

| Path | What |
|---|---|
| `everdribe-game/` | the game (Vite + React + three.js) |
| `resources/higgsfield/` | raw Higgsfield outputs (you generate these) |
| `scripts/build-assets.sh` | turns raw outputs into game files |
| `higgsfield-recipe.json` | the exact Higgsfield jobs behind the original look |
| `docs/DRIVING-PHYSICS.md` | how the car physics works |

Code: MIT. Assets you generate are yours, under Higgsfield's terms.
