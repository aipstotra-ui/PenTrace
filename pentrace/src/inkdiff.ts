import type { Pt } from './types';

/**
 * Ink layer: maintains a reference image R of the "already-seen page" in
 * rectified page space. Fresh ink = pixels now clearly darker than R.
 *
 * Design decisions that matter:
 *
 * - R starts unset per-pixel and fills in as pixels are observed unmasked.
 *   Pixels under the hand keep their old R until the hand moves — ink laid
 *   down there is simply discovered a tick or two later.
 * - The hand hulls, the pen-barrel capsule, AND a small disk around the
 *   current pen tip are masked. The tip disk is what stops the dark pen nib
 *   itself (which sits exactly on the trajectory!) from being detected as
 *   ink: the nib's pixels are only evaluated after the nib has moved off
 *   them, at which point real ink stays dark and mere nib-shadow vanishes.
 * - A pixel must be a candidate on TWO consecutive ticks to count as fresh
 *   ink. Sensor noise and moving shadows flicker; ink persists.
 * - Pixels in the candidate state are FROZEN in R (no EMA) — otherwise the
 *   hand sweeping over just-written ink would repeatedly interrupt the
 *   two-tick confirmation while the EMA quietly absorbed the ink into R,
 *   silently losing writing.
 * - Confirmed-fresh components are shape-gated: pen ink is thin (a few px
 *   at page scale). Fat blobs — pen barrel at rest, forearm shadow, a phone
 *   on the desk — are rejected and stay candidates until they move away.
 * - Webcam auto-exposure shifts global brightness when the hand enters the
 *   frame. We estimate a gain between R and the current frame over known
 *   pixels each tick and normalize before differencing.
 * - Once reported fresh, a pixel's R snaps to the current value so the same
 *   ink is never reported twice. Non-candidate pixels drift toward the
 *   current frame with a slow EMA so gradual lighting change doesn't
 *   accumulate.
 */

// Gray levels darker than R. Must sit ABOVE shadow contrast and BELOW pen
// contrast: a soft hand/pen shadow on white paper is ~25-50 levels darker,
// real ballpoint ink is 100+. 30 let every moving shadow through as "ink".
const INK_THRESH = 48;
const EMA = 0.08; // background adaptation rate per tick
const GAIN_CLAMP: [number, number] = [0.7, 1.4];
const MIN_NEIGHBORS = 2; // 8-neighborhood support for a fresh pixel
const MAX_STROKE_THICKNESS = 8; // page px; area/length above this = blob, not ink
// Floor. Without one, a 3px speck of sensor noise counted as ink and, if it
// landed near the trail, committed a phantom dot. Real writing always leaves
// a connected mark of at least this size at page scale.
const MIN_COMPONENT_AREA = 10; // page px²
const MIN_COMPONENT_LEN = 3; // page px, longest bbox side
// Generous: a whole cursive word discovered in one tick from under a lifted
// hand is a single thin component and can be large. Thickness is the real
// gate; this only stops page-scale artifacts.
const MAX_COMPONENT_AREA = 12000; // page px²
// Page px around the nib. This masks the DARK NIB so it isn't read as ink —
// it must be nib-sized (~2mm ≈ 7px), not a halo. At 14 it was an 8mm blind
// spot that swallowed whole 4-5mm letters, so real writing was never seen.
export const TIP_MASK_RADIUS = 7;
/** Unmasked pixels that still look like paper, below which the sheet is gone. */
export const PAPER_PRESENT_FRAC = 0.45;

export interface InkTickResult {
  /** Fresh ink pixel coords (page space), shape-gated to stroke-like components. */
  fresh: Pt[];
  /** RGBA debug view (fresh=red, masked=blue tint, unknown=dim). */
  debug: ImageData;
  /**
   * Fraction of unmasked page pixels that still look like the paper we locked
   * onto. Collapses when the sheet is removed or slid away — the only signal
   * that survives a hand resting on the page (quad detection does not: the
   * hand merges with the sheet's contour and returns nothing, which is why
   * "paper gone" was never noticed before).
   */
  paperFraction: number;
}

export class InkDiff {
  private ref: Float32Array | null = null;
  private valid: Uint8Array | null = null;
  private prevCandidate: Uint8Array | null = null;
  private mask: Uint8Array | null = null;
  private cand: Uint8Array | null = null;
  private freshMask: Uint8Array | null = null;
  private debugImg: ImageData | null = null;
  /** When each pixel last BECAME observable; -1 while masked. */
  private unmaskedSince: Float32Array | null = null;
  /** Median brightness of the paper when this model was built; -1 until set. */
  private paperLevel = -1;
  private w = 0;
  private h = 0;
  private snapAll = false;

