import { contextBridge, ipcRenderer } from 'electron'

/**
 * The renderer's entire capability surface. Named calls only — no command
 * execution, no filesystem, no arbitrary channel access.
 */
const api = {
  detectAgents: () => ipcRenderer.invoke('agents:detect'),
  listRegistry: () => ipcRenderer.invoke('registry:list'),
  analyze: (dir: string) => ipcRenderer.invoke('project:analyze', dir),
  pickDirectory: () => ipcRenderer.invoke('project:pick'),
  install: (req: unknown) => ipcRenderer.invoke('install:run', req),
  rollback: (ledgerId?: string) => ipcRenderer.invoke('install:rollback', ledgerId),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),

  /** Subscribe to live install progress. Returns an unsubscribe function. */
  onProgress: (cb: (e: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('install:progress', handler)
    return () => ipcRenderer.off('install:progress', handler)
  },
}

contextBridge.exposeInMainWorld('agentpack', api)

export type AgentPackApi = typeof api
