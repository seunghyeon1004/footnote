#!/usr/bin/env python3.11
"""Verification pack: determinism, flicker, loudness, duration, narration vs script (whisper.cpp large-v3-turbo, per scene)."""
import json, subprocess, re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
A, B = sys.argv[1], sys.argv[2]
MODEL = os.environ.get("WHISPER_MODEL", "/tmp/models/ggml-large-v3-turbo.bin")
sh = lambda *a: subprocess.run(a, capture_output=True, text=True)
print("psnr:", re.search(r"average:\S+", sh("ffmpeg","-i",A,"-i",B,"-lavfi","[0:v][1:v]psnr","-f","null","-").stderr).group(0))
print("md5 equal:", sh("md5","-q",A).stdout == sh("md5","-q",B).stdout)
print(sh("python3.11","flicker.py",A).stdout.strip())
l = sh("ffmpeg","-i",A,"-af","ebur128=peak=true","-f","null","-").stderr
print("LUFS integrated:", re.findall(r"I:\s+(-?[\d.]+) LUFS", l)[-1], "| true peak dBFS:", re.findall(r"Peak:\s+(-?[\d.]+) dBFS", l)[-1])
print("duration s:", sh("ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",A).stdout.strip())
NUM = {"50":"fifty","100":"one hundred","2":"two","4":"four","5":"five","1004":"one thousand four"}
def norm(t):
    t = t.lower().replace("$5","five dollars").replace("50-cent","fifty cent").replace("100%","one hundred percent").replace("m i t","mit").replace("a p i","api").replace("version 2","version two").replace("well-known","well known")
    t = re.sub(r"[^a-z0-9 ]"," ",t); return [NUM.get(w,w) for w in t.split()]
def wer(r, h):
    d = list(range(len(h)+1))
    for i in range(1,len(r)+1):
        p, d[0] = d[0], i
        for j in range(1,len(h)+1):
            p, d[j] = d[j], min(d[j]+1, d[j-1]+1, p+(r[i-1]!=h[j-1]))
    return d[len(h)]
T = json.load(open("timing.json")); err = tot = 0
for s in T["scenes"]:
    w = f"/tmp/fn/sc_{s['id']}.wav"
    sh("ffmpeg","-y","-v","error","-i",A,"-ss",str(s["start"]+0.2),"-t",str(s["narr"]+0.6),"-vn","-ar","16000","-ac","1",w)
    hyp = " ".join(sh("whisper-cli","-m",MODEL,"-f",w,"-l","en","-nt","-np").stdout.split())
    r, h = norm(s["say"]), norm(hyp); e = wer(r, h); err += e; tot += len(r)
    print(f"{s['id']}: word errors {e}/{len(r)}\n   HYP: {hyp}")
print(f"WER (numbers/units normalised): {err}/{tot} = {100*err/tot:.1f}%")
