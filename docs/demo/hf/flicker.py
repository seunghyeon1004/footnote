#!/usr/bin/env python3.11
"""1-frame flash detector: decode at 192x108 gray, flag frame i when frame i differs strongly from BOTH neighbours
while the neighbours match each other (A-B-A). Also reports the largest frame-to-frame jumps (cuts/crossfades are expected)."""
import subprocess, sys
import numpy as np
f = sys.argv[1]
W, H = 192, 108
raw = subprocess.run(["ffmpeg","-v","error","-i",f,"-vf",f"scale={W}:{H},format=gray","-f","rawvideo","-"],capture_output=True).stdout
fr = np.frombuffer(raw,dtype=np.uint8).reshape(-1,H,W).astype(np.int16)
d = np.abs(np.diff(fr,axis=0)).mean(axis=(1,2))            # d[i] = |f[i+1]-f[i]|
flash = []
for i in range(1,len(fr)-1):
    a = np.abs(fr[i-1]-fr[i+1]).mean()                      # neighbours similar?
    if d[i-1] > 6.0 and d[i] > 6.0 and a < 0.35*min(d[i-1], d[i]):
        flash.append(i)
print(f"frames={len(fr)} max_jump={d.max():.2f} mean_jump={d.mean():.3f}")
print("A-B-A one-frame flashes:", flash if flash else "none")
