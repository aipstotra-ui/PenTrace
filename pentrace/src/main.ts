import { openCamera, openVideoFile } from './camera';
import { waitForOpenCV } from './cvready';
import { FpsMeter, drawHand, drawQuad, drawTip } from './debug';
import { HandTracker } from './hand';
import type { HandResult } from './hand';
import { INDEX_MCP, INDEX_TIP, THUMB_TIP, WRIST } from './hand';
import { InkDiff, PAPER_PRESENT_FRAC, TIP_MASK_RADIUS } from './inkdiff';
import { PageRenderer } from './page';
import { PaperTracker } from './paper';
import { PenTipEstimator } from './pentip';
import type { PenTipResult } from './pentip';
import { StubEngine } from './recognition';
import { StrokeStore } from './strokes';
import { SyntheticSource } from './synthetic';
import type { FrameSource, Pt, Quad } from './types';
import { dist } from './types';

// ---- cadences (milliseconds — rAF rate varies with the display, 60–120Hz,
// so frame-count cadences would change detection behavior per monitor) ----
const PAPER_SEARCH_MS = 330; // while unlocked
const PAPER_WATCH_MS = 1500; // while locked, cheap moved-check
const INK_MS = 170; // two-tick ink persistence ⇒ ~340ms confirm latency
const HUD_MS = 170;
const MOVED_CHECKS_TO_RELOCK = 2; // consecutive, avoids relock on occlusion flukes
const DETECT_W = 320;
// Only a genuinely detected nib may drive the trail. refineDarkTip scores a
// real nib >= 0.5 and everything else 0, so this gate is what stops a bare
// hand (or a hand whose pen is out of view) from generating phantom strokes.
const MIN_TIP_CONF = 0.45;
// Consecutive ink ticks of "the page doesn't look like paper any more" before
// we drop the lock. ~3 x 170ms ≈ 0.5s: fast enough that lifting the sheet
// stops capture immediately, slow enough to ride out a flicker.
const PAPER_LOST_TICKS = 3;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  video: $<HTMLVideoElement>('video'),
  camera: $<HTMLCanvasElement>('cameraCanvas'),
  rectified: $<HTMLCanvasElement>('rectifiedCanvas'),
  inkDiff: $<HTMLCanvasElement>('inkDiffCanvas'),
  page: $<HTMLCanvasElement>('pageCanvas'),
  hud: $<HTMLDivElement>('hud'),
  status: $<HTMLSpanElement>('status'),
  recognizeOut: $<HTMLDivElement>('recognizeOut'),
  btnCamera: $<HTMLButtonElement>('btnCamera'),
  fileVideo: $<HTMLInputElement>('fileVideo'),
  btnSynthetic: $<HTMLButtonElement>('btnSynthetic'),
  btnRelock: $<HTMLButtonElement>('btnRelock'),
  btnClear: $<HTMLButtonElement>('btnClear'),
  btnExport: $<HTMLButtonElement>('btnExport'),
  btnRecognize: $<HTMLButtonElement>('btnRecognize'),
  tglLandmarks: $<HTMLInputElement>('tglLandmarks'),
  tglQuad: $<HTMLInputElement>('tglQuad'),
  tglTip: $<HTMLInputElement>('tglTip'),
  tglTrail: $<HTMLInputElement>('tglTrail'),
};

const cameraCtx = els.camera.getContext('2d', { willReadFrequently: true })!;
const smallCanvas = document.createElement('canvas');
const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true })!;
const rectifiedScratch = document.createElement('canvas');
const inkDiffScratch = document.createElement('canvas');

const paper = new PaperTracker();
const pentip = new PenTipEstimator();
const ink = new InkDiff();
const store = new StrokeStore();
const page = new PageRenderer(els.page);
const engine = new StubEngine();
const fps = new FpsMeter();

// ?mp=off skips hand tracking entirely (synthetic still works via
// tipOverride); ?mp=cpu forces the CPU delegate. Debug/rescue switches.
const mpMode = new URLSearchParams(location.search).get('mp') ?? 'gpu';

