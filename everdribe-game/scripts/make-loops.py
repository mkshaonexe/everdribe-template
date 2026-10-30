"""Turn generated sound clips into game-ready files.

Loops: take a steady stretch from the middle of a clip, cross-fade its tail into its head so it
repeats without a click, and set its loudness. One-shots: trim silence and set loudness.
Also prints the strongest low frequency of each engine loop, used to match engine pitch to rpm.
Needs ffmpeg on PATH.
"""
import subprocess, sys, json, os
import numpy as np

SR = 44100
SRC = sys.argv[1]      # folder with generated clips
DST = sys.argv[2]      # game audio folder


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def save(path, x):
    x = np.clip(x, -1, 1)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
                    '-c:a', 'pcm_s16le', path], input=x.astype(np.float32).tobytes(), check=True)


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)


def set_level(x, target_db, peak=0.7):
    x = x * 10 ** ((target_db - rms_db(x)) / 20)
    p = np.max(np.abs(x))
    return x * (peak / p) if p > peak else x


def make_loop(x, start, length, fade=0.35):
    a, n, f = int(start * SR), int(length * SR), int(fade * SR)
    seg = x[a:a + n + f].copy()
    head, tail = seg[:f], seg[n:n + f]
    t = np.linspace(0, 1, f)
    # Equal-power cross-fade of the tail into the head
    seg[:f] = head * np.sin(t * np.pi / 2) + tail * np.cos(t * np.pi / 2)
    return seg[:n]


def trim(x, thresh=0.01):
    idx = np.where(np.abs(x) > thresh * np.max(np.abs(x)))[0]
    return x[max(0, idx[0] - 200): idx[-1] + 2000] if len(idx) else x


def fundamental(x):
    seg = x[: SR * 2]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / SR)
    band = (freqs > 25) & (freqs < 400)
    return float(freqs[band][np.argmax(spec[band])])


info = {}
loops = {
    'engine-idle': ('engine-idle.wav', 2.0, 4.0, -18),
    'engine-mid': ('engine-mid.wav', 3.0, 4.0, -18),
    'engine-high': ('engine-high.wav', 3.0, 4.0, -18),
    'skid': ('skid-mirelo.mp3', 1.0, 3.5, -20),
    'gravel': ('gravel.wav', 3.0, 5.0, -22),
    'wind': ('wind.wav', 3.0, 6.0, -24),
    'ambience': ('ambience.wav', 2.0, 12.0, -30),
}
for name, (src, start, length, level) in loops.items():
    if not os.path.exists(f'{SRC}/{src}'):
        continue
    x = load(f'{SRC}/{src}')
    length = min(length, len(x) / SR - start - 0.5)
    loop = set_level(make_loop(x, start, length), level)
    save(f'{DST}/{name}.wav', loop)
    info[name] = {'seconds': round(len(loop) / SR, 2)}
    if name.startswith('engine'):
        info[name]['peakHz'] = round(fundamental(loop), 1)

shots = {'bump': ('bump.wav', -16), 'click': ('ui-click.wav', -22)}
for name, (src, level) in shots.items():
    if not os.path.exists(f'{SRC}/{src}'):
        continue
    x = trim(load(f'{SRC}/{src}'))
    save(f'{DST}/{name}.wav', set_level(x, level, peak=0.85))
    info[name] = {'seconds': round(len(x) / SR, 2)}

print(json.dumps(info, indent=1))
