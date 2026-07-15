#!/usr/bin/env python3
"""
Periodicity-grid loop extender v4 — adds RMS-sustain requirements so loop
points can never sit next to a breakdown/hole (the v3 industrialtechno bug):
  in-point : strong on-grid onset whose FOLLOWING 1.5s stays >= medianRMS-5dB
  out-point: strong on-grid onset whose PRECEDING 1.5s stays >= medianRMS-5dB
  body     : m grid pulses, m % 8 == 0 (fallback m % 4), maximized.
Seams land exactly on attacks; 8ms equal-power microfades. Head = natural
intro, tail = natural outro.

Usage: looper4.py <in.wav> <out.wav> [target_sec]
"""
import sys, json
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt


def main():
    inp, outp = sys.argv[1], sys.argv[2]
    target = float(sys.argv[3]) if len(sys.argv) > 3 else 72.0
    sr, d = wavfile.read(inp)
    stereo = d.ndim == 2
    xf = d.astype(np.float64) / 32768.0
    mono = xf.mean(axis=1) if stereo else xf
    N = len(mono)

    hop = 256
    sos = butter(2, 150, "low", fs=sr, output="sos")
    low = sosfilt(sos, mono)
    n = N // hop
    e = np.sqrt(np.convolve(low ** 2, np.ones(hop) / hop, "same"))[::hop][:n]
    O = np.maximum(0, np.diff(e, prepend=e[0]))
    fps = sr / hop

    # RMS profile (50ms hop, 250ms window) in dB
    wr = int(0.25 * sr)
    hr = int(0.05 * sr)
    nr = (N - wr) // hr
    rms = np.array([np.sqrt(np.mean(mono[i * hr:i * hr + wr] ** 2)) for i in range(nr)])
    rms_db = 20 * np.log10(np.maximum(rms, 1e-9))
    mid = rms_db[int(0.1 * nr):int(0.9 * nr)]
    medR = np.median(mid)

    def min_rms_db(t0, t1):
        a = max(0, int(t0 * sr / hr))
        b = min(nr - 1, int(t1 * sr / hr))
        if b <= a:
            return -99.0
        return float(rms_db[a:b].min())

    # dominant period + phase
    lag_min, lag_max = int(0.2 * fps), int(1.2 * fps)
    ac = np.array([np.dot(O[l:], O[:-l]) for l in range(lag_min, lag_max)])
    i = int(np.argmax(ac))
    P = lag_min + i
    if 0 < i < len(ac) - 1:
        a, b, c = ac[i - 1], ac[i], ac[i + 1]
        den = a - 2 * b + c
        if den != 0:
            P = lag_min + i + max(-0.5, min(0.5, 0.5 * (a - c) / den))
    best_phi, best_s = 0.0, -1
    for p in range(64):
        phi = p / 64 * P
        idx = np.arange(phi, n - 1, P).astype(int)
        s = O[idx].sum()
        if s > best_s:
            best_s, best_phi = s, phi

    grid = np.arange(best_phi, n - 1, P)
    strength = O[grid.astype(int)]
    s60 = np.percentile(strength, 60)
    s50 = np.percentile(strength, 50)
    dur = N / sr
    sustain = 1.5
    floor = medR - 5

    in_cands = [k for k, f in enumerate(grid)
                if 1 * fps <= f <= 14 * fps
                and strength[k] >= s60
                and min_rms_db(f / fps, f / fps + sustain) >= floor]
    if not in_cands:
        raise SystemExit("no sustained in-point found")

    best = None  # (body_len, k_in, k_out)
    for k_in in in_cands:
        t_in = grid[k_in] / fps
        for mod in (8, 4):
            k = k_in + ((len(grid) - 1 - k_in) // mod) * mod
            while k > k_in:
                t_out = grid[k] / fps
                if t_out <= dur - 0.5 and strength[k] >= s50 \
                   and min_rms_db(t_out - sustain, t_out) >= floor:
                    cand = (t_out - t_in, k_in, k, mod)
                    if not best or cand[0] > best[0]:
                        best = cand
                    break
                k -= mod
            if best and best[1] == k_in:
                break
    if not best:
        raise SystemExit("no usable loop pair")
    _, k_in, k_out, mod = best
    s_in = int(grid[k_in] / fps * sr)
    s_out = int(grid[k_out] / fps * sr)
    body = xf[s_in:s_out]
    head = xf[:s_in]
    tail = xf[s_out:]

    fade = int(0.008 * sr)
    fo = np.sqrt(np.linspace(1, 0, fade))
    fi = np.sqrt(np.linspace(0, 1, fade))
    if stereo:
        fo, fi = fo[:, None], fi[:, None]

    def splice(A, B):
        seam = A[-fade:] * fo + B[:fade] * fi
        return np.concatenate([A[:-fade], seam, B[fade:]])

    out = np.concatenate([head, body]) if len(head) else body.copy()
    seams = [len(out) / sr]
    while (len(out) + len(tail)) / sr < target:
        out = splice(out, body)
        seams.append(len(out) / sr)
    if len(tail) > fade:
        out = splice(out, tail)

    peak = np.max(np.abs(out))
    if peak > 0.985:
        out *= 0.985 / peak
    wavfile.write(outp, sr, np.clip(out * 32768, -32768, 32767).astype(np.int16))
    print(json.dumps({
        "period_s": round(P / fps, 4),
        "loop_in_s": round(s_in / sr, 3), "loop_out_s": round(s_out / sr, 3),
        "body_pulses": k_out - k_in, "pulse_mod": mod,
        "body_sec": round((s_out - s_in) / sr, 3),
        "seam_positions_s": [round(s, 2) for s in seams[:-1]],
        "total_sec": round(len(out) / sr, 2), "median_rms_db": round(float(medR), 1)
    }))


if __name__ == "__main__":
    main()
