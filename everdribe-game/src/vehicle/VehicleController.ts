import { AudioManager } from '../audio/AudioManager';
import { useGameStore } from '../stores/gameStore';

export interface InputState {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    brake: boolean;
    reset: boolean;
    boost: boolean;
    horn: boolean;
}

export class VehicleController {
    public input: InputState = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        brake: false,
        reset: false,
        boost: false,
        horn: false,
    };

    // Free look mouse sensitivity
    private mouseSensitivity: number = 0.003;

    // Listeners are attached by attach(), called from a React effect. Doing it in the constructor
    // leaked a second set of listeners under StrictMode (which builds useMemo values twice),
    // so one key press was handled twice: the camera skipped a mode on every press of C.

    // Keys held right now, by code. The driving flags are worked out from this set, so holding both S and ↓
    // and letting go of one keeps the car braking, and clearing the set can never leave a flag stuck.
    private held = new Set<string>();

    private syncInput() {
        const h = this.held;
        this.input.forward = h.has('KeyW') || h.has('ArrowUp');
        this.input.backward = h.has('KeyS') || h.has('ArrowDown');
        this.input.left = h.has('KeyA') || h.has('ArrowLeft');
        this.input.right = h.has('KeyD') || h.has('ArrowRight');
        this.input.brake = h.has('Space');
        this.input.boost = h.has('ShiftLeft') || h.has('ShiftRight');
        this.input.horn = h.has('KeyH');
    }

    /**
     * Let go of every key. A key released while the page does not have focus (a click outside the game,
     * another app or tab) never sends a key-up, so without this the car kept reversing on its own after
     * S, and W did nothing because the game saw W + S together.
     */
    private releaseAll = () => {
        this.held.clear();
        this.input.reset = false;
        this.syncInput();
    };

    private onVisibility = () => { if (document.hidden) this.releaseAll(); };

    private onKeyDown = (event: KeyboardEvent) => {
        // Resume audio context on user interaction
        AudioManager.getInstance().resume();

        // With Cmd or Ctrl held, macOS sends no key-up for the letter, so a shortcut must not press a pedal
        if (event.metaKey || event.ctrlKey) return;

        switch (event.code) {
            case 'KeyR':
                this.input.reset = true;
                break;
            case 'KeyC':
                // Cycle the point of view: Chase, Far Chase, Hood, Cockpit, Drone
                if (!event.repeat) useGameStore.getState().cycleCameraMode();
                break;
            case 'Escape':
            case 'KeyP':
                if (!event.repeat) {
                    useGameStore.getState().togglePause();
                    this.releaseAll();
                }
                break;
            default:
                this.held.add(event.code);
                this.syncInput();
        }
    };

    private onKeyUp = (event: KeyboardEvent) => {
        // Letting go of Cmd or Ctrl ends a shortcut; the letter's own key-up may never come
        if (event.key === 'Meta' || event.key === 'Control') { this.releaseAll(); return; }
        if (event.code === 'KeyR') this.input.reset = false;
        this.held.delete(event.code);
        this.syncInput();
    };

    private onMouseDown = (event: MouseEvent) => {
        // Button 0 (Left) or Button 2 (Right) - always activate free look for rotation
        // This handles users who might confuse buttons or prefer left-click drag
        if (event.button === 0 || event.button === 2) {
            const store = useGameStore.getState();
            store.setFreeLookActive(true);
        }
        // Middle mouse button (button 1) - reset camera angle
        if (event.button === 1) {
            const store = useGameStore.getState();
            store.resetFreeLookAngles();
        }
    };

    private onMouseUp = (event: MouseEvent) => {
        // Check for Left (0) or Right (2) release
        if (event.button === 0 || event.button === 2) {
            const store = useGameStore.getState();
            store.setFreeLookActive(false);
            // If eye button is NOT active, reset angles on release
            // If eye button IS active, keep the angles (persistent camera)
            if (!store.isFreeLookButtonActive) {
                store.resetFreeLookAngles();
            }
        }
    };

    private onMouseMove = (event: MouseEvent) => {
        const store = useGameStore.getState();

        // Only update angles if free look is active
        if (store.isFreeLookActive) {
            const deltaX = event.movementX * this.mouseSensitivity;
            const deltaY = -event.movementY * this.mouseSensitivity;
            store.updateFreeLookAngles(deltaX, deltaY);
        }
    };

    private onContextMenu = (event: MouseEvent) => {
        // Prevent context menu when right-clicking for camera rotation
        event.preventDefault();
    };

    private onWheel = (event: WheelEvent) => {
        const store = useGameStore.getState();
        // Zoom only while driving and only over the 3D view. Over a menu the wheel must scroll the menu:
        // this listener sits on the whole window, so it used to zoom the camera far out and block scrolling.
        if (store.phase !== 'driving' || !(event.target instanceof HTMLCanvasElement)) return;
        // Use scroll to zoom in/out
        // deltaY > 0 means scrolling down (zoom out), deltaY < 0 means scrolling up (zoom in)
        const zoomDelta = event.deltaY * 0.005; // Sensitivity factor
        store.updateCameraZoom(zoomDelta);
        event.preventDefault();
    };

    public attach() {
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('mousedown', this.onMouseDown);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('contextmenu', this.onContextMenu);
        window.addEventListener('wheel', this.onWheel, { passive: false });
        window.addEventListener('blur', this.releaseAll);
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    public dispose() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('mousedown', this.onMouseDown);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('contextmenu', this.onContextMenu);
        window.removeEventListener('wheel', this.onWheel);
        window.removeEventListener('blur', this.releaseAll);
        document.removeEventListener('visibilitychange', this.onVisibility);
    }
}
