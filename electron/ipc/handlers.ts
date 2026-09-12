import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { detectAgents } from '../core/agents/index.ts'
import { capabilities, packs } from '../core/capabilities/registry.ts'
import { scanProject } from '../core/detection/project.ts'
import { recommend, alsoAvailable } from '../core/recommendations/rules.ts'
import { install, rollback, type InstallRequest } from '../core/installer/install.ts'
import { clmView, measureAll } from '../core/clm/view.ts'
import { setState, log as mutationLog } from '../core/clm/state.ts'
import { profiles, applyProfile, planProfile } from '../core/clm/profiles.ts'
import type { AgentKey, ProgressEvent } from '../core/types.ts'

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

  // --- Capability Load Manager -------------------------------------------
  // Structured data only. The renderer can ask for a state change by name; it
  // cannot execute anything (PRD §13).
  ipcMain.handle('clm:view', () => clmView())
  ipcMain.handle('clm:profiles', () => profiles())
  ipcMain.handle('clm:plan', (_e, profileId: string) => planProfile(profileId))
  ipcMain.handle('clm:applyProfile', (_e, profileId: string) => applyProfile(profileId))
  ipcMain.handle('clm:measure', (_e, projectDir?: string) => measureAll(projectDir ?? process.cwd()))
  ipcMain.handle('clm:log', () => mutationLog().slice(-100))
  ipcMain.handle(
    'clm:setState',
    (_e, req: { capabilityId: string; agent: AgentKey; state: 'active' | 'dormant' }) =>
      setState(req.capabilityId, req.agent, req.state, { source: 'manual' }),
  )
}
