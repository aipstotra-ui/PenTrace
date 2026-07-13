// Pricing/waitlist page: reveals + local waitlist capture.
// No backend — stores the address locally and confirms. Swap storeEmail() for
// a real API/Formspree/Supabase call when the backend lands.

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveals = document.querySelectorAll<HTMLElement>('.reveal:not(.in)');
if (reduce) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.2 },
  );
  reveals.forEach((el) => io.observe(el));
}

const form = document.getElementById('waitlistForm') as HTMLFormElement;
const email = document.getElementById('waitlistEmail') as HTMLInputElement;
const note = document.getElementById('formNote') as HTMLElement;
const success = document.getElementById('waitlistSuccess') as HTMLElement;
const successEmail = document.getElementById('successEmail') as HTMLElement;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function storeEmail(addr: string): void {
  try {
    const key = 'pentrace_waitlist';
    const list: string[] = JSON.parse(localStorage.getItem(key) || '[]');
    if (!list.includes(addr)) list.push(addr);
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* private-mode / storage disabled — confirmation still shows */
  }
}

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const addr = email.value.trim();
  if (!EMAIL_RE.test(addr)) {
    note.textContent = 'Please enter a valid email address.';
    note.style.color = 'var(--margin)';
    email.focus();
    return;
  }
  storeEmail(addr);
  successEmail.textContent = addr;
  form.style.display = 'none';
  note.style.display = 'none';
  success.classList.add('show');
});

export {};
