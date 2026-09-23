import { contextBridge, ipcRenderer } from 'electron'

/**
 * The renderer's entire capability surface. Named calls only, no command
 * execution, no filesystem, no arbitrary channel access.
 */
const api = {
  info: () => ipcRenderer.invoke('app:info'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  detectAgents: () => ipcRenderer.invoke('agents:detect'),
  listRegistry: () => ipcRenderer.invoke('registry:list'),
  analyze: (dir: string) => ipcRenderer.invoke('project:analyze', dir),
  pickDirectory: () => ipcRenderer.invoke('project:pick'),
  install: (req: unknown) => ipcRenderer.invoke('install:run', req),
  rollback: (ledgerId?: string) => ipcRenderer.invoke('install:rollback', ledgerId),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),

  // Capability Load Manager
  clmView: () => ipcRenderer.invoke('clm:view'),
  clmProfiles: () => ipcRenderer.invoke('clm:profiles'),
  clmPlan: (profileId: string) => ipcRenderer.invoke('clm:plan', profileId),
  clmApplyProfile: (profileId: string) => ipcRenderer.invoke('clm:applyProfile', profileId),
  clmMeasure: (projectDir?: string) => ipcRenderer.invoke('clm:measure', projectDir),
  clmSetState: (req: unknown) => ipcRenderer.invoke('clm:setState', req),
  clmLog: () => ipcRenderer.invoke('clm:log'),
  clmTriggers: () => ipcRenderer.invoke('clm:triggers'),
  clmStartWatch: (projectDir: string) => ipcRenderer.invoke('clm:startWatch', projectDir),
  clmStopWatch: () => ipcRenderer.invoke('clm:stopWatch'),
  clmWatchStatus: () => ipcRenderer.invoke('clm:watchStatus'),
  onWatchChanged: (cb: (e: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('clm:watchChanged', handler)
    return () => ipcRenderer.off('clm:watchChanged', handler)
  },
  /** Fired when a file-pattern trigger activates a capability. */
  onTrigger: (cb: (e: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('clm:trigger', handler)
    return () => ipcRenderer.off('clm:trigger', handler)
  },

  /** Subscribe to live install progress. Returns an unsubscribe function. */
  onProgress: (cb: (e: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('install:progress', handler)
    return () => ipcRenderer.off('install:progress', handler)
  },
}

contextBridge.exposeInMainWorld('agentpack', api)

export type AgentPackApi = typeof api