  reset(): void {
    this.ref = null;
    this.valid = null;
    this.prevCandidate = null;
    this.mask = null;
    this.cand = null;
    this.freshMask = null;
    this.debugImg = null;
    this.unmaskedSince = null;
    this.paperLevel = -1;
  }

  /**
   * When the page pixel at (x,y) last became observable (unmasked), or
   * Infinity while it is still under a mask. Fusion uses this to judge
   * whether a trail point's ink has had a fair chance to appear.
   */
  observedSince(x: number, y: number): number {
    const u = this.unmaskedSince;
    if (!u) return 0;
    const xi = Math.min(this.w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(this.h - 1, Math.max(0, Math.round(y)));
    const v = u[yi * this.w + xi];
    return v < 0 ? Infinity : v;
  }

  /** Make the current page state the new baseline (used by "Clear page"). */
  requestSnap(): void {
    this.snapAll = true;
  }

  tick(
    cur: { data: Uint8Array; w: number; h: number },
    maskPolys: Pt[][],
    tipDisk: Pt | null,
    now: number,
  ): InkTickResult {
    const { w, h } = cur;
    const n = w * h;
    if (!this.ref || this.w !== w || this.h !== h) {
      this.w = w;
      this.h = h;
      this.ref = new Float32Array(n);
      this.valid = new Uint8Array(n);
      this.prevCandidate = new Uint8Array(n);
      this.mask = new Uint8Array(n);
      this.cand = new Uint8Array(n);
      this.freshMask = new Uint8Array(n);
      this.debugImg = new ImageData(w, h);
      this.unmaskedSince = new Float32Array(n).fill(now);
    }
    const ref = this.ref;
    const valid = this.valid!;
    const prevCand = this.prevCandidate!;
    const mask = this.mask!;
    const cand = this.cand!;
    const freshMask = this.freshMask!;
    const data = cur.data;

    mask.fill(0);
    for (const poly of maskPolys) fillPolygon(mask, w, h, poly);
    if (tipDisk) fillDisk(mask, w, h, tipDisk.x, tipDisk.y, TIP_MASK_RADIUS);

    // Track when each pixel (re)became observable.
    const unmasked = this.unmaskedSince!;
    for (let i = 0; i < n; i++) {
      if (mask[i]) unmasked[i] = -1;
      else if (unmasked[i] < 0) unmasked[i] = now;
    }

    // Exposure gain: median of R/cur over a sparse sample of known pixels.
    // Candidates are excluded — their data is dark against a frozen ref, so
    // they'd contaminate the very estimator that adjudicates them.
    let gain = 1;
    {
      const ratios: number[] = [];
      for (let i = 0; i < n; i += 97) {
        if (valid[i] && !mask[i] && !prevCand[i] && data[i] > 20) ratios.push(ref[i] / data[i]);
      }
      if (ratios.length > 30) {
        ratios.sort((a, b) => a - b);
        gain = ratios[ratios.length >> 1];
        gain = Math.min(GAIN_CLAMP[1], Math.max(GAIN_CLAMP[0], gain));
      }
    }

    // Paper presence. Establish the paper's brightness once, then each tick
    // measure how much of the visible page still matches it. Removing the
    // sheet drops this off a cliff; a hand resting on the page does not (it's
    // masked out of the sample).
    let paperFraction = 1;
    {
      const lit: number[] = [];
      for (let i = 0; i < n; i += 31) {
        if (!mask[i]) lit.push(data[i] * gain);
      }
      if (lit.length > 50) {
        if (this.paperLevel < 0) {
          const s = [...lit].sort((a, b) => a - b);
          this.paperLevel = s[s.length >> 1];
        }
        const floor = this.paperLevel - 70;
        let hits = 0;
        for (const v of lit) if (v >= floor) hits++;
        paperFraction = hits / lit.length;
      }
    }

    if (this.snapAll) {
      this.snapAll = false;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) {
          ref[i] = data[i] * gain;
          valid[i] = 1;
        }
      }
      prevCand.fill(0);
      freshMask.fill(0);
      return { fresh: [], debug: this.renderDebug(data, mask, freshMask), paperFraction };
    }

    // Pass 1: candidates (dark vs R, two-tick persistence).
    cand.fill(0);
    for (let i = 0; i < n; i++) {
      if (mask[i]) {
        prevCand[i] = 0;
        continue;
      }
      if (!valid[i]) {
        ref[i] = data[i] * gain;
        valid[i] = 1;
        continue;
      }
      const diff = ref[i] - data[i] * gain;
      if (diff > INK_THRESH) cand[i] = 1;
    }

