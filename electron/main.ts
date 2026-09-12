import { app, BrowserWindow, nativeTheme } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHandlers } from './ipc/handlers.ts'

const here = dirname(fileURLToPath(import.meta.url))

// In a packaged build the code lives inside app.asar, so walking up from the
// module directory cannot find the registry. It ships as an extra resource
// instead. Set before any core module reads it — registry lookup is lazy.
if (app.isPackaged) {
  process.env.AGENTPACK_REGISTRY ??= join(process.resourcesPath, 'registry')
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d10',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      // The renderer gets no Node and no direct filesystem or process access.
      // Everything privileged goes through a named IPC channel (CLAUDE.md §6).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the electron module
    },
  })

  win.once('ready-to-show', () => win.show())
  registerHandlers(win)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(here, '../renderer/index.html'))

  return win
}

nativeTheme.themeSource = 'dark'

/**
 * AGENTPACK_SMOKE=1 loads the real window, exercises the preload bridge and a
 * couple of IPC channels, prints the result and exits. Verifies the wiring
 * without a human having to look at a screen.
 */
async function smokeTest(win: BrowserWindow) {
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
    return {
      ok: true,
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
  app.exit(result.ok && !errors.length ? 0 : 1)
}

app.whenReady().then(() => {
  const win = createWindow()
  if (process.env.AGENTPACK_SMOKE) smokeTest(win)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
