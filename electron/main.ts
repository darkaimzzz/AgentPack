import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHandlers } from './ipc/handlers.ts'
import { createDemo } from './core/demo.ts'

const here = dirname(fileURLToPath(import.meta.url))
if (process.argv.includes('--demo')) {
  const demo = createDemo()
  app.setPath('userData', join(demo.home, 'electron'))
}

// In a packaged build the code lives inside app.asar, so walking up from the
// module directory cannot find the registry. It ships as an extra resource
// instead. Set before any core module reads it — registry lookup is lazy.
if (app.isPackaged) {
  process.env.AGENTPACK_REGISTRY ??= join(process.resourcesPath, 'registry')
}

// Nothing in AgentPack uses File/Edit/View, and the menu bar sat above the app's
// own header as a second strip of chrome. Removing it also drops its accelerators.
Menu.setApplicationMenu(null)

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    // The bezel colour, so there is no flash of a different background before
    // the renderer paints.
    backgroundColor: '#c62828',
    // The app draws its own title bar; see .topbar in src/styles.css.
    frame: false,
    // Packaged builds take the taskbar icon from the executable's own resource,
    // which electron-builder writes from build/icon.ico. Unpackaged runs have no
    // such resource, so point them at the same file or dev shows Electron's
    // default icon.
    ...(app.isPackaged ? {} : { icon: join(here, '../../build/icon.ico') }),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      // The renderer gets no Node and no direct filesystem or process access.
      // Everything privileged goes through a named IPC channel (CLAUDE.md §6).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  registerHandlers(win)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())

  // The startup animation is off under the test harnesses: smokeTest() queries
  // the DOM once on did-finish-load with no retry, so an intro would make it
  // report a false failure. Carried in the URL rather than over IPC because the
  // renderer has to know before its first paint — a round-trip would let the
  // animation flash before the answer arrived.
  const skipBoot = Boolean(process.env.AGENTPACK_SMOKE) || process.env.AGENTPACK_NO_BOOT === '1'
  // Demo mode exists to show the product, so it plays the intro even when the
  // OS asks for reduced motion — which Windows does more often than expected.
  const forceBoot = process.env.AGENTPACK_DEMO === '1' || process.env.AGENTPACK_BOOT === '1'
  const hash = skipBoot ? 'noboot' : forceBoot ? 'boot' : ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) win.loadURL(devUrl + (hash ? `#${hash}` : ''))
  else win.loadFile(join(here, '../renderer/index.html'), hash ? { hash } : {})

  return win
}

// Only reaches native surfaces now — chiefly the folder picker, which should
// match the light UI rather than fight it.
nativeTheme.themeSource = 'light'

/**
 * AGENTPACK_SMOKE=1 loads the real window, exercises the preload bridge and a
 * couple of IPC channels, prints the result and exits. Verifies the wiring
 * without a human having to look at a screen.
 */
async function smokeTest(win: BrowserWindow) {
  const timeout = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1) }, 30_000)
  const errors: string[] = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })
  win.webContents.on('preload-error', (_e, path, error) => errors.push(`preload ${path}: ${error.message}`))

  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))

  const result = await win.webContents.executeJavaScript(`(async () => {
   try {
    const api = window.agentpack
    if (!api) return { ok: false, why: 'window.agentpack missing — preload did not run' }
    const agents = await api.detectAgents()
    const analysis = await api.analyze(${JSON.stringify(process.cwd())})
    const rendered = document.querySelectorAll('.card').length

    // Switch to the Capability Load Manager and let it load, so the smoke test
    // covers the CLM screen rather than only the first step of the wizard.
    const manage = [...document.querySelectorAll('.modebtn')].find(b => b.textContent.trim() === 'Manage')
    if (manage) manage.click()
    await new Promise(r => setTimeout(r, 700))
    const clmHeading = document.querySelector('h2')?.textContent
    const clmRows = document.querySelectorAll('.clm-row').length
    const clmStats = [...document.querySelectorAll('.clm-summary .stat .k')].map(e => e.textContent)
    const clmView = await api.clmView()

    return {
      ok: Boolean(manage && clmHeading && clmView.rows && (await api.clmProfiles()).length),
      clm: {
        heading: clmHeading,
        rows: clmRows,
        stats: clmStats,
        profiles: (await api.clmProfiles()).map(p => p.id),
        summaryKeys: Object.keys(clmView.summary),
        currentProfileId: clmView.currentProfileId,
      },
      methods: Object.keys(api).sort(),
      agents: agents.filter(a => a.detected).map(a => a.name),
      signals: analysis.scan.signals.map(s => s.id),
      recommendations: analysis.recommendations.map(r => r.capability.id),
      renderedCards: rendered,
      heading: document.querySelector('h2')?.textContent,
    }
   } catch (e) { return { ok: false, why: String(e && e.message || e) } }
  })()`)

  console.log('SMOKE ' + JSON.stringify({ ...result, consoleErrors: errors }, null, 2))
  clearTimeout(timeout)
  app.exit(result.ok && !errors.length ? 0 : 1)
}

app.whenReady().then(() => {
  const win = createWindow()
  if (process.env.AGENTPACK_SMOKE) smokeTest(win).catch(error => { console.error(error); app.exit(1) })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
