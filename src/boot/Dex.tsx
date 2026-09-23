/**
 * The boot device, drawn rather than shipped.
 *
 * Two panels, each its own SVG so the hinge can be a real CSS 3D rotation on an
 * HTML wrapper, a single flat image could not open, and would blur at the zoom
 * peak. Everything here is vector, so the whole intro adds no binary assets.
 *
 * Geometry is traced from the reference: lens and three lamps top-left, a white
 * screen bezel, a red button and speaker grille beneath it, then the lower
 * controls; the right panel carries the dark readouts and the blue keypad.
 */

const OUTLINE = '#1a1a1a'
const BODY = '#cf2434'
const BODY_DARK = '#a4101e'
const BEZEL_WHITE = '#f2efe9'

/** Left panel, the face you see when the device is closed. */
export function DexLeft() {
  return (
    <svg className="dex-svg" viewBox="0 0 300 430" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      {/* case */}
      <rect x="6" y="6" width="288" height="418" rx="20" fill={BODY} stroke={OUTLINE} strokeWidth="7" />
      {/* angular notch across the top, as on the reference */}
      <path d="M196 20 L252 20 L286 54 L286 92" fill="none" stroke={BODY_DARK} strokeWidth="6" strokeLinecap="round" />
      <path d="M186 34 L246 34 L274 62" fill="none" stroke={BODY_DARK} strokeWidth="5" strokeLinecap="round" />

      {/* the big lens */}
      <g className="dex-lens">
        <circle cx="58" cy="60" r="30" fill={BEZEL_WHITE} stroke={OUTLINE} strokeWidth="5" />
        <circle className="dex-lens-glass" cx="58" cy="60" r="22" fill="#29a8e0" stroke={OUTLINE} strokeWidth="3" />
        <circle cx="50" cy="52" r="7" fill="#bfe6fb" opacity="0.9" />
      </g>

      {/* three lamps */}
      <g className="dex-lamps">
        <circle className="dex-lamp l1" cx="116" cy="40" r="9" fill="#e04b45" stroke={OUTLINE} strokeWidth="3" />
        <circle className="dex-lamp l2" cx="146" cy="40" r="9" fill="#f0b429" stroke={OUTLINE} strokeWidth="3" />
        <circle className="dex-lamp l3" cx="176" cy="40" r="9" fill="#4caf50" stroke={OUTLINE} strokeWidth="3" />
      </g>

      {/* screen assembly */}
      <rect x="42" y="112" width="216" height="212" rx="12" fill={BEZEL_WHITE} stroke={OUTLINE} strokeWidth="5" />
      <circle cx="140" cy="128" r="4" fill="#e03131" />
      <circle cx="158" cy="128" r="4" fill="#e03131" />
      <rect className="dex-screen" x="56" y="142" width="188" height="150" rx="5" fill="#12161a" stroke={OUTLINE} strokeWidth="3" />
      <rect className="dex-scan" x="56" y="142" width="188" height="150" rx="5" fill="url(#scan)" opacity="0.35" />
      <circle cx="74" cy="306" r="12" fill="#e03131" stroke={OUTLINE} strokeWidth="3" />
      <g stroke={OUTLINE} strokeWidth="3" strokeLinecap="round">
        <line x1="186" y1="298" x2="240" y2="298" />
        <line x1="186" y1="306" x2="240" y2="306" />
        <line x1="186" y1="314" x2="240" y2="314" />
      </g>

      {/* lower controls */}
      <circle cx="56" cy="356" r="16" fill="#3f3f3f" stroke={OUTLINE} strokeWidth="4" />
      <rect x="90" y="349" width="46" height="11" rx="5" fill="#d9d9d9" stroke={OUTLINE} strokeWidth="3" />
      <rect x="150" y="349" width="46" height="11" rx="5" fill="#29a8e0" stroke={OUTLINE} strokeWidth="3" />
      <rect x="88" y="378" width="104" height="36" rx="5" fill="#4caf50" stroke={OUTLINE} strokeWidth="4" />
      {/* d-pad */}
      <path
        d="M232 362 h22 v22 h22 v22 h-22 v22 h-22 v-22 h-22 v-22 h22 z"
        fill="#3f3f3f"
        stroke={OUTLINE}
        strokeWidth="4"
        strokeLinejoin="round"
      />

      <defs>
        <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7ee0a8" stopOpacity="0.25" />
          <stop offset="0.5" stopColor="#7ee0a8" stopOpacity="0" />
          <stop offset="1" stopColor="#7ee0a8" stopOpacity="0.18" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** Right panel, hidden behind the left until the device swings open. */
export function DexRight() {
  return (
    <svg className="dex-svg" viewBox="0 0 300 430" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="6" y="6" width="288" height="418" rx="20" fill={BODY} stroke={OUTLINE} strokeWidth="7" />
      <path d="M20 16 L20 414" stroke={BODY_DARK} strokeWidth="6" strokeLinecap="round" />

      {/* dark readout */}
      <rect x="44" y="38" width="214" height="64" rx="7" fill="#0f5132" stroke={OUTLINE} strokeWidth="4" />

      {/* blue keypad, two rows of five */}
      {[0, 1].map((row) =>
        [0, 1, 2, 3, 4].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={44 + col * 43}
            y={124 + row * 30}
            width="43"
            height="30"
            fill="#29a8e0"
            stroke={OUTLINE}
            strokeWidth="3"
          />
        )),
      )}

      {/* small dark bars */}
      <rect x="96" y="204" width="54" height="14" rx="4" fill="#2b2b2b" stroke={OUTLINE} strokeWidth="3" />
      <rect x="166" y="204" width="54" height="14" rx="4" fill="#2b2b2b" stroke={OUTLINE} strokeWidth="3" />

      <rect x="44" y="236" width="72" height="28" rx="4" fill="#f2f2f2" stroke={OUTLINE} strokeWidth="4" />
      <circle cx="248" cy="250" r="12" fill="#d4a017" stroke={OUTLINE} strokeWidth="3" />

      {/* dark green pads */}
      <rect x="44" y="304" width="100" height="38" rx="5" fill="#0f5132" stroke={OUTLINE} strokeWidth="4" />
      <rect x="158" y="304" width="100" height="38" rx="5" fill="#0f5132" stroke={OUTLINE} strokeWidth="4" />
    </svg>
  )
}

/** The hinge spine that sits between the two panels. */
export function DexHinge() {
  return (
    <svg className="dex-svg" viewBox="0 0 26 430" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="1" y="10" width="24" height="410" rx="8" fill={BODY_DARK} stroke={OUTLINE} strokeWidth="4" />
      {[70, 150, 230, 310].map((y) => (
        <line key={y} x1="3" y1={y} x2="23" y2={y} stroke={OUTLINE} strokeWidth="4" strokeLinecap="round" />
      ))}
    </svg>
  )
}
