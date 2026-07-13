import { getCV } from './cvready';
import type { Pt, Quad } from './types';

/**
 * Paper layer: find the sheet as the dominant bright quadrilateral, then
 * lock a homography from video space to a top-down "page space".
 *
 * The lock matters: the ink background model is a per-pixel comparison in
 * page space, so the homography must stay fixed while the model is alive.
 * Re-estimating every frame would make the rectified image swim by a pixel
 * or two and light up the whole diff. We therefore:
 *   - detect repeatedly until the quad is stable across consecutive
 *     detections, then LOCK;
 *   - while locked, keep watching cheaply; if the quad we can still see
 *     has clearly moved (paper bumped), report it so the session resets.
 */

const MIN_AREA_FRAC = 0.12; // of the downscaled frame
const STABLE_DETECTIONS = 3;
const STABLE_TOL_PX = 8; // in video px
const MOVED_TOL_PX = 25; // relock threshold while locked
const PAGE_MAX_DIM = 1000;

export interface PaperLock {
  quad: Quad;
  pageW: number;
  pageH: number;
}

export class PaperTracker {
  private history: Quad[] = [];
  lock: PaperLock | null = null;
  /**
   * Page dims from the FIRST lock of a session. Relocks reuse them so page
   * space stays comparable and captured strokes survive (same physical
   * sheet, so the aspect is unchanged within tolerance).
   */
  private preferredSize: { w: number; h: number } | null = null;
  /** Last displaced quad seen while locked — a real move must be stable. */
  private lastWatchQuad: Quad | null = null;
  /** Area of the last genuine lock; survives unlock to vet relock candidates. */
  private lastLockedArea = 0;

  /** Homography as a row-major 9-vector for fast JS point mapping. */
  private hVec: number[] | null = null;
  private srcMat: any = null; // persistent full-res RGBA Mat
  private rectMat: any = null; // persistent page-space RGBA Mat
  private grayMat: any = null; // persistent page-space gray Mat
  private hMat: any = null;

  /**
   * Run quad detection on a downscaled frame. Returns the current candidate
   * quad (video coords) for debug drawing, and internally advances the
   * stability/lock state. `moved` is true when a locked paper has shifted.
   */
  detect(small: ImageData, scale: number): { quad: Quad | null; moved: boolean } {
    const quad = findPaperQuad(small, scale);
    if (!quad) {
      this.history = [];
      return { quad: null, moved: false };
    }

    if (this.lock) {
      // "Moved" needs three signals to agree, because during writing the
      // hand bites into the paper contour and can fake a displaced 4-gon:
      // (1) drifted from the locked quad, (2) the SAME displaced position
      // on consecutive checks, (3) area preserved (occlusion shrinks it).
      const drift = maxCornerDist(quad, this.lock.quad);
      const stable =
        this.lastWatchQuad !== null && maxCornerDist(quad, this.lastWatchQuad) < STABLE_TOL_PX;
      const areaRatio = quadArea(quad) / (quadArea(this.lock.quad) || 1);
      this.lastWatchQuad = quad;
      const moved = drift > MOVED_TOL_PX && stable && areaRatio > 0.75 && areaRatio < 1.33;
      return { quad, moved };
    }

    // Relock candidates must match the session's known paper area: a hand
    // resting on the sheet during re-search yields a STABLE hand-bitten
    // quad, and locking onto it would bake a skewed homography into the
    // preserved page frame.
    if (this.lastLockedArea) {
      const ratio = quadArea(quad) / this.lastLockedArea;
      if (ratio < 0.7 || ratio > 1.4) {
        this.history = [];
        return { quad, moved: false };
      }
    }
    this.history.push(quad);
    if (this.history.length > STABLE_DETECTIONS) this.history.shift();
    if (
      this.history.length === STABLE_DETECTIONS &&
      maxCornerDist(this.history[0], this.history[STABLE_DETECTIONS - 1]) < STABLE_TOL_PX
    ) {
      this.setLock(quad);
      this.lastLockedArea = quadArea(quad);
    }
    return { quad, moved: false };
  }

