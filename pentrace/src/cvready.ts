/**
 * opencv.js is loaded via a plain <script> tag (it is a ~10MB Emscripten
 * build; bundling it through Vite is slow and pointless). Depending on the
 * build, the global `cv` is either a Module object that fires
 * `onRuntimeInitialized`, or a thenable that resolves to the module.
 * This helper normalizes both into one awaited, ready-to-use handle.
 */

let cvInstance: any = null;

export function getCV(): any {
  if (!cvInstance) throw new Error('OpenCV not ready — call waitForOpenCV() first');
  return cvInstance;
}

export async function waitForOpenCV(timeoutMs = 20000): Promise<any> {
  if (cvInstance) return cvInstance;
  const start = performance.now();

  // Wait for the script tag to have created the global at all.
  while (!(window as any).cv) {
    if (performance.now() - start > timeoutMs) throw new Error('opencv.js failed to load');
    await sleep(50);
  }

  let cv = (window as any).cv;
  if (typeof cv.then === 'function') {
    // Emscripten fake-thenable trap: the docs.opencv.org builds ship a
    // Module whose `then(cb)` calls back with the Module ITSELF — which
    // still has `.then`. `await cv` therefore re-chains forever (the
    // resolved value is thenable → promise machinery calls .then again →
    // same self-resolving object → infinite microtask loop) and wedges the
    // renderer at 100% CPU. Never await it: call `then` exactly once and
    // hand the module out via a non-thenable wrapper.
    const wrapped = await new Promise<{ module: any }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('OpenCV factory then() timed out'));
        }
      }, timeoutMs);
      cv.then(
        (m: any) => {
          if (settled) return; // Emscripten may call back more than once
          settled = true;
          clearTimeout(timer);
          resolve({ module: m });
        },
        // A genuine Promise (wasm fetch failure) rejects — surface it now
        // instead of waiting out the timeout. The fake thenable ignores this.
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    cv = wrapped.module;
    try {
      delete cv.then; // make the module safe for anyone else who awaits it
    } catch {
      /* frozen module — fine, we never await it again */
    }
    if (typeof cv.then === 'function') cv.then = undefined; // prototype-hosted then
  } else if (!cv.Mat) {
    await new Promise<void>((resolve, reject) => {
      // Guard against having missed the callback: poll as a fallback.
      const poll = setInterval(() => {
        if (cv.Mat) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('OpenCV runtime init timed out'));
      }, timeoutMs);
      cv.onRuntimeInitialized = () => {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
    });
  }
  if (!cv.Mat) throw new Error('OpenCV loaded but cv.Mat missing');
  cvInstance = cv;
  return cv;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
