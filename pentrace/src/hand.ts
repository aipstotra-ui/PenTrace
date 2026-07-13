import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { Pt } from './types';

// MediaPipe hand landmark indices used across the pipeline.
export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_MCP = 5;
export const INDEX_PIP = 6;
export const INDEX_TIP = 8;
export const MIDDLE_MCP = 9;

export interface HandResult {
  /** 21 landmarks in video pixel coords. */
  points: Pt[];
  /** Generously dilated convex hull (video px) — masks hand AND its shadow fringe. */
  hull: Pt[];
}

const HULL_SCALE = 1.4; // expansion about the centroid
const HULL_PAD = 24; // extra pixels outward, absorbs shadow fringe

export class HandTracker {
  private constructor(private landmarker: HandLandmarker) {}

  static async create(preferDelegate: 'GPU' | 'CPU' = 'GPU'): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe-wasm');
    const options = {
      baseOptions: {
        modelAssetPath: '/models/hand_landmarker.task',
        delegate: preferDelegate,
      },
      runningMode: 'VIDEO' as const,
      numHands: 2, // the other hand usually holds the paper — it must be masked too
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    let landmarker: HandLandmarker;
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      if (preferDelegate === 'CPU') throw new Error('HandLandmarker CPU init failed');
      // Some machines lack usable WebGL for the GPU delegate — fall back to CPU.
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' as const },
      });
    }
    return new HandTracker(landmarker);
  }

  /** timestamps must be strictly increasing for VIDEO mode. */
  private lastTs = -1;

  detect(source: TexImageSource, tsMs: number, w: number, h: number): HandResult[] {
    const ts = Math.max(Math.floor(tsMs), this.lastTs + 1);
    this.lastTs = ts;
    const res = this.landmarker.detectForVideo(source, ts);
    const out: HandResult[] = [];
    for (const lm of res.landmarks ?? []) {
      if (lm.length < 21) continue;
      const points = lm.map((p) => ({ x: p.x * w, y: p.y * h }));
      out.push({ points, hull: dilatedHull(points) });
    }
    return out;
  }
}

/** Andrew's monotone chain convex hull. */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0)
      lower.pop();
    lower.push(pt);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0)
      upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function dilatedHull(points: Pt[]): Pt[] {
  // The 21 landmarks stop at the wrist, but the forearm continues across
  // the page. Seed extra points projected from the wrist along the
  // (wrist − middle MCP) direction so the hull covers the arm wedge.
  const wrist = points[WRIST];
  const mcp = points[MIDDLE_MCP];
  const ax = wrist.x - mcp.x;
  const ay = wrist.y - mcp.y;
  const L = Math.hypot(ax, ay) || 1;
  const ux = ax / L;
  const uy = ay / L;
  const px = -uy;
  const py = ux;
  const seeded = points.concat([
    { x: wrist.x + ux * 2.5 * L, y: wrist.y + uy * 2.5 * L },
    { x: wrist.x + ux * 2.5 * L + px * 0.9 * L, y: wrist.y + uy * 2.5 * L + py * 0.9 * L },
    { x: wrist.x + ux * 2.5 * L - px * 0.9 * L, y: wrist.y + uy * 2.5 * L - py * 0.9 * L },
  ]);
  const hull = convexHull(seeded);
  if (hull.length < 3) return hull;
  let cx = 0;
  let cy = 0;
  for (const p of hull) {
    cx += p.x;
    cy += p.y;
  }
  cx /= hull.length;
  cy /= hull.length;
  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const grow = HULL_SCALE + HULL_PAD / len;
    return { x: cx + dx * grow, y: cy + dy * grow };
  });
}

/** Landmark connection pairs for the debug skeleton overlay. */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
