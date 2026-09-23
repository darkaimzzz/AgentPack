import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DexLeft, DexRight, DexHinge } from './Dex.tsx'

/**
 * Startup sequence: the device opens, its screen lights with the wordmark, the
 * camera pushes in, then pulls back and leaves the wordmark sitting in the
 * app's own header.
 *
 * The app renders underneath this from the first frame, detection and registry
 * IPC are already in flight while it plays, so the intro costs no startup time.
 * Nothing here gates the app.
 */

const TOTAL_MS = 2650
/** Camera push at the zoom peak. Kept in step with `dex-shift` in styles.css. */
const PUSH = 2.6

/**
 * One decision point for whether the intro runs.
 *
 * The main process sets the hash: `#noboot` under the test harnesses, `#boot`
 * when it is explicitly wanted (demo mode, or AGENTPACK_BOOT=1). With neither,
 * the viewer's motion preference decides.
 *
 * That override is load-bearing rather than decorative: Windows reports
 * "animation effects" off far more often than people realise, it is off on
 * this development machine, and without a way to opt back in the intro would
 * silently never play on the very machine it was built for.
 */
export function shouldSkipBoot(): boolean {
  if (typeof window === 'undefined') return true
  const hash = window.location.hash
  if (hash === '#noboot') return true
  if (hash === '#boot') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function Boot({ onDone }: { onDone?: () => void }) {
  const [done, setDone] = useState(false)
  const [ready, setReady] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const brandRef = useRef<HTMLDivElement>(null)

  // The landing is measured, never hardcoded: put the wordmark exactly where the
  // header's .brand sits, then animate *from* the device screen back to nothing.
  // Ending on `transform: none` is what makes the hand-off pixel-exact at any
  // window size.
  useLayoutEffect(() => {
    const measure = () => {
      const root = rootRef.current
      const mark = brandRef.current
      const target = document.querySelector('.brand')
      const screen = document.querySelector('.dex-screen')
      if (!root || !mark || !target || !screen) return

      const t = target.getBoundingClientRect()
      const s = screen.getBoundingClientRect()
      // offsetWidth/Height, not getBoundingClientRect: the latter includes any
      // transform already on the element, so reading it once the animation is
      // running would feed the mark's own scale back into the next scale.
      const mw = mark.offsetWidth
      const mh = mark.offsetHeight
      if (!t.width || !s.width || !mw) return

      root.style.setProperty('--brand-left', `${t.left}px`)
      root.style.setProperty('--brand-top', `${t.top}px`)
      // Fill most of the device screen, whatever size the window is.
      const s0 = (s.width * 0.74) / mw
      root.style.setProperty('--s0', String(s0))
      // Must match the device's peak scale in `dex-shift`, or the wordmark
      // drifts out of the screen bezel instead of being pushed into by the
      // camera. Both scale about the same point, so the text stays framed.
      root.style.setProperty('--s1', String(s0 * PUSH))
      root.style.setProperty('--dx', `${s.left + s.width / 2 - (t.left + mw / 2)}px`)
      root.style.setProperty('--dy', `${s.top + s.height / 2 - (t.top + mh / 2)}px`)
    }

    // Measure exactly once, before anything is transformed, and only after the
    // pixel font is in, or the width would be the fallback's. The race keeps a
    // font that never resolves from stalling startup.
    let started = false
    const begin = () => {
      if (started) return
      started = true
      measure()
      setReady(true)
    }
    document.fonts?.ready.then(begin)
    const t = window.setTimeout(begin, 250)
    return () => { started = true; window.clearTimeout(t) }
  }, [])

  useEffect(() => {
    if (done) return
    const finish = () => setDone(true)
    const timer = window.setTimeout(finish, TOTAL_MS)
    // Any input skips: a judge on the third run should not have to wait.
    window.addEventListener('pointerdown', finish)
    window.addEventListener('keydown', finish)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', finish)
      window.removeEventListener('keydown', finish)
    }
  }, [done])

  useEffect(() => { if (done) onDone?.() }, [done, onDone])

  if (done) return null

  return (
    <div ref={rootRef} className={`boot ${ready ? 'run' : ''}`} data-testid="boot">
      <div className="dex">
        <div className="dex-panel dex-panel-left"><DexLeft /></div>
        <div className="dex-hinge"><DexHinge /></div>
        <div className="dex-panel dex-panel-right"><DexRight /></div>
      </div>
      <div ref={brandRef} className="boot-brand">Agent<span>Pack</span></div>
    </div>
  )
}
