import type { Pt, Stroke, TrailPoint } from './types';

/**
 * Fusion layer — where the two signals meet.
 *
 * The trail is the pen tip's recent path (page space, timestamped). It is
 * provisional: the tip moves whether or not the pen touches the paper.
 * Fresh ink from the diff layer confirms which parts of the trail were
 * actual writing. A trail point with fresh ink nearby becomes committed;
 * its position snaps to the ink's local centroid (the ink is geometrically
 * more trustworthy than the tracked tip). Confirmed points are grouped into
 * time-contiguous strokes.
 *
 * Fresh ink with no trail nearby ("orphan ink") is still real ink — e.g.
 * laid down while the hand occluded tracking, or discovered late from under
 * the hand. It is stamped onto a raster layer so nothing the user wrote is
 * ever dropped; it just lacks timing.
 */

const TRAIL_KEEP_MS = 3000;
// MUST equal TRAIL_KEEP_MS: if points linger in the trail past confirmation
// eligibility, late ink from under the hand is neither confirmed (window
// expired) nor orphan-stamped (still "near trail") — silently lost.
const FUSE_WINDOW_MS = TRAIL_KEEP_MS;
const CONFIRM_RADIUS = 14; // page px, trail point ↔ ink
const CELL = 16; // spatial grid for ink lookup
// Ink arrives in ~170ms batches (ink tick cadence) while trail points land
// every ~33ms, so ~5 points between batches are legitimately unconfirmed
// mid-stroke. Bridging must be sized in TIME relative to the ink cadence —
// a point count would fragment strokes at high fps and over-bridge at low.
const BRIDGE_MAX_POINTS = 24; // safety cap only; time bound governs
const BRIDGE_MAX_MS = 450; // ~2.5 ink ticks
const STROKE_GAP_MS = 500; // time gap that always splits strokes
// Spatial guard against false joins across pen-up hops: late-arriving ink
// can confirm the first few hop points (they pass near where ink is still
// emerging), keeping a run alive across the hop. Hops move much faster
// than writing, so a large jump between consecutive confirmed points means
// pen-up travel, not a stroke — split regardless of timing.
const MAX_JOIN_DIST = 40; // page px
// A run older than this is force-committed even while still growing, so a
// long continuous stroke (>3s: underlines, cursive words) commits in
// chapters BEFORE its head is evicted from the trail. Chapters re-join via
// the open-stroke continuation in flush().
const FORCE_COMMIT_AGE_MS = TRAIL_KEEP_MS - 500;
// A point is "pending" until its page pixel has been observable (unmasked)
// for two ink ticks plus slack — the mask-aware replacement for a fixed
// wall-clock window, since the hand can sit over fresh ink indefinitely.
const PENDING_OBS_MS = 550;
// Stub gate: a committable run must cover some ground or time…
const MIN_STROKE_ARC = 8; // page px
const MIN_STROKE_DUR_MS = 100; // the synthetic i-dot (~250ms, ~12px) passes

const MIN_STROKE_POINTS = 2;
const ORPHAN_MIN_DENSITY = 4; // fresh px within one cell to count as real

interface FusePoint extends TrailPoint {
  consumed: boolean;
  snapX: number;
  snapY: number;
}

export class StrokeStore {
  private trail: FusePoint[] = [];
  strokes: Stroke[] = [];
  orphanCanvas: HTMLCanvasElement | null = null;
  private orphanCtx: CanvasRenderingContext2D | null = null;
  orphanPixels = 0;
  /** Index of a force-committed stroke still accepting continuation runs. */
  private openStrokeIdx = -1;

  /**
   * NON-destructive: captured strokes survive paper relocks. The page frame
   * is held stable across relocks (paper.preferredPageSize), so this only
   * allocates on first lock or a genuine size change.
   */
  setPageSize(w: number, h: number): void {
    if (this.orphanCanvas && this.orphanCanvas.width === w && this.orphanCanvas.height === h) {
      return;
    }
    this.orphanCanvas = document.createElement('canvas');
    this.orphanCanvas.width = w;
    this.orphanCanvas.height = h;
    this.orphanCtx = this.orphanCanvas.getContext('2d')!;
  }

  clear(): void {
    this.trail = [];
    this.strokes = [];
    this.orphanPixels = 0;
    this.openStrokeIdx = -1;
    if (this.orphanCtx && this.orphanCanvas) {
      this.orphanCtx.clearRect(0, 0, this.orphanCanvas.width, this.orphanCanvas.height);
    }
  }

