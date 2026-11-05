#!/usr/bin/env python3.11
"""Generate the HyperFrames project (index.html + narration.wav) for the Footnote demo video.
All screens are real captures of the running app (assets/). Timings derive from the TTS durations."""
import subprocess, os, json, wave, math
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
REPO_URL = "github.com/seunghyeon1004/footnote"
GAP = 0.45      # crossfade overlap between scenes
PAD = 0.55      # tail after narration in each scene

# ---- script: each line is a complete sentence ------------------------------------------
SCENES = [
 dict(id="s1", say="One fifty cent answer just paid creators through PayPal. Four sources were credited, and two payouts already reached success.",
      shots=[dict(img="receipt1", w=1, zoom=(1.3, .5, .62), caps=[(0.25, "One 50¢ answer → **4 creators** credited", (190, 70)), (3.6, "**2** payouts reached SUCCESS (PayPal sandbox)", (190, 70))], tag="Real sandbox run · measured")]),
 dict(id="s2", say="AI answers lean on creators' work, and those creators earn nothing. Footnote adds a small knowledge fee to every answer, and splits it by contribution.",
      shots=[dict(img="hero0", w=1, zoom=(1.0, .5, .5), caps=[(0.3, "AI answers use creators' work and pay **nothing**", (190, 800)), (5.2, "Footnote: the fee is split by **contribution**", (190, 800))])]),
 dict(id="s3", say="Credits are bought with real PayPal Checkout, using the Orders A P I, version two, in the sandbox. A sandbox buyer logs in and approves five dollars, and the server captures the order.",
      shots=[dict(img="hero0", w=1.1, zoom=(1.0, .5, .5), cursor=(.889, .065, 0.9), caps=[(0.2, "Buy credits with **PayPal Checkout**", (190, 800))]),
             dict(img="credits", w=1.5, zoom=(1.0, .5, .5), cursor=(.5, .721, 1.1), caps=[(0.2, "Orders **v2** · $5.00 pack", (190, 90))]),
             dict(img="pp-login", w=1.0, zoom=(1.0, .5, .5), caps=[(0.1, "Real PayPal **sandbox** login", (190, 90))]),
             dict(img="pp-pay", w=1.0, zoom=(1.0, .5, .5), caps=[(0.1, "Sandbox buyer approves **$5.00**", (190, 90))]),
             dict(img="back", w=1.0, zoom=(1.0, .5, .5), caps=[(0.1, "Captured: **$5.00** in credits", (190, 800))], tag="Real sandbox run · measured")]),
 dict(id="s4", say="Claude researches with tools and cites its sources. A second agent then scores each source's contribution, and explains why.",
      shots=[dict(img="ask-filled", w=1.8, zoom=(1.0, .5, .5), caps=[(0.2, "Ask a question · **50¢** fee", (190, 90))]),
             dict(img="progress2", w=1.5, zoom=(1.0, .5, .5), caps=[(0.2, "Claude reads the **creators' pages**", (190, 700))]),
             dict(img="answer", w=1.5, zoom=(1.0, .5, .5), caps=[(0.2, "Answer with inline **[n]** citations", (190, 90))]),
             dict(img="receipt1", w=1.6, zoom=(1.45, .45, .35), caps=[(0.2, "Each source: share + **one-line reason**", (190, 800))])]),
 dict(id="s5", say="Creators declare a payee in a meta tag or a well known JSON file. When a page hides a command like pay me one hundred percent, Footnote strips it before the model sees it, flags it, and cuts that source's score.",
      shots=[dict(img="receipt1", w=1, zoom=(1.4, .35, .6), caps=[(0.2, "Payee from a **meta tag** or **JSON** file", (190, 70))]),
             dict(img="injection", w=1.35, zoom=(1.35, .4, .6), caps=[(0.2, "Hidden command **stripped**", (190, 70)), (4.4, "Flagged, and the source is **penalised**", (190, 70))])]),
 dict(id="s6", say="A settlement agent then calls PayPal Payouts. The ledger checks every call, so the agent chooses who to pay, and the code decides whether. These payouts reached success in the PayPal sandbox.",
      shots=[dict(img="receipt-foot", w=1.2, zoom=(1.35, .5, .72), caps=[(0.2, "Claude agent calls **PayPal Payouts**", (190, 70))]),
             dict(img="success", w=1.3, zoom=(1.3, .4, .25), caps=[(0.2, "Agent picks **who** · code decides **whether**", (190, 800))]),
             dict(img="worm-payouts", w=1.2, zoom=(1.3, .5, .35), caps=[(0.2, "Payout status: **SUCCESS**", (190, 800))], tag="PayPal sandbox · measured")]),
 dict(id="s7", say="Creators who never heard of Footnote are not left out. Their share waits in escrow until they add one meta tag and verify, and then PayPal pays them.",
      shots=[dict(img="gnome-before", w=1.3, zoom=(1.0, .5, .5), cursor=(.574, .783, 1.0), caps=[(0.2, "Unclaimed creator → money in **escrow**", (190, 70))]),
             dict(img="claim-fail", w=1.0, zoom=(1.3, .75, .85), caps=[(0.2, "No declaration yet: **verify fails**", (190, 70))]),
             dict(img="claim-ok", w=1.3, zoom=(1.3, .5, .8), caps=[(0.2, "Add one **meta tag** → released to PayPal", (190, 70))])]),
 dict(id="s8", say="Footnote is open source under the M I T license. Try it from the repository shown on screen.",
      shots=[dict(img="ledger", w=1.5, zoom=(1.0, .5, .5), caps=[(0.2, "Open ledger: every cent **tracked**", (190, 800))]),
             dict(img="cta", w=2.2, zoom=(1.0, .5, .5), caps=[])], final=True),
]