let handTracker: HandTracker | null = null;
let source: FrameSource | null = null;
let movedStreak = 0;
let lastVideoTime = -1;
let nextPaperMs = 0;
let nextInkMs = 0;
let nextHudMs = 0;
let lastFreshCount = 0;
let lostStreak = 0;
let lastPaperFrac = 1;
let lastTipVideo: Pt | null = null;
let lastTipSeenMs = 0;
let lastPinchVideo: Pt | null = null;
let videoEndedNotified = false;
let newVideoFrame = false;
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const stageMs = { draw: 0, hand: 0, paper: 0, ink: 0, render: 0 };

/** Re-arm per frame: rVFC fires once per delivered camera/video frame. */
function armFrameCallback(): void {
  if (!hasRVFC || !source || source.kind === 'synthetic') return;
  (els.video as any).requestVideoFrameCallback(() => {
    newVideoFrame = true;
    armFrameCallback();
  });
}
let loopHandle = 0;
let loopPending = false;

/**
 * Loop driver. rAF alone is not enough: hidden/occluded pages get rAF
 * suspended entirely and main-thread setTimeout clamped to 1s (measured:
 * the whole pipeline ran at 1 fps with every stage <30ms). Worker timers
 * are exempt from hidden-page throttling, so a tiny inline worker paces
 * the loop at ~30Hz whenever rAF isn't firing — capture keeps running
 * even if the user switches tabs mid-session.
 */
const pacerUrl = URL.createObjectURL(
  new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }),
);
const pacer = new Worker(pacerUrl);
URL.revokeObjectURL(pacerUrl); // worker is already instantiated
let lastLoopRun = 0;
pacer.onmessage = () => {
  // Watchdog only: fire when rAF is genuinely stalled (hidden/occluded
  // page), never preempt a healthy rAF — and if a loop iteration overruns,
  // back off instead of running back-to-back at 100% CPU.
  const stalled = document.hidden || performance.now() - lastLoopRun > 80;
  if (loopPending && stalled) {
    loopPending = false;
    cancelAnimationFrame(loopHandle);
    loop();
  }
};

function scheduleLoop(): void {
  loopPending = true;
  loopHandle = requestAnimationFrame(() => {
    if (loopPending) {
      loopPending = false;
      loop();
    }
  });
}

function stopLoop(): void {
  loopPending = false;
  cancelAnimationFrame(loopHandle);
}

function setStatus(msg: string, ok = false): void {
  els.status.textContent = msg;
  els.status.className = ok ? 'ok' : '';
}

async function init(): Promise<void> {
  console.log('[pentrace] init: waiting for OpenCV');
  setStatus('Loading OpenCV runtime…');
  await waitForOpenCV();
  console.log('[pentrace] init: OpenCV ready');
  if (mpMode === 'off') {
    setStatus('Ready (hand tracking OFF via ?mp=off) — synthetic demo only.', true);
    return;
  }
  setStatus('Loading hand landmark model…');
  handTracker = await HandTracker.create(mpMode === 'cpu' ? 'CPU' : 'GPU');
  console.log(`[pentrace] init: HandLandmarker ready (${mpMode})`);
  setStatus('Ready — start the camera, load a video, or run the synthetic demo.', true);
}

function startSource(s: FrameSource): void {
  stopLoop();
  source = s;
  movedStreak = 0;
  lostStreak = 0;
  lastPaperFrac = 1;
  lastVideoTime = -1;
  nextPaperMs = nextInkMs = nextHudMs = 0;
  lastTipVideo = null;
  lastPinchVideo = null;
  videoEndedNotified = false;
  newVideoFrame = false;
  armFrameCallback();
  paper.resetSession();
  ink.reset();
  store.clear();
  els.camera.width = s.width;
  els.camera.height = s.height;
  setStatus(`Source: ${s.kind} — looking for the paper…`);
  scheduleLoop();
}

/**
 * Re-acquire the homography WITHOUT touching captured strokes: the page
 * frame is stable across relocks (paper keeps its first-lock dims), only
 * the ink reference model must rebuild. Ink already on the paper becomes
 * the new baseline — it was captured already; it just won't re-commit.
 */
function relock(reason: string): void {
  paper.unlock();
  ink.reset();
  movedStreak = 0;
  lostStreak = 0;
  lastPaperFrac = 1;
  setStatus(`${reason} — re-locking paper (captured strokes kept)…`);
}

