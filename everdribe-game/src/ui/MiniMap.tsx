import { useRef, useEffect, useState } from 'react';
import { useGameStore, playerPose } from '../stores/gameStore';

// Matches WorldGen: 10 m asphalt with a 2.5 m gravel shoulder on each side
const ROAD_WIDTH = 10;
const SHOULDER_WIDTH = 2.5;
const ON_ROAD_DISTANCE = ROAD_WIDTH / 2;
const ON_SHOULDER_DISTANCE = ROAD_WIDTH / 2 + SHOULDER_WIDTH;

const MINI_SIZE = 132;   // CSS px
const MINI_RANGE = 200;  // metres across the circle

const GRASS = '#6b9a4a';
const SHOULDER = '#b8a67c';
const ASPHALT = '#4a4d53';
const MARKING = '#ecE7d2';

// World-anchored speckle tile, so the ground visibly slides past when you leave the road
function makeGrassPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    const tile = document.createElement('canvas');
    tile.width = 128;
    tile.height = 128;
    const t = tile.getContext('2d');
    if (!t) return null;
    t.fillStyle = GRASS;
    t.fillRect(0, 0, 128, 128);
    // Seeded so the tile never changes between sessions
    let s = 1337;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
        t.fillStyle = rnd() > 0.5 ? 'rgba(40, 90, 40, 0.16)' : 'rgba(150, 190, 90, 0.18)';
        t.beginPath();
        t.arc(rnd() * 128, rnd() * 128, 6 + rnd() * 14, 0, Math.PI * 2);
        t.fill();
    }
    for (let i = 0; i < 90; i++) {
        t.fillStyle = rnd() > 0.5 ? 'rgba(30, 70, 30, 0.35)' : 'rgba(180, 210, 120, 0.35)';
        t.fillRect(rnd() * 128, rnd() * 128, 1.5, 1.5);
    }
    return ctx.createPattern(tile, 'repeat');
}

// Distance from (px,pz) to segment (ax,az)-(bx,bz)
function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

type Surface = 'ROAD' | 'SHOULDER' | 'GRASS';

