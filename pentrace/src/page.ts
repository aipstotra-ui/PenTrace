import type { StrokeStore } from './strokes';

/**
 * Digital page renderer: committed strokes in ink-black with midpoint
 * quadratic smoothing, orphan ink raster beneath, provisional trail in
 * fading grey on top.
 */
export class PageRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setPageSize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  render(store: StrokeStore, now: number, showTrail: boolean): void {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Faint ruled lines make it feel like a page, not a canvas.
    ctx.strokeStyle = 'rgba(90, 130, 200, 0.12)';
    ctx.lineWidth = 1;
    for (let y = 60; y < canvas.height; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    if (store.orphanCanvas) ctx.drawImage(store.orphanCanvas, 0, 0);

    ctx.strokeStyle = '#1c1c22';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of store.strokes) {
      const pts = stroke.points;
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    }

    if (showTrail) {
      const trail = store.provisionalTrail(now);
      for (let i = 1; i < trail.length; i++) {
        const age = (now - trail[i].t) / 1200;
        ctx.strokeStyle = `rgba(120, 128, 150, ${Math.max(0, 0.5 * (1 - age))})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    }
  }

  exportPNG(): void {
    const a = document.createElement('a');
    a.download = `pentrace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.href = this.canvas.toDataURL('image/png');
    a.click();
  }

  snapshot(): ImageData {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }
}
