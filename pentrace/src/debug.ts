import type { HandResult } from './hand';
import { HAND_CONNECTIONS } from './hand';
import type { PenTip, Quad } from './types';

export function drawHand(ctx: CanvasRenderingContext2D, hand: HandResult): void {
  ctx.strokeStyle = 'rgba(80, 220, 140, 0.9)';
  ctx.lineWidth = 2;
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(hand.points[a].x, hand.points[a].y);
    ctx.lineTo(hand.points[b].x, hand.points[b].y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(80, 220, 140, 0.9)';
  for (const p of hand.points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(80, 220, 140, 0.35)';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  hand.hull.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawQuad(ctx: CanvasRenderingContext2D, quad: Quad, locked: boolean): void {
  ctx.strokeStyle = locked ? 'rgba(79, 140, 255, 0.95)' : 'rgba(245, 166, 35, 0.9)';
  ctx.lineWidth = locked ? 3 : 2;
  ctx.beginPath();
  quad.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  const labels = ['TL', 'TR', 'BR', 'BL'];
  ctx.fillStyle = ctx.strokeStyle;
  ctx.font = '12px ui-monospace, monospace';
  quad.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(labels[i], p.x + 8, p.y - 8);
  });
}

export function drawTip(ctx: CanvasRenderingContext2D, tip: PenTip): void {
  const c = tip.conf > 0.45 ? 'rgba(255, 80, 90, 0.95)' : 'rgba(255, 200, 80, 0.8)';
  ctx.strokeStyle = c;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tip.x - 14, tip.y);
  ctx.lineTo(tip.x + 14, tip.y);
  ctx.moveTo(tip.x, tip.y - 14);
  ctx.lineTo(tip.x, tip.y + 14);
  ctx.stroke();
}

/** Exponentially-smoothed FPS meter. */
export class FpsMeter {
  private last = 0;
  private ema = 0;

  tick(now: number): number {
    if (this.last) {
      const inst = 1000 / Math.max(1, now - this.last);
      this.ema = this.ema ? this.ema * 0.9 + inst * 0.1 : inst;
    }
    this.last = now;
    return this.ema;
  }
}