export function MiniMap() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const [hovered, setHovered] = useState(false);

    // Draw loop. Reads the live pose every frame, so it follows the car anywhere.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = isExpanded ? window.innerWidth : MINI_SIZE;
        const height = isExpanded ? window.innerHeight : MINI_SIZE;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const grass = makeGrassPattern(ctx);
        let lastSurface: Surface | '' = '';
        let raf = 0;

        const draw = () => {
            const { roadPath } = useGameStore.getState();
            const { x: px, z: pz, yaw } = playerPose;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, width, height);

            // View transform: world metres -> canvas px
            let scale: number;
            let rotation = 0;      // canvas rotation (mini map turns so the car's nose points up)
            let focusX = px;       // world point drawn at the canvas centre
            let focusZ = pz;
            const cx = width / 2;
            const cy = height / 2;

            if (isExpanded) {
                let minX = px, maxX = px, minZ = pz, maxZ = pz;
                for (const p of roadPath) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.z < minZ) minZ = p.z;
                    if (p.z > maxZ) maxZ = p.z;
                }
                const pad = 100;
                minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
                scale = Math.min(width / (maxX - minX), height / (maxZ - minZ)) * 0.9;
                focusX = (minX + maxX) / 2;
                focusZ = (minZ + maxZ) / 2;
                ctx.fillStyle = 'rgba(15, 15, 20, 0.97)';
                ctx.fillRect(0, 0, width, height);
            } else {
                scale = width / MINI_RANGE;
                rotation = -Math.PI / 2 - yaw;
                ctx.save();
                ctx.beginPath();
                ctx.arc(cx, cy, width / 2, 0, Math.PI * 2);
                ctx.clip();
            }

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rotation);
            ctx.scale(scale, scale);
            ctx.translate(-focusX, -focusZ);

            // Ground
            const reach = (isExpanded ? Math.max(width, height) / scale : MINI_RANGE) * 1.5;
            if (grass) {
                ctx.save();
                ctx.scale(0.5, 0.5); // one 128px tile = 64 m
                ctx.fillStyle = grass;
                ctx.fillRect((focusX - reach) * 2, (focusZ - reach) * 2, reach * 4, reach * 4);
                ctx.restore();
            } else {
                ctx.fillStyle = GRASS;
                ctx.fillRect(focusX - reach, focusZ - reach, reach * 2, reach * 2);
            }

            // Which road points matter? Mini map only needs the ones near the car.
            const cull = isExpanded ? Infinity : MINI_RANGE * 0.9;
            const cullSq = cull * cull;
            let nearest = Infinity;

            const strokeRoad = (lineWidth: number, color: string, dash?: number[]) => {
                ctx.lineWidth = lineWidth;
                ctx.strokeStyle = color;
                ctx.lineCap = 'butt';
                ctx.lineJoin = 'round';
                ctx.setLineDash(dash ?? []);
                ctx.beginPath();
                let pen = false;
                for (let i = 0; i < roadPath.length; i++) {
                    const p = roadPath[i];
                    const dx = p.x - px;
                    const dz = p.z - pz;
                    if (dx * dx + dz * dz > cullSq) { pen = false; continue; }
                    if (pen) ctx.lineTo(p.x, p.z);
                    else { ctx.moveTo(p.x, p.z); pen = true; }
                }
                ctx.stroke();
                ctx.setLineDash([]);
            };

            if (roadPath.length > 1) {
                // Keep the road readable on the small circle and the zoomed-out map
                const minPx = isExpanded ? 3 : 0;
                const roadW = Math.max(ROAD_WIDTH, minPx / scale);
                const shoulderW = roadW + SHOULDER_WIDTH * 2;
                strokeRoad(shoulderW, SHOULDER);
                strokeRoad(roadW, ASPHALT);
                if (!isExpanded) strokeRoad(Math.max(0.6, 1.2 / scale), MARKING, [4, 6]);

                for (let i = 0; i < roadPath.length - 1; i++) {
                    const a = roadPath[i];
                    const b = roadPath[i + 1];
                    const d = distToSegment(px, pz, a.x, a.z, b.x, b.z);
                    if (d < nearest) nearest = d;
                }
            }

            // Car: arrow pointing along the nose. In the rotated mini map this is always "up".
            ctx.save();
            ctx.translate(px, pz);
            ctx.rotate(yaw);
            const k = (isExpanded ? 9 : 6.5) / scale;
            ctx.beginPath();
            ctx.moveTo(k * 1.25, 0);
            ctx.lineTo(-k * 0.8, k * 0.85);
            ctx.lineTo(-k * 0.4, 0);
            ctx.lineTo(-k * 0.8, -k * 0.85);
            ctx.closePath();
            ctx.fillStyle = '#ff4747';
            ctx.fill();
            ctx.lineWidth = 1.5 / scale;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.restore();

            ctx.restore(); // world transform

            if (!isExpanded) {
                // Vignette ring + north marker (map turns with the car, so N moves around the edge)
                ctx.restore(); // clip
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
                ctx.beginPath();
                ctx.arc(cx, cy, width / 2 - 1.5, 0, Math.PI * 2);
                ctx.stroke();

                const nx = cx + Math.sin(rotation) * (width / 2 - 10);
                const ny = cy - Math.cos(rotation) * (width / 2 - 10);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.beginPath();
                ctx.arc(nx, ny, 7, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 9px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('N', nx, ny + 0.5);
            } else {
                ctx.fillStyle = 'white';
                ctx.font = 'bold 24px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('World Map', 40, 50);
                ctx.font = '14px sans-serif';
                ctx.fillStyle = '#aaa';
                ctx.fillText(`${roadPath.length} road points`, 40, 80);

                const btnX = width - 50;
                const btnY = 50;
                ctx.fillStyle = 'rgba(255, 85, 85, 0.9)';
                ctx.beginPath();
                ctx.arc(btnX, btnY, 25, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(btnX - 10, btnY - 10);
                ctx.lineTo(btnX + 10, btnY + 10);
                ctx.moveTo(btnX + 10, btnY - 10);
                ctx.lineTo(btnX - 10, btnY + 10);
                ctx.stroke();

                ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Click X, press M or Esc to close', width / 2, height - 30);
                ctx.fillStyle = '#ff4747';
                ctx.beginPath();
                ctx.arc(40, height - 60, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.textAlign = 'left';
                ctx.fillText('= You', 55, height - 55);
            }

            // Surface readout under the mini map, only touches the DOM when it changes
            const surface: Surface =
                nearest <= ON_ROAD_DISTANCE ? 'ROAD' :
                nearest <= ON_SHOULDER_DISTANCE ? 'SHOULDER' : 'GRASS';
            if (surface !== lastSurface) {
                lastSurface = surface;
                if (surfaceRef.current) surfaceRef.current.textContent = surface;
            }

            raf = requestAnimationFrame(draw);
        };

        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [isExpanded]);

    // Keyboard "M" listener
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'm' || e.key === 'M') {
                setIsExpanded(prev => !prev);
            }
            if (isExpanded && e.key === 'Escape') {
                setIsExpanded(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isExpanded]);

    return (
        <div
            className={`fixed transition-all duration-300 z-[100] ${isExpanded ? 'inset-0 bg-black/80 flex items-center justify-center cursor-pointer' : 'top-14 left-6 cursor-pointer hover:scale-105'
                }`}
            style={isExpanded ? undefined : { width: MINI_SIZE, height: MINI_SIZE }}
            onClick={() => setIsExpanded(!isExpanded)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title={isExpanded ? 'Click to close map' : 'Click to view full map (or press M)'}
        >
            <canvas
                ref={canvasRef}
                className={isExpanded ? 'rounded-lg shadow-2xl border border-white/10' : 'rounded-full border-2 border-white/30 shadow-lg'}
            />
            {!isExpanded && (
                <div className={`absolute -bottom-5 w-full text-center text-[10px] font-bold uppercase tracking-widest transition-colors ${hovered ? 'text-white' : 'text-white/70'}`}>
                    <span ref={surfaceRef}>ROAD</span>
                </div>
            )}
            {isExpanded && (
                <button
                    className="absolute top-4 right-4 w-14 h-14 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center shadow-lg border-2 border-white/30 transition-all hover:scale-110 z-50"
                    onClick={(e) => {
                        e.stopPropagation();
                        setIsExpanded(false);
                    }}
                    title="Close map"
                >
                    <span className="text-white text-2xl font-bold">✕</span>
                </button>
            )}
        </div>
    );
}