  addTrailPoint(p: Pt, t: number, conf: number): void {
    this.trail.push({
      x: p.x,
      y: p.y,
      t,
      conf,
      inkConfirmed: false,
      consumed: false,
      snapX: p.x,
      snapY: p.y,
    });
    // Age-based eviction must NEVER drop a confirmed-but-uncommitted point:
    // its ink was already consumed from the diff (it will not re-report),
    // so evicting it silently loses writing. Force-commit in extraction
    // consumes such points before they can pile up here.
    const cutoff = t - TRAIL_KEEP_MS;
    while (this.trail.length && this.trail[0].t < cutoff) {
      const head = this.trail[0];
      if (!head.consumed && head.inkConfirmed) break;
      this.trail.shift();
    }
  }

  /**
   * Reject hop-tail stubs: 2–3 hop points falsely confirmed by ink still
   * emerging at a real stroke's endpoint. A genuine tiny stroke (an i-dot)
   * covers a little ground or time; a stub hugs the previous stroke's tail.
   */
  private passesStubGate(run: FusePoint[]): boolean {
    const prev = this.strokes[this.strokes.length - 1];
    const tail = prev ? prev.points[prev.points.length - 1] : null;
    if (
      tail &&
      run.every((p) => Math.hypot(p.snapX - tail.x, p.snapY - tail.y) <= CONFIRM_RADIUS)
    ) {
      return false;
    }
    let arc = 0;
    for (let i = 1; i < run.length; i++) {
      arc += Math.hypot(run[i].snapX - run[i - 1].snapX, run[i].snapY - run[i - 1].snapY);
    }
    const dur = run[run.length - 1].t - run[0].t;
    return arc >= MIN_STROKE_ARC || dur >= MIN_STROKE_DUR_MS;
  }

  /** Recent trail for the provisional (grey) rendering. */
  provisionalTrail(now: number): TrailPoint[] {
    return this.trail.filter((p) => !p.consumed && now - p.t < 1200);
  }

  trailLength(): number {
    return this.trail.length;
  }

  /**
   * Fuse a tick's fresh ink with the trail. Returns the number of strokes
   * committed this call. Runs stroke extraction even with no fresh ink —
   * otherwise the session's final stroke (whose ink has all been consumed)
   * would never close out and commit.
   */
  fuse(fresh: Pt[], now: number, observedSince?: (x: number, y: number) => number): number {
    if (!fresh.length) return this.extractStrokes(now, observedSince);

    // Spatial grid over fresh ink.
    const grid = new Map<number, Pt[]>();
    const key = (cx: number, cy: number) => cy * 4096 + cx;
    for (const p of fresh) {
      const k = key(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(p);
    }

    const usedInk = new Set<Pt>();

    // Confirm trail points against nearby ink; snap to the ink centroid.
    for (const tp of this.trail) {
      if (tp.consumed || tp.inkConfirmed || now - tp.t > FUSE_WINDOW_MS) continue;
      const cx = Math.floor(tp.x / CELL);
      const cy = Math.floor(tp.y / CELL);
      let sx = 0;
      let sy = 0;
      let cnt = 0;
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const cell = grid.get(key(gx, gy));
          if (!cell) continue;
          for (const ip of cell) {
            const d = Math.hypot(ip.x - tp.x, ip.y - tp.y);
            if (d <= CONFIRM_RADIUS) {
              sx += ip.x;
              sy += ip.y;
              cnt++;
              usedInk.add(ip);
            }
          }
        }
      }
      if (cnt > 0) {
        tp.inkConfirmed = true;
        tp.snapX = sx / cnt;
        tp.snapY = sy / cnt;
      }
    }

    const committed = this.extractStrokes(now, observedSince);

