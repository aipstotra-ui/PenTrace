export interface Pt {
  x: number;
  y: number;
}

/** A point on the provisional trajectory, in page space. */
export interface TrailPoint extends Pt {
  t: number; // ms timestamp
  conf: number; // 0..1 pen tip confidence
  inkConfirmed: boolean;
}

/** A committed stroke on the digital page, in page space. */
export interface Stroke {
  points: { x: number; y: number; t: number }[];
}

/** Ordered TL, TR, BR, BL in video pixel coords. */
export type Quad = [Pt, Pt, Pt, Pt];

/**
 * Anything the pipeline can consume frames from: live camera, a video file,
 * or the synthetic demo scene. `tipOverride` lets non-camera sources inject
 * a known pen tip position (video coords) so fusion can be exercised without
 * a real hand for MediaPipe to find.
 */
export interface FrameSource {
  readonly kind: 'camera' | 'video' | 'synthetic';
  readonly element: HTMLVideoElement | HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** Advance the source if it is time-driven. Returns false when ended. */
  tick(nowMs: number): boolean;
  tipOverride: Pt | null;
}

export interface PenTip extends Pt {
  conf: number;
}

export const luminance = (r: number, g: number, b: number): number =>
  (r * 77 + g * 150 + b * 29) >> 8;

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
