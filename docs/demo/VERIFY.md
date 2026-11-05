# Demo video verification (VIDEO_GUIDE checklist)

Video: `footnote-demo.mp4` (76.5 s, 1920x1080, 30 fps). Source: `hf/` (HyperFrames 0.9.14 composition, GSAP `fromTo` tweens,
coded cursor, click ripple, 1.3-1.45x zooms, captions). Frames are real 2x captures of the running app taken with ego-browser
(PayPal screens are real sandbox pages at 1x). Rebuild: `python3.11 hf/build_project.py && npx hyperframes render` (macOS, uses `say`).
Run the checks: `python3.11 hf/verify.py renderA.mp4 renderB.mp4`.

| # | Check | Result |
| - | ----- | ------ |
| 1 | Render twice identical | two renders: `ffmpeg psnr` average **inf**, md5 equal (`9b4a7eb7f49d42b07732cb976017eb51`) before the web-size re-encode |
| 2 | No 1-frame flashes | `hf/flicker.py` (A-B-A frame-diff detector, 2295 frames): **none**; largest jump 32.4 is a crossfade/cut, mean 0.46 |
| 3 | First 2 s understandable | frame at 0.0-2.0 s shows the real receipt with caption "One 50¢ answer -> 4 creators credited", narration starts at 0.35 s with the same sentence |
| 4 | Understandable muted | every shot carries a caption beside the object; the pipeline is readable from captions alone (list below) |
| 5 | Legible at phone size | captions 56 px on a 1920 px canvas; checked at 640x360 (see below) |
| 6 | Loudness -14..-16 LUFS | ebur128 integrated **-15.1 LUFS**, true peak -4.5 dBFS |
| 7 | Final scene has CTA | closing card: "Cite the footnote. Pay the footnote." + repository URL + "Open source, MIT"; narrated "Try it from the repository shown on screen" |
| 8 | Under the hackathon limit | **76.5 s** < 3 min |

Narration vs script (whisper.cpp **large-v3-turbo**, per scene, numbers and units normalised): **0 / 213 word errors (WER 0.0%)**.
Note: whole-file transcription once dropped sentences (a long-form whisper behaviour); the per-scene run on the same audio matches the script word for word.

## Sources of every number on screen
| Number | Source |
| ------ | ------ |
| "50¢ answer", "4 creators credited", "2 payouts SUCCESS" | **measured**: answer `a_aaef3c482f51` in the real sandbox run (`docs/evidence/real-ui-run-sandbox-success.txt`) |
| "$5.00 pack / credits" | **measured**: Orders v2 order 8A23630747124151V, COMPLETED |
| per-source $ amounts, shares, batch ids | **measured**: shown by the real app UI in the captured frames |
| everything else | no other numbers are shown |

## Captions (sound-off storyline)
1 One 50¢ answer -> 4 creators credited / 2 payouts reached SUCCESS · 2 AI answers use creators' work and pay nothing / Footnote: the fee is split by contribution ·
3 Buy credits with PayPal Checkout / Orders v2 · $5.00 pack / Real PayPal sandbox login / Sandbox buyer approves $5.00 / Captured: $5.00 in credits ·
4 Ask a question · 50¢ fee / Claude reads the creators' pages / Answer with inline [n] citations / Each source: share + one-line reason ·
5 Payee from a meta tag or JSON file / Hidden command stripped / Flagged, and the source is penalised ·
6 Claude agent calls PayPal Payouts / Agent picks who · code decides whether / Payout status: SUCCESS ·
7 Unclaimed creator -> money in escrow / No declaration yet: verify fails / Add one meta tag -> released to PayPal · 8 Open ledger: every cent tracked / CTA.

Known soft warnings from `hyperframes check` (craft): two captions are on screen ~1.4-1.6 s versus its 1.5-2.3 s reading-time heuristic.