def run(*a, **k): subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **k)
def wav_dur(p):
    with wave.open(p) as w: return w.getnframes() / w.getframerate()

os.makedirs("tts", exist_ok=True)
t = 0.0
for i, s in enumerate(SCENES):
    aiff, wav = f"tts/{s['id']}.aiff", f"tts/{s['id']}.wav"
    if not os.path.exists(wav) or os.environ.get("REGEN_TTS"):
        run("say", "-v", "Samantha", "-r", "172", "-o", aiff, s["say"])
        run("ffmpeg", "-y", "-i", aiff, "-ar", "44100", "-ac", "1", "-sample_fmt", "s16", wav)
    s["narr"] = wav_dur(wav)
    s["start"] = t
    s["dur"] = s["narr"] + 0.35 + PAD            # narration starts 0.35 s into the scene
    t += s["dur"] - (GAP if i < len(SCENES) - 1 else 0)
TOTAL = SCENES[-1]["start"] + SCENES[-1]["dur"]

# narration mix: place each line at scene start + 0.35 s
inputs, filt = [], []
for i, s in enumerate(SCENES):
    inputs += ["-i", f"tts/{s['id']}.wav"]
    filt.append(f"[{i}:a]adelay={int((s['start']+0.35)*1000)}|{int((s['start']+0.35)*1000)}[a{i}]")
