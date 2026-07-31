// The app's icon, and the sweep it was always describing.
//
// The wizard wore a red rounded square with an `H` in it — a placeholder, on
// every screen, of an app that has an actual icon. This is that icon, ported
// from `frontend/public/favicon.svg`, whose own comment says what it is:
//
//     Hrdle - a scanner mid-sweep.
//     Geometry: 11 segments / lamp at 0.33 (left of center) / band folded by
//     S*0.028 (a shallow V dipping at the center) / slit 0.78 x 0.155S /
//     glow rgb(255, 39, 24).
//
// "Mid-sweep" is the whole reason this animates. The static mark is one frame of
// something moving — the lamp sitting left of centre is a scan caught partway
// across — so the animation is not decoration added to a logo, it is the rest of
// the picture. Eleven segments, one travelling peak, and the still frame is what
// you see if you pause it a third of the way along.
//
// Drawn rather than embedded: the PNG is 512x512 and would have to be inlined as
// base64 in an ehpk that pays for every kilobyte, and a bitmap cannot sweep.
// Every number below is the SVG's, so the two cannot drift apart.

/** Segment count, from the source geometry. */
const SEGMENTS = 11

/**
 * The still frame's own opacities, lamp by lamp, straight from `favicon.svg`.
 *
 * The source draws only the seven it can see — the light is parked left of
 * centre, so the right of the band is dark enough to leave out entirely. Those
 * four are written here as the near-nothing they are, because the sweep needs
 * something to light up when it reaches them.
 *
 * Carried as SVG presentation attributes rather than CSS, which is what lets a
 * running animation override them and a stopped one fall back to exactly the
 * picture the icon has always been.
 */
const REST = [0.06, 0.25, 0.65, 0.96, 0.76, 0.33, 0.09, 0.03, 0.02, 0.02, 0.02]
const REST_CORE = [0, 0, 0.25, 0.91, 0.49, 0, 0, 0, 0, 0, 0]

/** Seconds for the peak to travel the whole band once. */
const CYCLE = 5

// The band: a shallow V, its ends high and its middle dipped.
const SLIT_LEFT = 56.32
const SLIT_RIGHT = 455.68
const SLIT_TOP_END = 201.98
const SLIT_TOP_MID = 216.32
const SLIT_HEIGHT = 79.36
const CENTRE = 256

const SLIT_PATH =
  'M56.32 201.98L256 216.32L455.68 201.98L455.68 281.34L256 295.68L56.32 281.34Z'
const FRAME_PATH =
  'M43.01 188.67L256 203.01L468.99 188.67L468.99 294.66L256 308.99L43.01 294.66Z'

/** Top edge of the band at `x` — the fold, evaluated rather than hardcoded. */
function topAt(x: number): number {
  const toEnd = Math.abs(x - CENTRE) / (CENTRE - SLIT_LEFT)
  return SLIT_TOP_END + (SLIT_TOP_MID - SLIT_TOP_END) * (1 - toEnd)
}

/**
 * One lamp, as a quadrilateral following the fold.
 *
 * They are drawn as separate shapes rather than a striped fill because each one
 * has to be able to light on its own — that is what makes a sweep out of a row
 * of bars.
 */
function lamp(index: number, inset: number, fill: string, cls: string, rest: number): string {
  const pitch = (SLIT_RIGHT - SLIT_LEFT) / SEGMENTS
  const x0 = SLIT_LEFT + index * pitch + pitch * 0.07
  const x1 = x0 + pitch * 0.86
  const t0 = topAt(x0) + inset
  const t1 = topAt(x1) + inset
  const h = SLIT_HEIGHT - inset * 2
  return `<path class="${cls}" opacity="${rest}" style="animation-delay:${(-index * (CYCLE / SEGMENTS)).toFixed(3)}s"
    d="M${x0.toFixed(2)} ${t0.toFixed(2)}L${x1.toFixed(2)} ${t1.toFixed(2)}L${x1.toFixed(2)} ${(t1 + h).toFixed(2)}L${x0.toFixed(2)} ${(t0 + h).toFixed(2)}Z"
    fill="${fill}"/>`
}

/**
 * One icon at `size` pixels.
 *
 * `uid` suffixes every internal id. Two of these can sit on the same screen —
 * the header mark and the large one on the first — and SVG ids are
 * document-global, so without it the second icon's gradients would silently
 * take over the first.
 *
 * `sweep: false` renders the still frame: the lamps keep the source's fixed
 * opacities and nothing moves.
 */