    // Orphan ink: fresh pixels claimed by NO trail point — consumed ones
    // included. Ink emerges 1–2 ticks late (the tip disk masks it), often
    // after its trail points were already committed; that ink is already
    // represented by the stroke and must not double-stamp as orphan dots.
    if (this.orphanCtx) {
      const nearAnyTrail = (p: Pt): boolean => {
        for (const tp of this.trail) {
          if (Math.hypot(tp.x - p.x, tp.y - p.y) <= CONFIRM_RADIUS) return true;
        }
        return false;
      };
      this.orphanCtx.fillStyle = '#26262b';
      for (const [, cell] of grid) {
        const unclaimed = cell.filter((p) => !usedInk.has(p) && !nearAnyTrail(p));
        if (unclaimed.length < ORPHAN_MIN_DENSITY) continue;
        for (const p of unclaimed) {
          this.orphanCtx.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5);
          this.orphanPixels++;
        }
      }
    }
    return committed;
  }

  /**
   * Group confirmed trail points into time-contiguous strokes, bridging
   * short unconfirmed runs (momentary occlusion mid-stroke).
   */
  private extractStrokes(now: number, observedSince?: (x: number, y: number) => number): number {
    let committed = 0;
    let run: FusePoint[] = [];
    let pendingBridge: FusePoint[] = [];

    /**
     * `forced` = the run is being committed mid-growth (its head is about
     * to age out of the trail). The stroke stays "open": the next run that
     * starts where it ended, soon after, is appended to it — one long
     * physical stroke commits in chapters but renders as one stroke.
     */
    const flush = (forced = false): void => {
      if (run.length >= MIN_STROKE_POINTS && this.passesStubGate(run)) {
        const pts = run.map((p) => ({ x: p.snapX, y: p.snapY, t: p.t }));
        const open = this.openStrokeIdx >= 0 ? this.strokes[this.openStrokeIdx] : null;
        const tail = open ? open.points[open.points.length - 1] : null;
        let target = -1;
        if (
          open && tail &&
          pts[0].t - tail.t <= STROKE_GAP_MS &&
          Math.hypot(pts[0].x - tail.x, pts[0].y - tail.y) <= MAX_JOIN_DIST
        ) {
          open.points.push(...pts);
          target = this.openStrokeIdx;
        } else {
          this.strokes.push({ points: pts });
          target = this.strokes.length - 1;
        }
        this.openStrokeIdx = forced ? target : -1;
        committed++;
      }
      // Always consume — even dropped stubs. Confirmed-unconsumed points
      // block trail eviction (see addTrailPoint) and would pin the trail.
      for (const p of run) p.consumed = true;
      run = [];
      pendingBridge = [];
    };

    /**
     * Mask-aware pending: a point's ink cannot confirm until its page pixel
     * has been UNMASKED for ~2 ink ticks — and the hand can cover it for
     * seconds. A fixed wall-clock window here is what used to shred long
     * strokes into fragments per occlusion episode.
     */
    const isPending = (tp: FusePoint): boolean => {
      if (tp.inkConfirmed) return false;
      const obs = observedSince ? observedSince(tp.x, tp.y) : tp.t;
      return now - Math.max(tp.t, obs) < PENDING_OBS_MS; // obs=∞ while masked ⇒ pending
    };

    // Force-commit fires ONLY at the pending boundary / scan end — never
    // per-point. Mid-scan it would flush after every point of an old
    // confirmed backlog, shredding it into one-point runs that the stub
    // gate then drops (and consumes): silent data loss.
    const forceCommitIfAging = (): void => {
      if (run.length && now - run[0].t > FORCE_COMMIT_AGE_MS) flush(true);
    };

    let stoppedPending = false;
    for (const tp of this.trail) {
      if (tp.consumed) {
        flush();
        continue;
      }
      if (isPending(tp)) {
        // Commit the aging run-so-far before trail eviction reaches its head.
        forceCommitIfAging();
        stoppedPending = true;
        break;
      }
      if (tp.inkConfirmed) {
        if (run.length) {
          const last = run[run.length - 1];
          const gap = tp.t - last.t;
          const jump = Math.hypot(tp.x - last.x, tp.y - last.y);
          if (gap > STROKE_GAP_MS || jump > MAX_JOIN_DIST) {
            flush();
          } else {
            run.push(...pendingBridge);
            pendingBridge = [];
          }
        }
        run.push(tp);
      } else if (run.length) {
        const sinceLast = tp.t - run[run.length - 1].t;
        if (sinceLast <= BRIDGE_MAX_MS && pendingBridge.length < BRIDGE_MAX_POINTS) {
          pendingBridge.push(tp);
        } else {
          flush();
        }
      }
    }
    // Do NOT flush the final open run immediately: its confirmation may
    // still be in flight (ink lags the tip by ~2 ink ticks). And when the
    // scan stopped at PENDING points, the run is still actively growing —
    // the "quiet" test below would misfire on every call (the pending cut
    // makes the run's tail look old) and shred one stroke into fragments.
    // Only close out a run when the WHOLE trail was scanned and the run
    // has genuinely gone quiet.
    if (!stoppedPending && run.length >= MIN_STROKE_POINTS) {
      const last = run[run.length - 1];
      const newest = this.trail[this.trail.length - 1];
      const quietTrail = newest && newest.t - last.t > STROKE_GAP_MS;
      const quietClock = now - last.t > STROKE_GAP_MS * 2;
      if (quietTrail || quietClock) flush();
      else forceCommitIfAging();
    }
    return committed;
  }
}
