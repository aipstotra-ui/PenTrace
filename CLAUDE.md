# PenTrace — project map

Camera-based handwriting capture: laptop camera watches pen-on-paper writing and
reconstructs strokes digitally in real time. Vite + TypeScript, no framework.
App lives in `pentrace/`; this folder is also an Obsidian vault (ignore `.obsidian/`).

**Read this map first. Only open the file(s) relevant to the task — do not
explore the whole codebase.**

## Pages (Vite multi-page, see vite.config.ts)
- `index.html` + `src/landing.ts` — marketing landing (canvas mini-scenes)
- `pricing.html` + `src/pricing.ts` — pricing/waitlist (localStorage stub)
- `demo.html` + `src/main.ts` — the live capture demo
- `src/site.css` — shared styles; `src/reveal.ts` — shared scroll-reveal
- Design system: `pentrace/DESIGN.md` (Fraunces + IBM Plex, paper/ink/royal-blue)

## Capture pipeline (per frame, orchestrated by src/main.ts)
camera.ts → hand.ts (MediaPipe 21-pt) → pentip.ts (nib estimate + One Euro)
→ paper.ts (quad detect + homography → "page space", OpenCV.js)
→ inkdiff.ts (reference-image differencing → fresh ink px, every ~170ms)
→ strokes.ts (fusion: trail points commit only when confirmed by nearby ink)
→ page.ts (render) · recognition.ts (stub, Claude API later)

Support: types.ts (Pt/Stroke/luminance/dist) · cvready.ts (OpenCV load)
· debug.ts (overlays, FpsMeter) · synthetic.ts (no-camera test source).

## Core principle
Monocular tracking cannot tell pen-up from pen-down. The trail is provisional;
only ink evidence (inkdiff) commits strokes. Strict capture: never invent marks.

## Tuning constants — where they live
- inkdiff.ts: INK_THRESH 48 (above shadow ~25-50, below ink 100+),
  TIP_MASK_RADIUS 7 (nib-sized; 14 swallowed 4-5mm letters),
  MIN/MAX component size, PAPER_PRESENT_FRAC 0.45 (paper-gone watchdog)
- pentip.ts: PEN_MIN_CONTRAST 70 + PEN_MAX_DARK_SAMPLES 90 (bare hand ⇒ conf 0)
- main.ts: MIN_TIP_CONF 0.45 (real nib scores ≥0.5), PAPER_LOST_TICKS 3
- strokes.ts: MIN_STROKE_INK hard floor (no ink, no stroke), bridging/force-commit
- Page space ≈ 3.4 px/mm at full-frame A4 (PAGE_MAX_DIM 1000, paper.ts)

## Traps — do not relearn these the hard way
- opencv.js is a fake thenable: `await` on it recurses forever. cvready.ts
  handles it — never `await` the cv object directly.
- Hidden-tab throttling: main loop is paced by an inline Web Worker watchdog.
- The dense comments in inkdiff.ts/strokes.ts ARE the design record for every
  threshold. Do not strip or "simplify" them.
- paper.ts detect() returns `moved:false` when no quad found — it can NOT
  signal paper removal; that's why the paperFraction watchdog exists.
- IntersectionObserver reveals look blank in instant full-page screenshots;
  that's a tooling artifact, not a bug.

## Workflow
- Verify: `npx tsc --noEmit` in pentrace/; demo has a Synthetic source + HUD
  (fps, PEN yes/no, paper seen %) for camera-free testing.
- Deploy: push to main → Vercel auto-deploys https://pen-trace-1skd.vercel.app
  (private repo aipstotra-ui/PenTrace; Vercel root dir = `pentrace`).
- After nontrivial CV/tracking changes, run the `pentrace-code` reviewer agent.
