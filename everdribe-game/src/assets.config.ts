/**
 * The knobs for the game's asset files, in one place. The game runs with `public/assets/` empty (it builds
 * stand-ins in code) and picks up any file listed in ASSETS.md once it is there (refresh the page).
 */

export const CAR = {
    /** The car model, relative to `public/`. Missing → a blue coupe built in code (vehicle/ProceduralCar.ts). */
    file: 'assets/models/car-a.glb',
    /** Name and dot colour in the Garage and the menu note. */
    name: 'Verde GT',
    accent: '#1f8f6a',
    /**
     * Auto-fit for any car GLB (for example one you generate yourself): the model is turned by `yawDegrees`,
     * scaled so its longest side is `targetLength` metres, centred, and lifted so its lowest point sits at
     * `yOffset` metres (the tyres touch the road at 0). The defaults fit the original car-a.glb exactly.
     */
    targetLength: 4.75,
    /**
     * Extra turn around the vertical axis, in degrees. The game drives towards -Z; a model whose nose
     * points down +X needs 90 (the original). Try 0, 90, 180 or -90 if your car drives backwards or sideways.
     */
    yawDegrees: 90,
    yOffset: -0.02,
    /**
     * Optional paint colour, e.g. '#c0392b'. For a GLB it recolours the painted (saturated) parts of the
     * body; null keeps the model's own colours. The built-in coupe uses `fallbackColor` when this is null.
     */
    paintColor: null as string | null,
    fallbackColor: '#1f5fd1',
};