function loop(): void {
  if (!source) return;
  const now = performance.now();
  lastLoopRun = now;
  const w = source.width;
  const h = source.height;
  const alive = source.tick(now);
  if (!alive && source.kind === 'video' && !videoEndedNotified) {
    videoEndedNotified = true;
    setStatus('Video ended — captured strokes are final.', true);
  }

  // Gate on actual new frames: rAF outpaces the camera 2–4×, and re-running
  // inference on duplicate frames burns the budget for nothing. rVFC is the
  // reliable signal (currentTime is a quasi-continuous clock for camera
  // MediaStreams); when hidden, rVFC is throttled too, so process anyway —
  // the 33ms pacer cadence ≈ camera rate.
  if (source.kind !== 'synthetic') {
    let isNew: boolean;
    if (hasRVFC) {
      isNew = newVideoFrame || document.hidden;
      newVideoFrame = false;
    } else {
      isNew = els.video.currentTime !== lastVideoTime;
      lastVideoTime = els.video.currentTime;
    }
    if (!isNew) {
      page.render(store, now, els.tglTrail.checked);
      scheduleLoop();
      return;
    }
  }

  // 1. Current frame onto the camera canvas (pixel reads happen before overlays).
  let t0 = performance.now();
  cameraCtx.drawImage(source.element, 0, 0, w, h);
  stageMs.draw = performance.now() - t0;

  // 2. Motion layer.
  t0 = performance.now();
  let hands: HandResult[] = [];
  let writingHand: HandResult | null = null;
  let tip: PenTipResult | null = null;
  if (source.tipOverride) {
    tip = { ...source.tipOverride, conf: 1, pinch: source.tipOverride };
  } else if (handTracker && source.kind !== 'synthetic') {
    hands = handTracker.detect(source.element as TexImageSource, now, w, h);
    // A stale tip anchor would keep pulling hand selection to the wrong hand.
    if (now - lastTipSeenMs > 1000) lastTipVideo = null;
    writingHand = pickWritingHand(hands, lastTipVideo);
    if (writingHand) {
      // Hand switch (or landmark teleport): the One Euro filters would
      // smooth the jump into a fake fast swipe of trail points — reset.
      const thumb = writingHand.points[THUMB_TIP];
      const index = writingHand.points[INDEX_TIP];
      const pinch = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
      if (lastPinchVideo && dist(pinch, lastPinchVideo) > 150) pentip.reset();
      lastPinchVideo = pinch;
      tip = pentip.estimate(writingHand, cameraCtx, now);
    } else {
      lastPinchVideo = null;
    }
  }
  if (tip) {
    lastTipVideo = { x: tip.x, y: tip.y };
    lastTipSeenMs = now;
  }
  stageMs.hand = performance.now() - t0;
  t0 = performance.now();

  // 3. Paper layer, time-decimated. While locked, the moved-watchdog only
  // runs when no hand is over the scene — a hand biting into the paper
  // contour is the normal writing state, not evidence of movement.
  const handPresent = hands.length > 0 || !!source.tipOverride;
  const searching = !paper.lock && now >= nextPaperMs;
  const watching = !!paper.lock && now >= nextPaperMs && !handPresent;
  let candidateQuad: Quad | null = null;
  if (searching || watching) {
    nextPaperMs = now + (paper.lock ? PAPER_WATCH_MS : PAPER_SEARCH_MS);
    const scale = DETECT_W / w;
    smallCanvas.width = DETECT_W;
    smallCanvas.height = Math.round(h * scale);
    smallCtx.drawImage(source.element, 0, 0, smallCanvas.width, smallCanvas.height);
    const small = smallCtx.getImageData(0, 0, smallCanvas.width, smallCanvas.height);
    const wasLocked = !!paper.lock;
    const res = paper.detect(small, scale);
    candidateQuad = res.quad;
    if (res.moved) {
      movedStreak++;
      if (movedStreak >= MOVED_CHECKS_TO_RELOCK) relock('Paper moved');
    } else {
      movedStreak = 0;
    }
    if (paper.lock && !wasLocked) {
      store.setPageSize(paper.lock.pageW, paper.lock.pageH); // non-destructive
      page.setPageSize(paper.lock.pageW, paper.lock.pageH);
      setStatus('Paper locked — write away.', true);
    }
  }

  stageMs.paper = performance.now() - t0;

  // 4. Trajectory in page space.
  let tipPage: Pt | null = null;
  if (tip && paper.lock && tip.conf >= MIN_TIP_CONF) {
    const p = paper.toPage(tip);
    if (
      p &&
      p.x > -20 && p.y > -20 &&
      p.x < paper.lock.pageW + 20 && p.y < paper.lock.pageH + 20
    ) {
      tipPage = p;
      store.addTrailPoint(p, now, tip.conf);
    }
  }

  // 5. Ink layer + fusion, time-decimated.
  t0 = performance.now();
  if (paper.lock && now >= nextInkMs) {
    nextInkMs = now + INK_MS;
    const frame = cameraCtx.getImageData(0, 0, w, h);
    const rect = paper.rectifyGray(frame);
    if (rect) {
      const maskPolys: Pt[][] = [];
      for (const hd of hands) {
        const poly = hd.hull.map((v) => paper.toPage(v)).filter((v): v is Pt => v !== null);
        if (poly.length >= 3) maskPolys.push(poly);
      }
      // Pen barrel: dark, on the page, and NOT part of the hand hull. Mask
      // the pinch→tip capsule so a resting pen can't become false ink.
      if (tip && tipPage && !source.tipOverride) {
        const pinchPage = paper.toPage(tip.pinch);
        if (pinchPage) maskPolys.push(capsulePoly(pinchPage, tipPage, TIP_MASK_RADIUS * 1.5));
      }
      if (source.kind === 'synthetic') {
        const blob = (source as SyntheticSource).handBlob;
        if (blob) {
          const poly = circlePoly(blob.x, blob.y, blob.r)
            .map((v) => paper.toPage(v))
            .filter((v): v is Pt => v !== null);
          if (poly.length >= 3) maskPolys.push(poly);
        }
      }
      const res = ink.tick(rect, maskPolys, tipPage, now);
      lastFreshCount = res.fresh.length;
      lastPaperFrac = res.paperFraction;

      // Paper gone? Drop the lock and stop capturing. Without this the
      // homography stayed locked to a patch of empty desk forever, and every
      // hand movement over that patch kept drawing.
      if (res.paperFraction < PAPER_PRESENT_FRAC) {
        if (++lostStreak >= PAPER_LOST_TICKS) {
          relock('Paper lost');
          scheduleLoop();
          return;
        }
      } else {
        lostStreak = 0;
      }

      store.fuse(res.fresh, now, (x, y) => ink.observedSince(x, y));
      drawScaled(els.rectified, rectifiedScratch, grayToImageData(rect));
      drawScaled(els.inkDiff, inkDiffScratch, res.debug);
    }
  }

  stageMs.ink = performance.now() - t0;
  t0 = performance.now();

  // 6. Overlays (drawn after all pixel reads).
  if (els.tglLandmarks.checked) for (const hd of hands) drawHand(cameraCtx, hd);
  const quadToDraw = paper.lock?.quad ?? candidateQuad;
  if (els.tglQuad.checked && quadToDraw) drawQuad(cameraCtx, quadToDraw, !!paper.lock);
  if (els.tglTip.checked && tip) drawTip(cameraCtx, tip);

  // 7. Digital page.
  page.render(store, now, els.tglTrail.checked);
  stageMs.render = performance.now() - t0;

  // 8. HUD.
  const f = fps.tick(now);
  if (now >= nextHudMs) {
    nextHudMs = now + HUD_MS;
    els.hud.textContent = [
      `fps        ${f.toFixed(0)}`,
      `source     ${source.kind}`,
      `hands      ${hands.length || (source.tipOverride ? 'injected' : '—')}`,
      `PEN        ${tip && tip.conf >= MIN_TIP_CONF ? `yes (${tip.conf.toFixed(2)})` : 'NO — not tracking'}`,
      `paper      ${paper.lock ? `locked ${paper.lock.pageW}×${paper.lock.pageH}` : 'searching'}`,
      `paper seen ${(lastPaperFrac * 100).toFixed(0)}% ${lastPaperFrac < PAPER_PRESENT_FRAC ? '← LOST' : ''}`,
      `trail pts  ${store.trailLength()}`,
      `strokes    ${store.strokes.length}`,
      `fresh ink  ${lastFreshCount}px`,
      `orphan ink ${store.orphanPixels}px`,
      `ms d${stageMs.draw.toFixed(0)} h${stageMs.hand.toFixed(0)} p${stageMs.paper.toFixed(0)} i${stageMs.ink.toFixed(0)} r${stageMs.render.toFixed(0)}`,
    ].join('\n');
  }

  scheduleLoop();
}

