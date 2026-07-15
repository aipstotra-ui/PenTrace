// Shared scroll-reveal: adds .in to .reveal elements as they enter the
// viewport. Respects reduced-motion (everything shown immediately).

export const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches;

export function initReveals(staggerMs = 0): void {
  const reveals = document.querySelectorAll<HTMLElement>('.reveal:not(.in)');
  if (prefersReducedMotion) {
    reveals.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e, i) => {
        if (e.isIntersecting) {
          const el = e.target as HTMLElement;
          if (staggerMs) setTimeout(() => el.classList.add('in'), (i % 3) * staggerMs);
          else el.classList.add('in');
          io.unobserve(el);
        }
      });
    },
    { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
  );
  reveals.forEach((el) => io.observe(el));
}