mix = ";".join(filt) + ";" + "".join(f"[a{i}]" for i in range(len(SCENES))) + f"amix=inputs={len(SCENES)}:normalize=0,apad=whole_dur={TOTAL:.3f},atrim=0:{TOTAL:.3f}[m]"
run("ffmpeg", "-y", *inputs, "-filter_complex", mix, "-map", "[m]", "-ar", "44100", "-ac", "1", "narration_raw.wav")
# loudness: target -15 LUFS integrated (two-pass loudnorm), true peak -1.5
import re
r = subprocess.run(["ffmpeg", "-i", "narration_raw.wav", "-af", "loudnorm=I=-15:TP=-1.5:LRA=7:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S).group(0))
run("ffmpeg", "-y", "-i", "narration_raw.wav", "-af",
    f"loudnorm=I=-15:TP=-1.5:LRA=7:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true",
    "-ar", "44100", "-ac", "1", "narration.wav")

# ---- html ------------------------------------------------------------------------------
WX, WY, WW, WH = 160, 22, 1600, 1037     # window rect (canvas px)
def hl(text):
    out, parts = [], text.split("**")
    for k, p in enumerate(parts): out.append(f"<b data-layout-allow-occlusion data-layout-allow-overflow>{p}</b>" if k % 2 else p)
    return "".join(out)

css = f"""
:root{{--ink:#101828;--paper:#f4f3ef;--blue:#0070e0;--navy:#0b1220;}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:1920px;height:1080px;background:var(--navy);overflow:hidden}}
#root{{position:relative;width:1920px;height:1080px;background:radial-gradient(1400px 900px at 50% 40%,#16233b 0%,#0b1220 70%)}}
.shot{{position:absolute;left:0;top:0;width:1920px;height:1080px}}
.win{{position:absolute;left:{WX}px;top:{WY}px;width:{WW}px;height:{WH}px;border-radius:14px;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);background:var(--paper)}}
.zoomer{{position:absolute;inset:0}}
.zoomer img{{width:100%;height:100%;display:block}}
.cap{{position:absolute;max-width:1320px;background:#fff;color:var(--ink);font:600 56px/1.2 Inter,system-ui,sans-serif;padding:16px 28px;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.35)}}
.cap b{{color:#fff;background:var(--blue);padding:0 10px;border-radius:8px;font-weight:700}}
.tag{{position:absolute;right:190px;bottom:44px;color:#fff;background:rgba(11,18,32,.92);padding:12px 20px;border-radius:10px;font:600 28px/1 Inter,system-ui,sans-serif;letter-spacing:.02em}}
.cursor{{position:absolute;left:0;top:0;width:44px;height:44px;margin:-4px 0 0 -4px}}
.ripple{{position:absolute;left:0;top:0;width:90px;height:90px;margin:-45px 0 0 -45px;border-radius:50%;border:5px solid var(--blue);background:rgba(0,112,224,.18)}}
.cta{{position:absolute;inset:0;background:radial-gradient(1200px 800px at 50% 45%,#16233b 0%,#0b1220 75%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;color:#fff;text-align:center;width:1920px;height:1080px}}
.cta .brand{{font:700 150px/1 'Playfair Display',Georgia,serif;letter-spacing:-.02em}}
.cta .brand sup{{font-size:60px;color:#6db3ff;margin-left:8px}}
.cta .line{{font:500 52px/1.2 'Playfair Display',Georgia,serif;color:#dfe8f7}}
.cta .url{{font:700 68px/1 Inter,system-ui,sans-serif;background:#fff;color:var(--ink);padding:22px 44px;border-radius:18px}}
.cta .sub{{font:500 30px/1 Inter,system-ui,sans-serif;color:#9fb2d0}}
"""
CURSOR_SVG = '<svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l7.2 18.2 2.6-7.3 7.3-2.6z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'

body, js, track = [], [], 0
n = 0
for si, s in enumerate(SCENES):
    wsum = sum(sh["w"] for sh in s["shots"])
    # shots tile the scene; each next shot overlaps the previous by 0.3 for a crossfade
    OV = 0.3
    span = s["dur"] + OV * (len(s["shots"]) - 1)
    cur = s["start"]
    for hi, sh in enumerate(s["shots"]):
        n += 1
        d = span * sh["w"] / wsum
        sid = f"sh{n}"
        track = 1 + (n % 2)
        z, ox, oy = sh["zoom"]
        parts = []
        if sh["img"] == "cta":
            parts.append(f'<div class="cta" id="{sid}-cta"><div class="brand">footnote<sup>[1]</sup></div><div class="line">Cite the footnote. Pay the footnote.</div><div class="url" id="{sid}-url">{REPO_URL}</div><div class="sub">Open source · MIT · Claude + PayPal</div></div>')
        else:
            parts.append(f'<div class="win"><div class="zoomer" data-layout-allow-overflow id="{sid}-z" style="transform-origin:{ox*100:.1f}% {oy*100:.1f}%"><div class="zoomer" data-layout-allow-overflow id="{sid}-z2" style="transform-origin:{ox*100:.1f}% {oy*100:.1f}%"><img src="assets/{sh["img"]}.png"/></div></div></div>')
        for ci, (ct, text, (cx, cy)) in enumerate(sh.get("caps", [])):
            parts.append(f'<div class="cap" data-layout-allow-occlusion data-layout-allow-overflow id="{sid}-c{ci}" style="left:{cx}px;top:{cy}px">{hl(text)}</div>')
        if sh.get("tag"): parts.append(f'<div class="tag" id="{sid}-tag">{sh["tag"]}</div>')
        if sh.get("cursor"):
            parts.append(f'<div class="ripple" id="{sid}-rip"></div><div id="{sid}-cur" style="position:absolute;left:0;top:0">{CURSOR_SVG}</div>')
        body.append(f'<div class="shot clip" id="{sid}" data-start="{cur:.3f}" data-duration="{d:.3f}" data-track-index="{track}" style="z-index:{n}">{"".join(parts)}</div>')
        # --- animation (explicit start values; entrances only; no exits except final scene) ---
        L = [] if n == 1 else [f'tl.fromTo("#{sid}",{{opacity:0}},{{opacity:1,duration:0.3,ease:"power1.out"}},{cur:.3f});']
        if sh["img"] != "cta" and z > 1.0:
            L.append(f'tl.fromTo("#{sid}-z",{{scale:1}},{{scale:{z},duration:{min(1.4, d*0.5):.2f},ease:"power2.inOut"}},{cur+0.5:.3f});')
            L.append(f'tl.fromTo("#{sid}-z2",{{scale:1}},{{scale:1.04,duration:{max(d-2.0,0.5):.2f},ease:"sine.inOut"}},{cur+1.95:.3f});')
        elif sh["img"] != "cta":
            L.append(f'tl.fromTo("#{sid}-z",{{scale:1.0}},{{scale:1.03,duration:{max(d-0.3,0.5):.2f},ease:"sine.inOut"}},{cur+0.1:.3f});')
        if sh["img"] == "cta":
            L.append(f'tl.fromTo("#{sid}-url",{{y:30,opacity:0}},{{y:0,opacity:1,duration:0.6,ease:"expo.out"}},{cur+0.9:.3f});')
            L.append(f'tl.fromTo("#{sid}-cta .brand",{{scale:0.94,opacity:0}},{{scale:1,opacity:1,duration:0.7,ease:"power3.out"}},{cur+0.3:.3f});') if False else None
        for ci, (ct, text, _) in enumerate(sh.get("caps", [])):
            ct = ct if (n == 1) else max(ct, 0.6)
            L.append(f'tl.fromTo("#{sid}-c{ci}",{{y:24,opacity:0}},{{y:0,opacity:1,duration:0.45,ease:"{["power3.out","back.out(1.4)","expo.out"][ci%3]}"}},{cur+ct:.3f});')
            if ci > 0:   # previous caption in same shot is replaced
                L.append(f'tl.to("#{sid}-c{ci-1}",{{opacity:0,duration:0.2,ease:"power1.in"}},{cur+ct-0.05:.3f});')
        if sh.get("tag"):
            L.append(f'tl.fromTo("#{sid}-tag",{{opacity:0}},{{opacity:1,duration:0.5,ease:"power1.out"}},{cur+0.6:.3f});')
        if sh.get("cursor"):
            fx, fy, tc = sh["cursor"]
            zf = z
            wx = ox * WW + (fx * WW - ox * WW) * zf
            wy = oy * WH + (fy * WH - oy * WH) * zf
            px, py = WX + wx, WY + wy
            sx, sy = px + 260, py + 180
            t0 = cur + max(0.3, tc - 0.75) ; t1 = cur + tc
            L.append(f'tl.fromTo("#{sid}-cur",{{x:{sx:.0f},y:{sy:.0f},opacity:0}},{{x:{px:.0f},y:{py:.0f},opacity:1,duration:{t1-t0:.2f},ease:"power2.inOut"}},{t0:.3f});')
            L.append(f'tl.fromTo("#{sid}-cur",{{scale:1}},{{scale:0.86,duration:0.12,ease:"power1.in"}},{t1+0.15:.3f});')
            L.append(f'tl.fromTo("#{sid}-rip",{{x:{px:.0f},y:{py:.0f},scale:0.2,opacity:0.9}},{{x:{px:.0f},y:{py:.0f},scale:1.5,opacity:0,duration:0.7,ease:"power2.out"}},{t1+0.15:.3f});')
        js += [l for l in L if l]
        cur += d - OV
    if s.get("final"):
        pass

html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Footnote demo</title>
<style>{css}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL:.3f}" data-width="1920" data-height="1080">
{chr(10).join(body)}
<audio id="narr" src="narration.wav" data-start="0" data-duration="{TOTAL:.3f}" data-track-index="0" data-volume="0.7"></audio>
</div>
<script src="gsap.min.js"></script>
<script>
window.__timelines = window.__timelines || {{}};
const tl = gsap.timeline({{ paused: true }});
{chr(10).join(js)}
window.__timelines["main"] = tl;
</script>
</body></html>
"""
open("index.html", "w").write(html)
json.dump({"total": TOTAL, "scenes": [{k: s[k] for k in ("id", "say", "start", "dur", "narr")} for s in SCENES]}, open("timing.json", "w"), indent=1)
print(f"total {TOTAL:.1f}s, loudnorm in={m['input_i']}")
