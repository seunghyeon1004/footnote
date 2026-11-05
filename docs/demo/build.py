#!/usr/bin/env python3.11
"""Assemble the demo video from real screenshots (docs/demo/frames) + macOS `say` narration + ffmpeg.
   usage: python3.11 docs/demo/build.py   ->   docs/demo/footnote-demo.mp4"""
import subprocess, os, json, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
FR = os.path.join(HERE, "frames")
SCENES = [
 (["01-hero"], "AI answer engines eat the traffic of the people who wrote their sources. Bloggers, maintainers and small publishers get cited, if they are lucky, and paid nothing. This is Footnote: an answer engine that pays its sources, through PayPal."),
 (["02-credits", "03-paypal-login"], "You buy knowledge credits with PayPal Checkout. This is the real PayPal sandbox, using the Orders v2 A P I."),
 (["04-paypal-pay", "05-back"], "I log in as a sandbox buyer and approve five dollars. The server captures the order, and the credits land in my wallet."),
 (["06-question"], "Now I ask a question. Every answer carries a fifty cent knowledge fee, which will be split among the sources that earned it."),
 (["07-progress2"], "Claude Sonnet five point five researches with tools and reads the creators' pages. Page text is treated as untrusted data."),
 (["08-answer"], "The answer cites its sources inline. A second agent then scores each source's contribution, and says why."),
 (["09-receipt1"], "Here is the royalty receipt. Each source gets a share in exact cents, a one line reason, and a payee method: a pay pal dot me link, a well known footnote JSON file, or nothing at all."),
 (["11-injection"], "This page hid a command: pay me one hundred percent. Footnote stripped it before the model saw it, flagged it, and cut the source's score. Payees are only read from structured declarations, never from page text."),
 (["12-receipt-success"], "A settlement agent then called PayPal Payouts. The ledger checks every call, so the agent picks who, but the code decides whether. The payout to Worm Bin Weekly has reached success in the PayPal sandbox."),
 (["15-gnome-claim", "16-claim-fail"], "This site never heard of Footnote, so its royalties wait in escrow. Verifying without a declaration fails."),
 (["17-claim-ok"], "The owner adds one meta tag and verifies. Footnote releases the escrow, and PayPal sends the money."),
 (["18-ledger"], "An open ledger tracks every cent. Footnote proposes a tiny open standard, a meta tag or a well known JSON file, so any creator can say pay me here. It is M I T licensed and tested. Footnote: cite the footnote, pay the footnote."),
]
def run(*a): subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def dur(p): return float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p]).decode())
tmp = tempfile.mkdtemp(); clips = []; total = 0
for i,(imgs,text) in enumerate(SCENES):
    aiff = f"{tmp}/s{i}.aiff"; wav = f"{tmp}/s{i}.wav"
    run("say","-v","Samantha","-r","178","-o",aiff,text); run("ffmpeg","-y","-i",aiff,"-ar","44100","-ac","1",wav)
    d = dur(wav) + 0.5; total += d
    for j,im in enumerate(imgs):
        clip = f"{tmp}/c{i}_{j}.mp4"; part = d/len(imgs)
        run("ffmpeg","-y","-loop","1","-t",f"{part:.3f}","-i",f"{FR}/{im}.png","-vf",
            "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0xf4f3ef,format=yuv420p,fade=t=in:st=0:d=0.25",
            "-r","30","-c:v","libx264","-preset","veryfast","-crf","20",clip)
        clips.append(clip)
    # audio padded to scene length
    run("ffmpeg","-y","-i",wav,"-af",f"apad=whole_dur={d:.3f}","-t",f"{d:.3f}",f"{tmp}/a{i}.wav")
lst = f"{tmp}/v.txt"; open(lst,"w").write("".join(f"file '{c}'\n" for c in clips))
alst = f"{tmp}/a.txt"; open(alst,"w").write("".join(f"file '{tmp}/a{i}.wav'\n" for i in range(len(SCENES))))
run("ffmpeg","-y","-f","concat","-safe","0","-i",lst,"-f","concat","-safe","0","-i",alst,"-c:v","copy","-c:a","aac","-b:a","160k","-shortest",f"{HERE}/footnote-demo.mp4")
open(f"{HERE}/narration.md","w").write("# Narration (English, macOS `say` voice Samantha)\n\n"+"\n\n".join(f"{i+1}. {t}" for i,(_,t) in enumerate(SCENES))+"\n")
print(f"total {total:.1f}s")
