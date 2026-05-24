# Project Bluff Frontend UI Design Standards

This document is the source of truth for Project Bluff frontend design work. Any new screen, control, or component should follow this before implementation.

Project Bluff is a live game soundtrack controller. The interface should feel like a compact production console: dark, sharp, fast, readable under pressure, and built for repeated use on mobile.

## Core Direction

- Build a control console, not a marketing page.
- Keep the app dense, dark, square, and operational.
- Use charcoal surfaces, crisp borders, and burnt orange command accents.
- Use green only for live/success states, amber for pending/warning, and red for danger or destructive controls.
- Avoid decorative UI: no gradients, glows, blurred blobs, glass effects, hero sections, novelty type, or illustrations.
- Every visible element should earn its space.

## Required Tokens

Use the Project Bluff token set in `styles.css` as the base system:

```css
:root {
  --pg-bg: #050505;
  --pg-rail: #0a0a0a;
  --pg-surface: #0f0f0f;
  --pg-surface-raised: #151311;
  --pg-surface-inset: #080808;
  --pg-surface-strong: #1c1814;
  --pg-border: #2a2520;
  --pg-border-strong: #40362d;
  --pg-text: #f2eee8;
  --pg-text-muted: #c9beb2;
  --pg-text-dim: #8f8378;
  --pg-orange: #f97316;
  --pg-orange-strong: #ff9a3d;
  --pg-orange-soft: #2a1608;
  --pg-orange-border: #8a4518;
  --pg-live: #22c55e;
  --pg-danger: #ef4444;
}
```

## Components

- All authored controls use `border-radius: 0`.
- Buttons are flat, bordered, square-edged, and compact.
- Primary/active/focused state is orange.
- Destructive actions use red borders and dark red fills.
- Progress bars are flat rectangular meters with solid fills.
- Text that labels operational state can be uppercase, but keep letter spacing at `0.04em` or lower.
- Do not scale font sizes with viewport width.
- Keep status copy short and factual.

## Mobile Layout

- Use tight outer padding, generally `8px` to `10px`.
- Keep persistent controls in framed rails or panels.
- Stage buttons may be large enough for reliable touch use, but they should still be square, flat, and dense.
- Avoid large empty vertical gaps.
- Do not add page-level cards, hero copy, or decorative sections.

## Review Checklist

- No rounded corners.
- No gradients.
- No decorative glows.
- Orange is the primary command/active color.
- The UI remains compact on mobile.
- Text fits without awkward overflow.
- Important state is expressed with text, not color alone.
