"""
Turn the raw Higgsfield sound effects (resources/higgsfield/audio/*.mp3) into game-ready WAVs
(everdribe-game/public/assets/audio/). One-shots are cut so the hit starts at 0 ms (no late crash),
faded out and levelled; loops are cut from the steady middle and cross-faded so they repeat without a click.

    python3 scripts/prepare-sfx.py
"""
import subprocess, wave, pathlib
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'resources/higgsfield/audio'
DST = ROOT / 'everdribe-game/public/assets/audio'
SR = 44100

# name: (kind, length in s, peak or RMS target in dBFS)
ONE_SHOTS = {
    'rail-hit-hard': (1.6, -3), 'rail-hit-soft': (0.9, -6),
    'tree-hit-hard': (1.6, -3), 'tree-hit-soft': (1.0, -6),
    'pine-hit': (1.6, -4), 'birch-hit': (1.0, -4),
    'rock-hit': (1.2, -4), 'crash-heavy': (1.8, -2),
    'land-hard': (1.0, -4), 'land-soft': (0.6, -8),
    'splash': (2.2, -4),
}
LOOPS = {  # (start s, length s, RMS dBFS)
    'rail-scrape': (0.5, 2.0, -18), 'tree-scrape': (1.0, 1.8, -20),
    'grass-roll': (0.4, 2.2, -20), 'dirt-roll': (0.4, 2.2, -20),
    'horn': (0.15, 1.6, -14),
}


def load(name):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(SRC / f'{name}.mp3'), '-ac', '1', '-ar', str(SR),
                          '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def save(name, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(str(DST / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def onset(x):
    """First 5 ms window within 20 dB of the loudest one: where the hit really starts."""
    win = int(SR * 0.005)
    env = np.sqrt(np.convolve(x * x, np.ones(win) / win, mode='same'))
    return max(0, int(np.argmax(env > env.max() * 0.1)) - int(SR * 0.004))


DST.mkdir(parents=True, exist_ok=True)

for name, (length, peak_db) in ONE_SHOTS.items():
    if not (SRC / f'{name}.mp3').exists():
        continue
    x = load(name)
    x = x[onset(x):][:int(length * SR)]
    n = len(x)
    fade_in = np.minimum(1, np.arange(n) / (SR * 0.002))
    tail = np.clip((n - np.arange(n)) / (n * 0.45), 0, 1) ** 2   # last ~45 % fades away
    x = x * fade_in * tail
    x *= 10 ** (peak_db / 20) / np.abs(x).max()
    save(name, x)
    print(f'{name:14s} {n / SR:.2f} s, onset cut')

for name, (start, length, rms_db) in LOOPS.items():
    if not (SRC / f'{name}.mp3').exists():
        continue
    x = load(name)
    xf = int(SR * 0.25)
    a = int(start * SR); n = int(length * SR)
    body = x[a:a + n].copy()
    tail = x[a + n:a + n + xf]
    ramp = np.linspace(0, 1, len(tail))
    # Equal-power cross-fade of the bit after the loop into its start
    body[:len(tail)] = body[:len(tail)] * np.sqrt(ramp) + tail * np.sqrt(1 - ramp)
    body *= 10 ** (rms_db / 20) / np.sqrt(np.mean(body ** 2))
    body = np.clip(body, -0.98, 0.98)
    save(name, body)
    print(f'{name:14s} {n / SR:.2f} s loop')
