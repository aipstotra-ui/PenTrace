import type { Stroke } from './types';

/**
 * Recognition seam. The tracking demo ships with a stub; the production
 * engine is Claude vision (chosen for state-of-the-art handwriting accuracy
 * across diverse styles, ~1.3% CER class on IAM-style benchmarks).
 *
 * ClaudeEngine sketch (next phase):
 *  - render `strokes` onto a clean white canvas (this is BETTER input than
 *    a webcam photo: uniform lighting, no perspective, no hand shadows —
 *    the whole point of capture-while-writing);
 *  - attach the rectified page crop as a second image for cross-checking;
 *  - POST to the Messages API (model: claude-fable-5 or claude-sonnet-5)
 *    with both images and a transcription prompt, temperature 0;
 *  - stroke timing/order can be serialized as a compact polyline JSON and
 *    included for disambiguation of overwritten or crossed-out text.
 */
export interface RecognitionEngine {
  recognize(strokes: Stroke[], pageImage: ImageData): Promise<string>;
}

export class StubEngine implements RecognitionEngine {
  async recognize(strokes: Stroke[], pageImage: ImageData): Promise<string> {
    const points = strokes.reduce((n, s) => n + s.points.length, 0);
    if (!strokes.length) {
      return 'Nothing captured yet — write on the paper (or run the synthetic demo) first.';
    }
    const span = strokeTimeSpan(strokes);
    return [
      `Captured ${strokes.length} stroke${strokes.length === 1 ? '' : 's'} ` +
        `(${points} timed points over ${(span / 1000).toFixed(1)}s) ` +
        `on a ${pageImage.width}×${pageImage.height}px page.`,
      '',
      'Recognition engine: STUB. Next phase wires this to Claude vision — ' +
        'the stroke render + rectified page crop above is exactly the payload it will receive.',
    ].join('\n');
  }
}

function strokeTimeSpan(strokes: Stroke[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      min = Math.min(min, p.t);
      max = Math.max(max, p.t);
    }
  }
  return max > min ? max - min : 0;
}