  private setLock(quad: Quad): void {
    const cv = getCV();
    const [tl, tr, br, bl] = quad;
    const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
    const hL = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const hR = Math.hypot(br.x - tr.x, br.y - tr.y);
    const w = Math.max(wTop, wBot);
    const h = Math.max(hL, hR);
    const s = PAGE_MAX_DIM / Math.max(w, h);
    let pageW = Math.max(200, Math.round(w * s));
    let pageH = Math.max(200, Math.round(h * s));
    if (this.preferredSize) {
      pageW = this.preferredSize.w;
      pageH = this.preferredSize.h;
    } else {
      this.preferredSize = { w: pageW, h: pageH };
    }

    this.releaseMats();
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
    ]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, pageW, 0, pageW, pageH, 0, pageH]);
    this.hMat = cv.getPerspectiveTransform(src, dst);
    src.delete();
    dst.delete();

    this.hVec = Array.from(this.hMat.data64F as Float64Array);
    this.rectMat = new cv.Mat(pageH, pageW, cv.CV_8UC4);
    this.grayMat = new cv.Mat(pageH, pageW, cv.CV_8UC1);
    this.lock = { quad, pageW, pageH };
  }

  /** Drop the lock; page dims are kept so a relock stays comparable. */
  unlock(): void {
    this.lock = null;
    this.history = [];
    this.lastWatchQuad = null;
    this.releaseMats();
  }

  /** Full reset for a new source/session — page dims are recomputed. */
  resetSession(): void {
    this.unlock();
    this.preferredSize = null;
    this.lastLockedArea = 0;
  }

  /** Map a video-space point into page space. */
  toPage(p: Pt): Pt | null {
    const h = this.hVec;
    if (!h) return null;
    const w = h[6] * p.x + h[7] * p.y + h[8];
    if (Math.abs(w) < 1e-9) return null;
    return {
      x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
      y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
    };
  }

  /**
   * Warp the full video frame into page space and return grayscale pixels.
   * The returned view aliases a persistent Mat — copy if you keep it.
   */
  rectifyGray(frame: ImageData): { data: Uint8Array; w: number; h: number } | null {
    if (!this.lock) return null;
    const cv = getCV();
    if (!this.srcMat || this.srcMat.cols !== frame.width || this.srcMat.rows !== frame.height) {
      this.srcMat?.delete();
      this.srcMat = new cv.Mat(frame.height, frame.width, cv.CV_8UC4);
    }
    this.srcMat.data.set(frame.data);
    cv.warpPerspective(
      this.srcMat,
      this.rectMat,
      this.hMat,
      new cv.Size(this.lock.pageW, this.lock.pageH),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
    );
    cv.cvtColor(this.rectMat, this.grayMat, cv.COLOR_RGBA2GRAY);
    return { data: this.grayMat.data as Uint8Array, w: this.lock.pageW, h: this.lock.pageH };
  }

  private releaseMats(): void {
    for (const m of [this.hMat, this.rectMat, this.grayMat]) m?.delete();
    this.hMat = this.rectMat = this.grayMat = null;
    this.hVec = null;
  }
}

function findPaperQuad(small: ImageData, scale: number): Quad | null {
  const cv = getCV();
  const mats: any[] = [];
  const track = <T>(m: T): T => (mats.push(m), m);
  try {
    const src = track(cv.matFromImageData(small));
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const bin = track(new cv.Mat());
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const minArea = small.width * small.height * MIN_AREA_FRAC;
    let best: any = null;
    let bestArea = minArea;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > bestArea) {
        best?.delete();
        best = c;
        bestArea = area;
      } else {
        c.delete();
      }
    }
    if (!best) return null;
    track(best);

    const peri = cv.arcLength(best, true);
    const approx = track(new cv.Mat());
    cv.approxPolyDP(best, approx, 0.03 * peri, true);
    if (approx.rows !== 4) return null;

    const pts: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: approx.data32S[i * 2] / scale, y: approx.data32S[i * 2 + 1] / scale });
    }
    return orderQuad(pts);
  } finally {
    for (const m of mats) m.delete();
  }
}

/** Shoelace area of a quad. */
function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const r = q[(i + 1) % 4];
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Order corners TL, TR, BR, BL via the sum/difference heuristic.
 * Known limit: misassigns corners for a sheet rotated near 45° in frame —
 * fine for the laptop-on-desk setup this targets.
 */
function orderQuad(pts: Pt[]): Quad {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const byDiff = [...pts].sort((a, b) => a.x - a.y - (b.x - b.y));
  const bl = byDiff[0];
  const tr = byDiff[3];
  return [tl, tr, br, bl];
}

function maxCornerDist(a: Quad, b: Quad): number {
  let m = 0;
  for (let i = 0; i < 4; i++) {
    m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  }
  return m;
}