/**
 * Which detected hand is writing? Prefer continuity with the last tip;
 * otherwise the tighter pinch (the paper-holding hand lies flat).
 */
function pickWritingHand(hands: HandResult[], lastTip: Pt | null): HandResult | null {
  if (!hands.length) return null;
  if (hands.length === 1) return hands[0];
  const score = (hd: HandResult): number => {
    const thumb = hd.points[THUMB_TIP];
    const index = hd.points[INDEX_TIP];
    const pinch = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    if (lastTip) return dist(pinch, lastTip);
    const scale = dist(hd.points[WRIST], hd.points[INDEX_MCP]) || 1;
    return dist(thumb, index) / scale; // tightness
  };
  return hands.reduce((a, b) => (score(a) <= score(b) ? a : b));
}

function circlePoly(cx: number, cy: number, r: number, n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

/** Rectangle around segment a→b with half-width r (caps covered elsewhere). */
function capsulePoly(a: Pt, b: Pt, r: number): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * r;
  const py = (dx / len) * r;
  return [
    { x: a.x + px, y: a.y + py },
    { x: b.x + px, y: b.y + py },
    { x: b.x - px, y: b.y - py },
    { x: a.x - px, y: a.y - py },
  ];
}

let grayScratch: ImageData | null = null;
function grayToImageData(g: { data: Uint8Array; w: number; h: number }): ImageData {
  if (!grayScratch || grayScratch.width !== g.w || grayScratch.height !== g.h) {
    grayScratch = new ImageData(g.w, g.h);
  }
  const out = grayScratch.data;
  for (let i = 0; i < g.w * g.h; i++) {
    const o = i * 4;
    out[o] = out[o + 1] = out[o + 2] = g.data[i];
    out[o + 3] = 255;
  }
  return grayScratch;
}

