import { ipcMain, dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { statSync } from 'node:fs'
import { detectAgents, adapters } from '../core/agents/index.ts'
import { capabilities, packs, getCapability } from '../core/capabilities/registry.ts'
import { scanProject } from '../core/detection/project.ts'
import { recommend, alsoAvailable } from '../core/recommendations/rules.ts'
import { install, rollback, type InstallRequest } from '../core/installer/install.ts'
import { clmView, measureAll } from '../core/clm/view.ts'
import { setState, log as mutationLog } from '../core/clm/state.ts'
import { profiles, applyProfile, planProfile } from '../core/clm/profiles.ts'
import { startWatching, triggerDefinitions, type WatchHandle } from '../core/clm/trigger.ts'
import type { AgentKey, ProgressEvent } from '../core/types.ts'

export function registerHandlers(win: BrowserWindow) {
  let watcher: WatchHandle | null = null
  let watchError: string | undefined
  let busy = false
  const channels: string[] = []
  const handle = (channel: string, fn: (...args: any[]) => unknown) => {
    channels.push(channel)
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender')
      return fn(...args)
    })
  }
  const watchStatus = () => watcher ? { watching: watcher.watching } : watchError ? { watching: '', error: watchError } : null
  const notifyWatch = () => { if (!win.isDestroyed()) win.webContents.send('clm:watchChanged', watchStatus()) }
  const stopWatch = () => { watcher?.stop(); watcher = null; watchError = undefined; notifyWatch() }
  const mutate = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    if (busy) throw new Error('Another operation is running. Wait for it to finish.')
    busy = true
    stopWatch()
    try { return await fn() } finally { busy = false }
  }
  const directory = (path: unknown): string => {
    if (typeof path !== 'string' || !statSync(path).isDirectory()) throw new Error('Select an existing project folder')
    return path
  }
  handle('app:info', () => ({ demo: process.env.AGENTPACK_DEMO === '1', projectDir: process.env.AGENTPACK_DEMO_PROJECT ?? null }))
  // The window is frameless, so its controls are ours to provide. These go
  // through handle() like everything else and inherit its sender check.
  handle('window:minimize', () => { win.minimize() })
  handle('window:toggleMaximize', () => { win.isMaximized() ? win.unmaximize() : win.maximize() })
  handle('window:close', () => { win.close() })
  handle('agents:detect', () => detectAgents())
  handle('registry:list', () => ({ capabilities: capabilities(), packs: packs() }))
  handle('project:analyze', (dir: string) => {
    const scan = scanProject(directory(dir))
    const recommendations = recommend(scan)
    return { scan, recommendations, extras: alsoAvailable(recommendations) }
  })
  handle('project:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: process.env.AGENTPACK_DEMO_PROJECT })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('install:run', (req: Omit<InstallRequest, 'onProgress'>) => mutate(() => {
    const onProgress = (event: ProgressEvent) => {
      if (!win.isDestroyed()) win.webContents.send('install:progress', event)
    }
    return install({ ...req, onProgress })
  }))
  handle('install:rollback', (id?: string) => mutate(() => rollback(id)))
  handle('shell:reveal', (path: string) => { if (typeof path !== 'string') throw new Error('Invalid path'); shell.showItemInFolder(path) })
  handle('clm:view', () => clmView())
  handle('clm:profiles', () => profiles())
  handle('clm:plan', (id: string) => planProfile(id))
  handle('clm:applyProfile', (id: string) => mutate(() => applyProfile(id)))
  handle('clm:measure', (dir?: string) => mutate(() => measureAll(directory(dir ?? process.cwd()))))
  handle('clm:log', () => mutationLog().slice(-100))
  handle('clm:triggers', () => triggerDefinitions())
  handle('clm:watchStatus', watchStatus)
  handle('clm:stopWatch', () => { stopWatch(); return null })
  handle('clm:startWatch', (dir: string) => {
    if (busy) throw new Error('Wait for the current operation to finish before watching a folder.')
    directory(dir)
    stopWatch()
    watcher = startWatching(dir, event => {
      if (!win.isDestroyed()) win.webContents.send('clm:trigger', event)
    }, { onError: error => { watchError = error; watcher = null; notifyWatch() } })
    return { watching: watcher.watching }
  })
  handle('clm:setState', (req: { capabilityId: string; agent: AgentKey; state: 'active' | 'dormant' }) => mutate(() => {
    if (!req || !Object.hasOwn(adapters, req.agent) || !['active','dormant'].includes(req.state)) throw new Error('Invalid state change')
    getCapability(req.capabilityId)
    return setState(req.capabilityId, req.agent, req.state, { source: 'manual' })
  }))
  win.once('closed', () => { stopWatch(); for (const channel of channels) ipcMain.removeHandler(channel) })
}
