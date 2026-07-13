import type { FrameSource, Pt } from './types';

/**
 * Synthetic camera: renders a desk, a perspective-skewed paper sheet, and a
 * pen that writes "hi" stroke by stroke — with genuine pen-up travel
 * between strokes and a hand blob shadowing the pen. Because MediaPipe
 * cannot detect a painted hand, the source injects `tipOverride` so the
 * fusion pipeline runs exactly as it would with a live tracked hand.
 *
 * This gives a fully repeatable end-to-end test: paper lock → trajectory →
 * ink diff → ink-confirmed strokes, including the false-stroke rejection
 * case (pen-up hops must leave no marks on the digital page).
 */

const W = 1280;
const H = 720;

// Paper corners in video space (slight perspective, like a sheet on a desk).
const QUAD: [Pt, Pt, Pt, Pt] = [
  { x: 340, y: 150 },
  { x: 950, y: 140 },
  { x: 1010, y: 600 },
  { x: 290, y: 620 },
];

// The word "hi" as unit-square polylines on the paper.
const SCRIPT: Pt[][] = [
  // h stem
  [
    { x: 0.24, y: 0.28 },
    { x: 0.235, y: 0.62 },
  ],
  // h arch
  [
    { x: 0.235, y: 0.46 },
    { x: 0.275, y: 0.4 },
    { x: 0.315, y: 0.44 },
    { x: 0.32, y: 0.62 },
  ],
  // i stem
  [
    { x: 0.41, y: 0.42 },
    { x: 0.415, y: 0.62 },
  ],
  // i dot
  [
    { x: 0.41, y: 0.335 },
    { x: 0.418, y: 0.345 },
  ],
];

const WRITE_SPEED = 0.16; // unit distance per second
const TRAVEL_SPEED = 0.5;
const START_DELAY_MS = 2500; // let the paper lock before the pen arrives
const PEN_HOME: Pt = { x: 0.95, y: 1.15 }; // off the paper, bottom right
const JITTER = 1.2; // px of tracking-like noise on the injected tip

interface Phase {
  kind: 'travel' | 'write';
  path: Pt[]; // unit coords
  startMs: number;
  endMs: number;
  strokeIndex: number; // for 'write', which script stroke this is
}

export class SyntheticSource implements FrameSource {
  readonly kind = 'synthetic' as const;
  readonly element: HTMLCanvasElement;
  readonly width = W;
  readonly height = H;
  tipOverride: Pt | null = null;
  /** Video-space blob covering the fake hand+pen for masking. */
  handBlob: { x: number; y: number; r: number } | null = null;
  penDown = false;

  private ctx: CanvasRenderingContext2D;
  private phases: Phase[] = [];
  private startMs: number | null = null;

  constructor() {
    this.element = document.createElement('canvas');
    this.element.width = W;
    this.element.height = H;
    this.ctx = this.element.getContext('2d')!;
    this.buildTimeline();
  }

  private buildTimeline(): void {
    let t = START_DELAY_MS;
    let pos = PEN_HOME;
    SCRIPT.forEach((stroke, i) => {
      const travel: Pt[] = [pos, stroke[0]];
      const travelMs = (pathLen(travel) / TRAVEL_SPEED) * 1000;
      this.phases.push({ kind: 'travel', path: travel, startMs: t, endMs: t + travelMs, strokeIndex: -1 });
      t += travelMs + 150;

      const writeMs = Math.max(250, (pathLen(stroke) / WRITE_SPEED) * 1000);
      this.phases.push({ kind: 'write', path: stroke, startMs: t, endMs: t + writeMs, strokeIndex: i });
      t += writeMs + 150;
      pos = stroke[stroke.length - 1];
    });
    const exit: Pt[] = [pos, PEN_HOME];
    const exitMs = (pathLen(exit) / TRAVEL_SPEED) * 1000;
    this.phases.push({ kind: 'travel', path: exit, startMs: t, endMs: t + exitMs, strokeIndex: -1 });
  }

  tick(nowMs: number): boolean {
    if (this.startMs === null) this.startMs = nowMs;
    const t = nowMs - this.startMs;
    const ctx = this.ctx;

    // Desk + paper.
    ctx.fillStyle = '#454a55';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f4f1e8';
    ctx.beginPath();
    QUAD.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();

    // Ink written so far.
    ctx.strokeStyle = '#22242c';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let pen: Pt | null = null;
    this.penDown = false;
    for (const ph of this.phases) {
      if (ph.kind !== 'write') continue;
      if (t >= ph.endMs) {
        this.drawInk(ph.path, 1);
      } else if (t >= ph.startMs) {
        const frac = (t - ph.startMs) / (ph.endMs - ph.startMs);
        this.drawInk(ph.path, frac);
      }
    }

    // Pen position for the active phase.
    const active = this.phases.find((ph) => t >= ph.startMs && t < ph.endMs);
    if (active) {
      const frac = (t - active.startMs) / (active.endMs - active.startMs);
      pen = pointAlong(active.path, frac);
      this.penDown = active.kind === 'write';
    } else if (t < this.phases[0]?.startMs) {
      pen = null; // not arrived yet
    } else {
      pen = null; // finished and left
    }

    if (pen) {
      const v = this.toVideo(pen);
      this.drawPenAndHand(v);
      this.tipOverride = {
        x: v.x + (Math.random() - 0.5) * 2 * JITTER,
        y: v.y + (Math.random() - 0.5) * 2 * JITTER,
      };
    } else {
      this.tipOverride = null;
      this.handBlob = null;
    }
    return true;
  }

  private drawInk(path: Pt[], frac: number): void {
    const pts = partialPath(path, frac).map((p) => this.toVideo(p));
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }

  private drawPenAndHand(tip: Pt): void {
    const ctx = this.ctx;
    // Hand blob trailing lower-right of the nib.
    const hx = tip.x + 70;
    const hy = tip.y + 80;
    ctx.fillStyle = '#c9a58a';
    ctx.beginPath();
    ctx.ellipse(hx, hy, 62, 46, -0.5, 0, Math.PI * 2);
    ctx.fill();
    this.handBlob = { x: hx, y: hy, r: 135 };
    // Pen body from nib toward the hand.
    ctx.strokeStyle = '#2a2d36';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + 55, tip.y + 62);
    ctx.stroke();
  }

  /** Bilinear map from unit paper coords to video coords. */
  private toVideo(p: Pt): Pt {
    const [tl, tr, br, bl] = QUAD;
    const top = { x: tl.x + (tr.x - tl.x) * p.x, y: tl.y + (tr.y - tl.y) * p.x };
    const bot = { x: bl.x + (br.x - bl.x) * p.x, y: bl.y + (br.y - bl.y) * p.x };
    return { x: top.x + (bot.x - top.x) * p.y, y: top.y + (bot.y - top.y) * p.y };
  }
}

function pathLen(path: Pt[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return l;
}

/** Point at fraction `f` of the path's arc length. */
function pointAlong(path: Pt[], f: number): Pt {
  const total = pathLen(path);
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < path.length; i++) {
    const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (target <= seg) {
      const u = seg ? target / seg : 0;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * u,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * u,
      };
    }
    target -= seg;
  }
  return path[path.length - 1];
}

/** The path truncated at fraction `f` of its arc length. */
function partialPath(path: Pt[], f: number): Pt[] {
  if (f >= 1) return path;
  const total = pathLen(path);
  let target = Math.max(0, f) * total;
  const out: Pt[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (target <= seg) {
      const u = seg ? target / seg : 0;
      out.push({
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * u,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * u,
      });
      return out;
    }
    out.push(path[i]);
    target -= seg;
  }
  return out;
}
