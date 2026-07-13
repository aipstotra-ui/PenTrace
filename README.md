# PenTrace

Camera-based handwriting capture for students. PenTrace watches you write on real
paper through the laptop camera and reconstructs your notes digitally in real time —
then makes them AI-checkable.

## Repository layout

```
pentrace/            The product — Vite + TypeScript
  index.html         Landing page (marketing)
  demo.html          Live tracking demo (the capture engine)
  pricing.html       Pricing / early-access waitlist
  src/               Capture pipeline + site scripts
  public/vendor/     Vendored OpenCV.js + MediaPipe WASM (no CDN at runtime)
  public/models/     MediaPipe hand-landmark model
  DESIGN.md          Design system (light / academic)
  README.md          Engine architecture + how to run
.claude/
  agents/            pentrace-code — the read-only CV/tracking code reviewer
  launch.json        Dev-server config for browser-pane verification
```

## Run it

```bash
npm install --prefix pentrace
npm run dev --prefix pentrace
# open http://localhost:5173
```

- **Home** — the landing page
- **Live demo** — click **Synthetic demo** (no camera needed) or **Start camera**,
  put a white sheet in view, wait for the blue lock, and write with a dark pen
- **Pricing** — the coming-soon waitlist

## How the capture works

Two independent signals, fused: MediaPipe pen-tip tracking (motion) and
differential ink extraction from a rectified top-down view of the page (ground
truth). A stroke commits only where tracked motion and fresh ink agree — which
sidesteps the monocular pen-up/pen-down ambiguity that defeats pure tracking.
See [pentrace/README.md](pentrace/README.md) for the full architecture.

Recognition is stubbed behind a clean interface; Claude vision is the next phase.
