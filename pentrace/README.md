# PenTrace

Write on real paper — your strokes appear on a digital page, live, through the laptop camera.

PenTrace watches the act of writing instead of photographing the result. That is the accuracy play: a photo of a finished page carries perspective, shadows and hand occlusion straight into OCR, while PenTrace reconstructs each stroke as it is made and hands the recognizer clean, uniform, timestamped ink.

## How it works — three fused layers

1. **Motion** — MediaPipe Hand Landmarker tracks the writing hand; the pen tip is estimated from the pinch grip, refined by finding the dark nib in a small patch (leading-side only, so fresh ink can't drag the estimate), and smoothed with a One Euro filter.
2. **Ink (ground truth)** — the paper is detected as the dominant bright quad and rectified by a locked homography into page space. A reference image of the "already-seen page" is diffed against each frame — masked by the hand hulls, forearm wedge, pen-barrel capsule and a disk around the nib — with two-tick persistence, exposure-gain normalization, and a shape gate that only passes thin, stroke-like components.
3. **Fusion** — the tracked trajectory is provisional; a trail point only commits when fresh ink appears beside it (snapped to the ink's centroid). Ink confirms pen-down — the classic monocular pen-up/pen-down ambiguity never has to be solved. Ink that no trail point claims is still stamped (orphan layer): nothing you wrote is dropped.

Recognition is a stub behind `RecognitionEngine` (`src/recognition.ts`); the next phase wires it to Claude vision, which currently leads handwriting benchmarks (~1.3% CER class) across diverse writing styles.

## Run it

```bash
npm install   # once; CV assets are vendored in public/
npm run dev   # http://localhost:5173
```

- **Start camera** — live capture from the laptop camera. Keep the sheet fully in frame; it locks when the blue quad appears.
- **Load video** — run the pipeline on a recorded clip.
- **Synthetic demo** — a simulated scene writes "hi" with real pen-up hops between strokes; verifies the whole pipeline (including false-stroke rejection) with no camera needed.
- Debug: rectified-page and fresh-ink views, HUD (fps, per-stage ms, stroke counts), overlay toggles, `?mp=off|cpu` to disable/soften hand tracking.

## Layout

```
src/main.ts        orchestration loop (worker-paced; survives hidden-tab throttling)
src/hand.ts        MediaPipe wrapper, dilated hand+forearm hulls
src/pentip.ts      pen-tip estimation + One Euro filter
src/paper.ts       quad detection, locked homography, rectification
src/inkdiff.ts     reference-image ink differencing + shape gate
src/strokes.ts     fusion: trail ↔ ink confirmation, stroke extraction
src/page.ts        digital page renderer / PNG export
src/recognition.ts RecognitionEngine seam (Claude vision next)
src/synthetic.ts   repeatable end-to-end test scene
src/cvready.ts     opencv.js loader (handles the Emscripten fake-thenable trap)
```

A project reviewer agent (`.claude/agents/pentrace-code.md`) critically reviews each build phase.
