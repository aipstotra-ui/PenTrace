import type { HandResult } from './hand';
import { INDEX_MCP, INDEX_PIP, INDEX_TIP, THUMB_TIP, WRIST } from './hand';
import type { PenTip, Pt } from './types';
import { luminance } from './types';

export interface PenTipResult extends PenTip {
  /** Thumb–index pinch point (video px) — anchors the pen-barrel mask. */
  pinch: Pt;
}

/**
 * Pen tip estimation, two stages:
 *
 * 1. Geometric prior from the grip. In a writing grip the pen is pinched
 *    between thumb tip and index tip and the nib protrudes past the
 *    fingertips along the index finger's distal direction. We extrapolate
 *    from the pinch point along that direction, scaled by hand size so it
 *    works at any distance from the camera.
 * 2. Visual refinement. The nib is almost always the darkest thing in a
 *    small patch around the prior (pen bodies/nibs are dark; paper is
 *    bright). We take a darkness-weighted centroid, weighted also by
 *    proximity to the prior so stray dark ink already on the page doesn't
 *    yank the estimate.
 *
 * The result is smoothed by a One Euro filter — low lag on fast strokes,
 * strong smoothing when nearly still, which is exactly the tradeoff
 * handwriting needs (jitter at rest ruins letter shapes; lag ruins timing).
 */

const TIP_EXTEND = 0.55; // × hand scale, past the pinch point
const PATCH_RADIUS_SCALE = 0.3; // × hand scale, search window for the dark nib
const PATCH_RADIUS_MIN = 14;
const PATCH_RADIUS_MAX = 48;
const DARK_FRACTION = 0.35; // pixel must be this much darker than patch median
const MIN_DARK_PIXELS = 6;
const FILTER_RESET_MS = 300;
/**
 * No pen means NO tracking. Previously any dark thing near the fingertips —
 * the hand's own shadow — was accepted as a "nib", so an empty hand moving
 * over the page generated a trail and stamped phantom marks. A real nib is
 * (a) MUCH darker than the paper around it, and (b) SMALL. A shadow is soft
 * and broad, and fails both.
 */
const PEN_MIN_CONTRAST = 70; // patch median − darkest; ink/plastic ≫ shadow
const PEN_MAX_DARK_SAMPLES = 90; // a nib is compact; a shadow floods the patch
// A pure geometric guess with no visible nib is 20–40px off. Score it 0 so the
// MIN_TIP_CONF gate drops it rather than polluting trail↔ink confirmation.
const FALLBACK_CONF = 0;

export class PenTipEstimator {
  private fx = new OneEuro(1.2, 0.008, 1.0);
  private fy = new OneEuro(1.2, 0.008, 1.0);
  private lastSeen = -Infinity;

  /** Hard reset — call when tracking switches hands or teleports. */
  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.lastSeen = -Infinity;
  }

  /**
   * @param ctx canvas holding the current video frame — only the small
   *   search patch is read back, keeping the per-frame cost tiny.
   */
  estimate(hand: HandResult, ctx: CanvasRenderingContext2D, tMs: number): PenTipResult {
    const lm = hand.points;
    const thumb = lm[THUMB_TIP];
    const index = lm[INDEX_TIP];
    const pinch: Pt = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    const handScale = Math.hypot(lm[WRIST].x - lm[INDEX_MCP].x, lm[WRIST].y - lm[INDEX_MCP].y);

    // Distal direction of the index finger ≈ pen axis toward the paper.
    const dirX = index.x - lm[INDEX_PIP].x;
    const dirY = index.y - lm[INDEX_PIP].y;
    const dirLen = Math.hypot(dirX, dirY) || 1;
    const prior: Pt = {
      x: pinch.x + (dirX / dirLen) * handScale * TIP_EXTEND,
      y: pinch.y + (dirY / dirLen) * handScale * TIP_EXTEND,
    };

    const refined = refineDarkTip(prior, ctx, handScale, dirX / dirLen, dirY / dirLen);

    if (tMs - this.lastSeen > FILTER_RESET_MS) {
      this.fx.reset();
      this.fy.reset();
    }
    this.lastSeen = tMs;

    const tSec = tMs / 1000;
    return {
      x: this.fx.filter(refined.x, tSec),
      y: this.fy.filter(refined.y, tSec),
      conf: refined.conf,
      pinch,
    };
  }
}

/**
 * `dirX/dirY` is the unit pen direction (pinch → nib). Freshly written ink
 * lies immediately BEHIND the nib along this axis and is just as dark as
 * the nib, so only pixels in the leading half-plane (small tolerance) may
 * vote — otherwise the estimate is dragged backward along the stroke, a
 * systematic bias no amount of filtering removes.
 */
function refineDarkTip(
  prior: Pt,
  ctx: CanvasRenderingContext2D,
  handScale: number,
  dirX: number,
  dirY: number,
): PenTip {
  const r = Math.round(
    Math.min(PATCH_RADIUS_MAX, Math.max(PATCH_RADIUS_MIN, handScale * PATCH_RADIUS_SCALE)),
  );
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const x0 = Math.max(0, Math.round(prior.x) - r);
  const y0 = Math.max(0, Math.round(prior.y) - r);
  const x1 = Math.min(cw - 1, Math.round(prior.x) + r);
  const y1 = Math.min(ch - 1, Math.round(prior.y) + r);
  if (x1 <= x0 || y1 <= y0) return { ...prior, conf: 0.2 };
  const patch = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);

  // Collect luminances (stride 2 keeps this ~600 samples at max radius).
  const data = patch.data;
  const lums: number[] = [];
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const i = ((y - y0) * patch.width + (x - x0)) * 4;
      lums.push(luminance(data[i], data[i + 1], data[i + 2]));
    }
  }
  const sorted = [...lums].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const darkest = sorted[0];
  const thresh = darkest + (median - darkest) * DARK_FRACTION;
  // Not dark enough to be a pen nib — this is bare hand, or shadow only.
  if (median - darkest < PEN_MIN_CONTRAST) return { ...prior, conf: FALLBACK_CONF };

  const sigma2 = r * r * 0.5;
  let wSum = 0;
  let wx = 0;
  let wy = 0;
  let count = 0;
  let k = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2, k++) {
      const l = lums[k];
      if (l > thresh) continue;
      const dx = x - prior.x;
      const dy = y - prior.y;
      if (dx * dirX + dy * dirY < -3) continue; // trailing side: written ink, not nib
      const w = (thresh - l + 1) * Math.exp(-(dx * dx + dy * dy) / sigma2);
      wSum += w;
      wx += x * w;
      wy += y * w;
      count++;
    }
  }
  // Too few dark pixels = nothing there; too many = a broad shadow flooding the
  // patch, not a compact nib. Both mean "no pen" under strict capture.
  if (count < MIN_DARK_PIXELS || count > PEN_MAX_DARK_SAMPLES || wSum === 0) {
    return { ...prior, conf: FALLBACK_CONF };
  }
  return { x: wx / wSum, y: wy / wSum, conf: Math.min(1, 0.5 + count / 60) };
}

/**
 * One Euro filter (Casiez, Roussel, Vogel — CHI 2012).
 * cutoff = minCutoff + beta * |dx̂|; speed-adaptive first-order low-pass.
 */
class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff: number,
  ) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tSec: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tSec;
      return x;
    }
    const dt = Math.max(1e-3, tSec - this.tPrev);
    this.tPrev = tSec;

    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.dCutoff, dt);
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = alpha(cutoff, dt);
    this.xPrev = a * x + (1 - a) * this.xPrev;
    return this.xPrev;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