/** Put page-sized ImageData on a scratch canvas, then scale into the mini view. */
function drawScaled(target: HTMLCanvasElement, scratch: HTMLCanvasElement, img: ImageData): void {
  if (scratch.width !== img.width || scratch.height !== img.height) {
    scratch.width = img.width;
    scratch.height = img.height;
  }
  scratch.getContext('2d')!.putImageData(img, 0, 0);
  const ctx = target.getContext('2d')!;
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, target.width, target.height);
  const s = Math.min(target.width / img.width, target.height / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(scratch, (target.width - dw) / 2, (target.height - dh) / 2, dw, dh);
}

// ---- UI wiring ----

els.btnCamera.addEventListener('click', async () => {
  try {
    setStatus('Requesting camera…');
    startSource(await openCamera(els.video));
  } catch (e) {
    setStatus(`Camera failed: ${(e as Error).message}`);
  }
});

els.fileVideo.addEventListener('change', async () => {
  const file = els.fileVideo.files?.[0];
  if (!file) return;
  try {
    setStatus(`Loading ${file.name}…`);
    startSource(await openVideoFile(els.video, file));
  } catch (e) {
    setStatus(`Video failed: ${(e as Error).message}`);
  }
});

els.btnSynthetic.addEventListener('click', () => startSource(new SyntheticSource()));

els.btnRelock.addEventListener('click', () => relock('Manual re-lock'));

els.btnClear.addEventListener('click', () => {
  store.clear();
  ink.requestSnap();
  setStatus('Page cleared — existing ink on paper is now the baseline.', true);
});

els.btnExport.addEventListener('click', () => page.exportPNG());

els.btnRecognize.addEventListener('click', async () => {
  els.recognizeOut.textContent = 'Recognizing…';
  els.recognizeOut.textContent = await engine.recognize(store.strokes, page.snapshot());
});

init().catch((e) => setStatus(`Init failed: ${(e as Error).message}`));

// Debug handle for inspecting live pipeline state from the console.
(window as any).pentrace = { store, paper, ink };
