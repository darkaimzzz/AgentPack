import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { detectAgents } from '../core/agents/index.ts'
import { capabilities, packs } from '../core/capabilities/registry.ts'
import { scanProject } from '../core/detection/project.ts'
import { recommend, alsoAvailable } from '../core/recommendations/rules.ts'
import { install, rollback, type InstallRequest } from '../core/installer/install.ts'
import type { ProgressEvent } from '../core/types.ts'

/**
 * Every privileged operation lives here, behind a named channel (CLAUDE.md §6).
 * The renderer cannot execute a command — it can only ask for one of these.
 */
export function registerHandlers(win: BrowserWindow) {
  ipcMain.handle('agents:detect', () => detectAgents())

  ipcMain.handle('registry:list', () => ({ capabilities: capabilities(), packs: packs() }))

  ipcMain.handle('project:analyze', (_e, dir: string) => {
    const scan = scanProject(dir)
    const recommendations = recommend(scan)
    return { scan, recommendations, extras: alsoAvailable(recommendations) }
  })

  ipcMain.handle('project:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('install:run', async (_e, req: Omit<InstallRequest, 'onProgress'>) => {
    const onProgress = (event: ProgressEvent) => {
      if (!win.isDestroyed()) win.webContents.send('install:progress', event)
    }
    return install({ ...req, onProgress })
  })

  ipcMain.handle('install:rollback', (_e, ledgerId?: string) => rollback(ledgerId))

  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
}