    // Pass 2: fresh = candidate now AND last tick, with neighborhood support.
    freshMask.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!cand[i] || !prevCand[i]) continue;
        const nb =
          cand[i - 1] + cand[i + 1] + cand[i - w] + cand[i + w] +
          cand[i - w - 1] + cand[i - w + 1] + cand[i + w - 1] + cand[i + w + 1];
        if (nb >= MIN_NEIGHBORS) freshMask[i] = 1;
      }
    }

    // Pass 2b: connected components over freshMask; keep only stroke-like
    // shapes. freshMask values after this pass: 0 = none/rejected, 2 = ink.
    const fresh = this.filterComponents(freshMask, w, h);

    // Pass 3: update R — snap where accepted fresh, freeze while candidate,
    // drift elsewhere.
    for (let i = 0; i < n; i++) {
      if (mask[i] || !valid[i]) continue;
      const v = data[i] * gain;
      if (freshMask[i]) {
        ref[i] = v;
      } else if (!cand[i]) {
        ref[i] += (v - ref[i]) * EMA;
      }
      // cand && !fresh: frozen — awaiting confirmation or blob rejection.
    }
    prevCand.set(cand);

    return { fresh, debug: this.renderDebug(data, mask, freshMask), paperFraction };
  }

  private filterComponents(freshMask: Uint8Array, w: number, h: number): Pt[] {
    const fresh: Pt[] = [];
    const stack: number[] = [];
    const comp: number[] = [];
    for (let start = 0; start < freshMask.length; start++) {
      if (freshMask[start] !== 1) continue;
      stack.length = 0;
      comp.length = 0;
      stack.push(start);
      freshMask[start] = 2;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      while (stack.length) {
        const i = stack.pop()!;
        comp.push(i);
        const x = i % w;
        const y = (i / w) | 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (freshMask[j] === 1) {
              freshMask[j] = 2;
              stack.push(j);
            }
          }
        }
      }
      // Thickness ≈ area / longest bbox side. Thin strokes pass, blobs don't.
      // Too-small components are noise specks, not writing (this floor is what
      // stopped hand movement from stamping phantom dots).
      const len = Math.max(maxX - minX + 1, maxY - minY + 1);
      const thickness = comp.length / len;
      if (
        comp.length < MIN_COMPONENT_AREA ||
        len < MIN_COMPONENT_LEN ||
        comp.length > MAX_COMPONENT_AREA ||
        thickness > MAX_STROKE_THICKNESS
      ) {
        for (const i of comp) freshMask[i] = 0; // rejected: stays candidate
      } else {
        for (const i of comp) fresh.push({ x: i % w, y: (i / w) | 0 });
      }
    }
    return fresh;
  }

  private renderDebug(data: Uint8Array, mask: Uint8Array, freshMask: Uint8Array): ImageData {
    const { w, h } = this;
    const img = this.debugImg!;
    const out = img.data;
    const valid = this.valid!;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const g = data[i];
      if (freshMask[i]) {
        out[o] = 255;
        out[o + 1] = 40;
        out[o + 2] = 40;
      } else if (mask[i]) {
        out[o] = g * 0.3;
        out[o + 1] = g * 0.4;
        out[o + 2] = Math.min(255, g * 0.7 + 60);
      } else if (!valid[i]) {
        out[o] = out[o + 1] = out[o + 2] = g * 0.25;
      } else {
        out[o] = out[o + 1] = out[o + 2] = g;
      }
      out[o + 3] = 255;
    }
    return img;
  }
}

/** Scanline fill of a convex-ish polygon into a byte mask. */
export function fillPolygon(mask: Uint8Array, w: number, h: number, poly: Pt[]): void {
  if (poly.length < 3) return;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of poly) {
    yMin = Math.min(yMin, p.y);
    yMax = Math.max(yMax, p.y);
  }
  yMin = Math.max(0, Math.floor(yMin));
  yMax = Math.min(h - 1, Math.ceil(yMax));
  for (let y = yMin; y <= yMax; y++) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y === b.y) continue;
      if ((y >= a.y && y < b.y) || (y >= b.y && y < a.y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.floor(xs[k]));
      const x1 = Math.min(w - 1, Math.ceil(xs[k + 1]));
      mask.fill(1, y * w + x0, y * w + x1 + 1);
    }
  }
}

function fillDisk(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): void {
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const x0 = Math.max(0, Math.floor(cx - half));
    const x1 = Math.min(w - 1, Math.ceil(cx + half));
    if (x1 >= x0) mask.fill(1, y * w + x0, y * w + x1 + 1);
  }
}
