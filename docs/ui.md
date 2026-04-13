# UI conventions

Established by Phase 4.A (#66). Later Phase 4 PRs inherit from this.
If you find yourself wanting to break a rule here, open an issue and
propose the change — don't silently diverge.

## Styling approach: **Tailwind classes inline**

We do **not** maintain a `components/ui/` directory of Button / Card /
Input primitives. Every component uses Tailwind utility classes
directly. This was a deliberate choice in Phase 4.A:

- The existing statusphere starter components (`LoginForm`,
  `LogoutButton`, `StatusPicker`) already do it this way.
- A design-system layer is speculative abstraction until we see the
  same combination repeated 3+ times. Phase 4 is six issues; the
  pattern hasn't earned its keep yet.
- Every component that would live in `components/ui/` would be a
  trivial wrapper around a `<button>` / `<input>` with one or two
  default class strings. The indirection is more code to read for no
  behavioral win.

If a pattern ends up repeated in enough places that extracting it
would save meaningful code, extract it **at that point** — not
preemptively.

## Colors

**Neutral:** Tailwind's `zinc-*` scale for text, borders, surfaces.

**Accent:** `amber-*`. Exactly one accent color — do not introduce
blue, green, rose, etc. Amber was chosen because it reads as
"perfume/resin/bottled light" without being heavy.

**Light mode tokens:**

- `bg-zinc-50` — page background
- `bg-white` — card / surface background
- `border-zinc-200` — default border
- `text-zinc-900` — primary text
- `text-zinc-600` — secondary text
- `text-zinc-500` — tertiary / metadata
- `text-amber-700` — accent text (links-on-hover, rating numbers)
- `border-amber-600` — accent border (hover state on cards)

**Dark mode tokens:**

- `dark:bg-zinc-950` — page background
- `dark:bg-zinc-900` — card surface
- `dark:border-zinc-800` — default border
- `dark:text-zinc-100` — primary text
- `dark:text-zinc-400` — secondary text
- `dark:text-zinc-500` — tertiary
- `dark:text-amber-400` — accent text
- `dark:border-amber-500` — accent border

Dark mode is `prefers-color-scheme`-driven (not toggled). Both modes
must always work.

## Typography

- `font-sans` — system default. **No web-font imports.** Do not add
  `next/font/google` or similar.
- Headings: `font-semibold tracking-tight`
- Body: default weight
- Sizes: `text-4xl` (page title), `text-lg` (section heading),
  `text-sm` (body copy, nav, buttons), `text-xs` (metadata, chips,
  timestamps)

## Shape and spacing

- Buttons: `rounded-md`, `px-3 py-1.5`, `text-sm font-medium`
- Cards: `rounded-lg`, `p-4` or `p-6`, `border`
- Chips / pills: `rounded-full`, `px-2 py-0.5`, `text-xs`
- Page container: `mx-auto w-full max-w-5xl px-4`
- Vertical rhythm: `space-y-12` between top-level sections,
  `space-y-3` or `space-y-4` between list items

## Component reuse

Share **components**, not class strings. If a tile / row / card is
used on two pages, extract it as a React component and export it from
`components/`. Do not extract a shared `className` constant — that
loses the ability to see the component's style at a glance and
doesn't compose well with Tailwind's JIT.

## What's NOT allowed

- New UI component libraries (shadcn, headless-ui, radix, mui).
- `framer-motion` or other animation libs. CSS transitions only.
- Icon libraries (react-icons, lucide). If you need an icon, inline
  an SVG.
- Web fonts via `next/font`.
- CSS-in-JS (styled-components, emotion).
- Global CSS classes beyond what Tailwind provides. Keep
  `app/globals.css` minimal — it should only contain `@import
  "tailwindcss"` and a documentation header.