export function brandIcon(uid: string, size: number, sweep = true): string {
  const cls = sweep ? 'bi-lamp' : 'bi-lamp bi-still'
  const core = sweep ? 'bi-core' : 'bi-core bi-still'
  const lamps: string[] = []
  for (let i = 0; i < SEGMENTS; i++) {
    lamps.push(lamp(i, 0, 'rgb(255,39,24)', cls, REST[i]))
    // The hot centre. Only the brightest lamps blow out to white, so this layer
    // is inset and rides a shorter, later part of the same cycle.
    lamps.push(lamp(i, 7.94, 'rgb(255,232,222)', core, REST_CORE[i]))
  }

  return `
    <svg class="bi" width="${size}" height="${size}" viewBox="0 0 512 512"
         role="img" aria-label="Hrdle">
      <defs>
        <linearGradient id="bi-case-${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#26292c"/>
          <stop offset="0.5" stop-color="#141618"/>
          <stop offset="1" stop-color="#08090a"/>
        </linearGradient>
        <radialGradient id="bi-spill-${uid}">
          <stop offset="0" stop-color="rgb(255,39,24)" stop-opacity="0.42"/>
          <stop offset="1" stop-color="rgb(255,39,24)" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="bi-frame-${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
          <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.05"/>
          <stop offset="1" stop-color="#000000" stop-opacity="0.6"/>
        </linearGradient>
        <clipPath id="bi-slit-${uid}"><path d="${SLIT_PATH}"/></clipPath>
      </defs>

      <rect width="512" height="512" rx="112.64" fill="url(#bi-case-${uid})"/>

      <!-- The light spills onto the panel, wider than it is tall. It travels
           with the lamps, a little behind them. -->
      <ellipse class="${sweep ? 'bi-spill' : 'bi-spill bi-still'}"
               cx="188.11" cy="251.13" rx="184.32" ry="66.56" fill="url(#bi-spill-${uid})"/>

      <!-- The recess behind the band -->
      <path d="${SLIT_PATH}" fill="#160607"/>

      <g clip-path="url(#bi-slit-${uid})">${lamps.join('')}</g>

      <!-- Frame: light on top, shadow below -->
      <path d="${FRAME_PATH}" fill="none" stroke="url(#bi-frame-${uid})"
            stroke-width="3.58" stroke-linejoin="round"/>
    </svg>
  `
}

/**
 * Styles for the icon.
 *
 * The cycle is deliberately slow. This sits at the top of every screen of a
 * setup someone is reading, and a mark that insists on being watched is one they
 * end up reading around. Five seconds for a full pass, most of which each lamp
 * spends dark.
 *
 * `bi-still` freezes the whole thing at the source artwork's own frame, which is
 * also what a reader who has asked for less motion gets.
 */
export const BRAND_CSS = `
  .bi { display:block; }
  /* No opacity declared here on purpose: a CSS rule would beat the presentation
     attribute each lamp carries, and that attribute is the still frame. A
     running animation overrides it; a stopped one leaves the original picture. */
  .bi-lamp { animation: bi-lamp 5s linear infinite; }
  .bi-core { animation: bi-core 5s linear infinite; }
  .bi-spill { animation: bi-spill 5s linear infinite; }
  /* These keyframes are the icon's own brightness profile, read across the band
     and replayed through time. Each lamp starts one eleventh of a cycle further
     along than the one to its left, so at any instant the eleven of them hold
     the same distribution the still artwork does — 0.06, 0.25, 0.65, 0.96,
     0.76, 0.33, 0.09 and then dark. The picture does not pulse; it travels. */
  @keyframes bi-lamp {
    0%    { opacity: 0.06 }
    9.1%  { opacity: 0.25 }
    18.2% { opacity: 0.65 }
    27.3% { opacity: 0.96 }
    36.4% { opacity: 0.76 }
    45.5% { opacity: 0.33 }
    54.5% { opacity: 0.09 }
    63.6% { opacity: 0.03 }
    72.7% { opacity: 0.02 }
    90.9% { opacity: 0.02 }
    100%  { opacity: 0.06 }
  }
  @keyframes bi-core {
    0%    { opacity: 0 }
    9.1%  { opacity: 0 }
    18.2% { opacity: 0.25 }
    27.3% { opacity: 0.91 }
    36.4% { opacity: 0.49 }
    45.5% { opacity: 0 }
    100%  { opacity: 0 }
  }
  /* The spill follows the peak rather than sitting still behind it. */
  @keyframes bi-spill {
    0%   { transform: translateX(0) }
    100% { transform: translateX(399px) }
  }
  .bi-still, .bi-still.bi-lamp, .bi-still.bi-core { animation: none; }
  @media (prefers-reduced-motion: reduce) {
    .bi-lamp, .bi-core, .bi-spill { animation: none; }
  }
`
