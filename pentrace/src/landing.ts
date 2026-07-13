// Landing-page motion: scroll reveals + the three "how it works" mini scenes.
// Kept deliberately light — no framework, respects reduced-motion.

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- scroll reveals ----
const reveals = document.querySelectorAll<HTMLElement>('.reveal:not(.in)');
if (reduce) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e, i) => {
        if (e.isIntersecting) {
          const el = e.target as HTMLElement;
          setTimeout(() => el.classList.add('in'), (i % 3) * 90);
          io.unobserve(el);
        }
      });
    },
    { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
  );
  reveals.forEach((el) => io.observe(el));
}

// ---- mini scene canvases (the 3 how-it-works tiles) ----
type Scene = 'track' | 'confirm' | 'digitize';

function miniScene(host: HTMLElement, kind: Scene): void {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => {
    c.width = host.clientWidth * dpr;
    c.height = host.clientHeight * dpr;
  };
  c.style.width = '100%';
  c.style.height = '100%';
  host.appendChild(c);
  resize();
  window.addEventListener('resize', resize);
  const ctx = c.getContext('2d')!;

  // A short handwriting path (unit coords) shared by all scenes.
  const path: [number, number][] = [
    [0.15, 0.55], [0.2, 0.35], [0.26, 0.6], [0.32, 0.4], [0.38, 0.62],
    [0.46, 0.34], [0.52, 0.62], [0.6, 0.4], [0.68, 0.6], [0.76, 0.42], [0.85, 0.55],
  ];

  let t = 0;
  const accent = '#4f8cff';
  const ok = '#3ecf8e';

  function draw() {
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    t = (t + 0.006) % 1.35; // includes a pause past 1.0
    const prog = Math.min(1, t);

    // baseline rule
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.62);
    ctx.lineTo(w, h * 0.62);
    ctx.stroke();

    const pt = (i: number): [number, number] => [path[i][0] * w, path[i][1] * h];
    const nSeg = path.length - 1;
    const upto = prog * nSeg;

    // ink already laid (confirm/digitize show it filled; track shows a faint guide)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind !== 'track') {
      ctx.strokeStyle = kind === 'digitize' ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      const [x0, y0] = pt(0);
      ctx.moveTo(x0, y0);
      for (let i = 1; i <= Math.floor(upto); i++) {
        const [x, y] = pt(i);
        ctx.lineTo(x, y);
      }
      const frac = upto - Math.floor(upto);
      if (Math.floor(upto) < nSeg) {
        const [ax, ay] = pt(Math.floor(upto));
        const [bx, by] = pt(Math.floor(upto) + 1);
        ctx.lineTo(ax + (bx - ax) * frac, ay + (by - ay) * frac);
      }
      ctx.stroke();
    } else {
      // track: guide + moving crosshair
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      const [x0, y0] = pt(0);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < path.length; i++) ctx.lineTo(...pt(i));
      ctx.stroke();
    }

    // moving pen position
    let px = 0;
    let py = 0;
    const seg = Math.min(nSeg - 1e-6, upto);
    const si = Math.floor(seg);
    const sf = seg - si;
    const [ax, ay] = pt(si);
    const [bx, by] = pt(Math.min(nSeg, si + 1));
    px = ax + (bx - ax) * sf;
    py = ay + (by - ay) * sf;

    if (prog < 1) {
      if (kind === 'confirm') {
        // ink-confirmed pulse ring
        ctx.strokeStyle = ok;
        ctx.lineWidth = 2 * dpr;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(px, py, (8 + (t * 40) % 14) * dpr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = kind === 'confirm' ? ok : accent;
      ctx.beginPath();
      ctx.arc(px, py, 4.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = kind === 'confirm' ? ok : accent;
      ctx.lineWidth = 1.5 * dpr;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(px, py, 9 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // digitize: crisp typed word resolves in the second half
    if (kind === 'digitize') {
      const a = Math.max(0, Math.min(1, (prog - 0.5) * 3));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${16 * dpr}px 'IBM Plex Sans', sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText('note', w * 0.16, h * 0.28);
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = ok;
      ctx.font = `${9 * dpr}px 'IBM Plex Mono', monospace`;
      ctx.fillText('RECOGNIZED', w * 0.16 + 62 * dpr, h * 0.28);
      ctx.globalAlpha = 1;
    }

    requestAnimationFrame(draw);
  }
  if (reduce) {
    t = 1;
    draw();
  } else {
    requestAnimationFrame(draw);
  }
}

document.querySelectorAll<HTMLElement>('[data-anim]').forEach((el) => {
  miniScene(el, el.dataset.anim as Scene);
});

export {};
