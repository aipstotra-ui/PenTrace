# PenTrace — Design System

**Memorable thing:** the ruled page that writes itself. A student should feel their
paper practice is respected by a precise instrument, not scanned by a gadget.

**Voice:** calm, precise, academic. Premium stationery meets a research tool.
Confident, never loud. Trust over hype.

## Color

Light, paper-first. One accent, used with restraint.

| Token | Value | Use |
|-------|-------|-----|
| `--paper` | `#FBFAF6` | page background (warm paper white) |
| `--paper-2` | `#F2F0E8` | raised panels, alt sections |
| `--ink` | `#17171C` | primary text (near-black ink) |
| `--ink-soft` | `#565663` | secondary text |
| `--ink-faint` | `#8A8A97` | captions, meta |
| `--rule` | `#C7D3EA` | notebook rule lines (faint blue) |
| `--accent` | `#2748E0` | fountain-pen royal blue — links, CTAs, key marks |
| `--accent-deep` | `#1B2E8A` | hover/pressed, deep emphasis |
| `--accent-wash` | `#EAEEFC` | tinted backgrounds, chips |
| `--margin` | `#E5533D` | the red margin line — a single warm spark, rare |
| `--ok` | `#1F9E6B` | "captured" / positive |
| `--instrument` | `#12141A` | the dark demo surface (the device) |

## Type

Three families, each with a job.

- **Fraunces** (opsz serif) — headlines, the product's voice. Weights 400–700.
- **IBM Plex Sans** — body, UI, buttons. Weights 400/500/600.
- **IBM Plex Mono** — the "capture / machine" layer: eyebrows, stat labels,
  technical annotations. This is what visually links the marketing site to the
  tracking engine.

Scale (fluid): display `clamp(2.6rem, 6vw, 4.5rem)`, h2 `clamp(1.8rem, 3.5vw, 2.6rem)`,
body `1.05rem`, small `0.9rem`, mono-eyebrow `0.75rem` letterspaced/upper.

## Motion

Quiet and purposeful. Nothing bounces.

- **Hero:** a pen traces handwriting along a ruled line; crisp digital text
  resolves in sync. Loops slowly. This *is* the pitch.
- **Reveals:** fade + 14px rise on scroll, 500ms ease, staggered. Once, not on
  every scroll.
- **Hovers:** 150ms. Buttons lift 1px, links shift accent depth.
- Respect `prefers-reduced-motion`: freeze the hero on its final frame, disable reveals.

## Recurring motifs

- **Ruled paper**: faint blue horizontal rules; occasional red margin line.
- **The mono label**: a small uppercase mono tag above sections ("HOW IT WORKS",
  "01 / TRACK") — the instrument's readout voice.
- **Ink-to-pixel**: the visual throughline — warm handwritten stroke becoming
  crisp digital mark.

## Structure

Three pages, shared nav + footer.
- `index.html` — landing (hero, problem, how-it-works, features, fusion idea, CTA)
- `demo.html` — the live tracking app, framed as the dark instrument
- `pricing.html` — "coming soon" + 50%-off early-access + waitlist

## Anti-slop rules

No purple gradients. No 3-column icon-grid filler. No centered-everything. No
decorative blobs. Every section earns its place and ties back to the memorable
thing. The mono layer and ruled-paper motif carry identity — not stock flourishes.
