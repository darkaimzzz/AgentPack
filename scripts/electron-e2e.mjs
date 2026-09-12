import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(workspace)
const artifactDir = join(workspace, '.qa')
mkdirSync(artifactDir, { recursive: true })

if (!process.versions.electron) {
  const build = process.argv.includes('--skip-build') ? { status: 0 } : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: workspace, stdio: 'inherit', shell: process.platform === 'win32' })
  if (build.status !== 0) process.exit(build.status ?? 1)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.AGENTPACK_SMOKE
  const electron = createRequire(import.meta.url)('electron')
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: workspace, env, stdio: 'inherit', windowsHide: true })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
} else {
  // Start asynchronously: top-level await of app.whenReady deadlocks Electron ESM startup.
  main().catch(async (error) => {
    console.error(error)
    const { app } = await import('electron')
    app.exit(1)
  })
}

async function main() {
  const { app, BrowserWindow, dialog } = await import('electron')
  app.disableHardwareAcceleration()
  const home = mkdtempSync(join(artifactDir, 'ui-home-'))
  const project = join(home, 'project')
  process.env.AGENTPACK_HOME = home
  process.env.AGENTPACK_DEMO = '1'
  process.env.AGENTPACK_DEMO_PROJECT = project
  // Assertions here are about the app, not the intro; keep the run deterministic.
  process.env.AGENTPACK_NO_BOOT = '1'
  app.setPath('userData', join(home, 'electron'))
  const fixtures = {
    '.claude.json': '{"mcpServers":{},"uiFixture":true}\n',
    '.claude/settings.json': '{}\n',
    '.codex/config.toml': '# UI fixture baseline\nmodel = "fixture-model"\n',
    '.config/opencode/opencode.jsonc': '{\n // UI fixture baseline\n "mcp": {}, "theme": "system"\n}\n',
    'project/package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
    'project/apps/web/package.json': JSON.stringify({ dependencies: { next: '16.0.0', '@supabase/ssr': '0.7.0' } }),
    'project/apps/web/supabase/config.toml': 'project_id = "fixture"\n',
  }
  for (const [relative, contents] of Object.entries(fixtures)) {
    const path = join(home, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const configFiles = ['.claude.json', '.codex/config.toml', '.config/opencode/opencode.jsonc']
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })
  const results = []
  const rendererErrors = []
  let win
  let deadline
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const record = (name, details = {}) => { results.push({ name, passed: true, details }); console.log('PASS', name, JSON.stringify(details)) }
  const save = (error) => writeFileSync(join(artifactDir, 'ui-results.json'), JSON.stringify({ passed: !error, home, results, rendererErrors, error: error?.stack }, null, 2))
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('preload-error', (_e, path, error) => rendererErrors.push(`${path}: ${error.message}`))
    window.webContents.on('render-process-gone', (_e, details) => rendererErrors.push(JSON.stringify(details)))
    window.webContents.on('console-message', (_e, level, message) => { if (level >= 3) rendererErrors.push(message) })
  })
  deadline = setTimeout(() => { save(new Error('Electron E2E exceeded 240 seconds')); app.exit(1) }, 240_000)
  try {
    await import(pathToFileURL(join(workspace, 'out/main/main.js')).href)
    await app.whenReady()
    while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(50)
    const js = (source) => win.webContents.executeJavaScript(source)
    const wait = async (source, description, timeout = 150_000) => {
      const until = Date.now() + timeout
      while (Date.now() < until) {
        if (await js(source)) return
        await sleep(100)
      }
      throw new Error(`Timed out: ${description}; UI: ${await js('document.body.innerText')}`)
    }
    const waitText = (text) => wait(`document.body.innerText.includes(${JSON.stringify(text)})`, text)
    const click = async (text) => {
      await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw new Error('Missing or disabled button: ' + ${JSON.stringify(text)}); b.click() })()`)
      await sleep(120)
    }
    const heading = (text) => wait(`document.querySelector('h2')?.textContent === ${JSON.stringify(text)}`, text)
    const pickOnly = async (names) => {
      await js(`(() => { for (const card of document.querySelectorAll('.card.pick')) { const want = ${JSON.stringify(names)}.includes(card.querySelector('.title').textContent); if (card.classList.contains('on') !== want) card.click() } })()`)
      await sleep(150)
    }
    await waitText('3 supported coding agents')
    const security = win.webContents.getLastWebPreferences()
    assert.equal(security.sandbox, true)
    assert.equal(security.contextIsolation, true)
    assert.equal(security.nodeIntegration, false)
    assert.equal(await js('typeof window.require'), 'undefined')
    assert.equal(await js('typeof window.agentpack.install'), 'function')
    record('Sandboxed renderer and real preload bridge')

    await js(`document.querySelectorAll('.target-picker input')[2].click()`)
    await waitText('2 agents ready')
    await click('Scan a project…')
    await heading('Project analysis')
    const analysisText = await js('document.querySelector("main").innerText')
    assert.match(analysisText, /Next\.js/)
    assert.match(analysisText, /Supabase/)
    const analysis = await js(`window.agentpack.analyze(${JSON.stringify(project)})`)
    assert.ok(analysis.scan.signals.some((s) => s.id === 'nextjs'))
    assert.ok(analysis.scan.signals.some((s) => s.id === 'supabase'))
    record('Nested Next.js and Supabase detection', { signals: analysis.scan.signals.map((s) => s.id) })
    await click('Continue')
    await heading('Choose capabilities')
    await pickOnly(['GitHub'])
    await click('Review plan')
    await heading('Install plan')
    assert.equal(await js(`document.querySelectorAll('.card.row').length`), 2)
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Install selected').disabled`), true)
    record('Two selected targets and required credential gating')
    await js(`(() => { const input = document.querySelector('input[type=password]'); if (!input) throw new Error('Missing credential field'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'FAKE_UI_QA_SECRET_123'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await wait(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Install selected').disabled === false`, 'credential enables install')
    await click('Back')
    await click('Back')
    await click('Back')
    await heading('Detected agents')
    await js(`document.querySelectorAll('.target-picker input')[2].click()`)
    await waitText('3 agents ready')
    await click('Scan a project…')
    await click('Continue')
    await heading('Choose capabilities')
    await js(`(() => { const b = [...document.querySelectorAll('button.pack')].find(b => b.querySelector('strong')?.textContent === 'Local Developer'); if (!b) throw new Error('Local Developer pack missing'); b.click() })()`)
    await wait(`document.querySelectorAll('.card.pick.on').length === 3`, 'local pack selection')
    const selected = await js(`[...document.querySelectorAll('.card.pick.on .title')].map(e=>e.textContent).sort()`)
    assert.deepEqual(selected, ['Filesystem', 'Playwright', 'Sequential Thinking'])
    await click('Review plan')
    assert.equal(await js(`document.querySelectorAll('input[type=password]').length`), 0)
    assert.equal(await js(`document.querySelectorAll('.card.row').length`), 3)
    record('Local pack selects exactly three credential-free MCPs across three targets', { selected })
    const started = Date.now()
    await click('Install selected')
    await heading('Health report')
    const health = await js(`[...document.querySelectorAll('.matrix tbody tr')].map(tr => ({ name:tr.querySelector('.title').textContent, cells:[...tr.querySelectorAll('.cell')].map(e=>({text:e.textContent,ok:e.classList.contains('ok')})) }))`)
    assert.equal(health.length, 3)
    for (const row of health) {
      assert.equal(row.cells.length, 4)
      assert.ok(row.cells.every((cell) => cell.ok), JSON.stringify(row))
      assert.ok(row.cells.slice(0, 3).every((cell) => /Installed/.test(cell.text)))
      assert.match(row.cells[3].text, /[1-9]\d* tools discovered/)
    }
    for (const relative of configFiles) assert.notEqual(readFileSync(join(home, relative), 'utf8'), fixtures[relative])
    const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)])
    for (const path of [...walk(join(home, '.agentpack')), ...configFiles.map((relative) => join(home, relative))]) assert.ok(!readFileSync(path, 'utf8').includes('FAKE_UI_QA_SECRET_123'), 'Deselected credential persisted: ' + path)
    record('Real MCP health and config writes; deselected credential absent from persisted state', { durationMs: Date.now() - started, health })
    win.show()
    win.focus()
    win.webContents.invalidate()
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await sleep(500)
    assert.equal(await js("document.querySelector('h2').textContent"), 'Health report')
    writeFileSync(join(artifactDir, 'ui-health.png'), (await win.webContents.capturePage()).toPNG())

    await click('Manage')
    await heading('Capability Load Manager')
    await wait(`document.querySelectorAll('.clm-row').length > 1`, 'management rows')
    await js(`(() => {const row=[...document.querySelectorAll('.clm-row')].find(r=>r.querySelector('.title')?.textContent==='Playwright');const b=[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='Deactivate · Claude Code');if(!b||b.disabled)throw Error('Deactivate button missing');b.click()})()`)
    await wait(`(async()=>{const v=await window.agentpack.clmView();return v.rows.find(r=>r.capability.id==='playwright').agents.find(a=>a.agent==='claude').state==='dormant'})()`, 'Claude dormant')
    await js(`(() => {const row=[...document.querySelectorAll('.clm-row')].find(r=>r.querySelector('.title')?.textContent==='Playwright');const b=[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='Activate · Claude Code');if(!b||b.disabled)throw Error('Activate button missing');b.click()})()`)
    await wait(`(async()=>{const v=await window.agentpack.clmView();return v.rows.find(r=>r.capability.id==='playwright').agents.find(a=>a.agent==='claude').state==='active'})()`, 'Claude active again')
    await click('measure now')
    await wait(`(async()=>{const v=await window.agentpack.clmView();return v.rows.filter(r=>r.anyActive||r.anyDormant).every(r=>r.cost?.source==='measured')})()`, 'installed schemas measured')
    const costs = await js('window.agentpack.clmView()')
    assert.equal(costs.summary.installedCount, 3)
    assert.ok(costs.summary.activeTools > 0)
    assert.equal(costs.summary.activeTokens, costs.summary.allTokens)
    record('Manage deactivate, activate, and real schema measurement', { summary: costs.summary })
    await click('Install')
    await heading('Health report')
    await click('Roll back')
    await waitText('This run was undone.')
    for (const relative of configFiles) assert.equal(readFileSync(join(home, relative), 'utf8'), fixtures[relative], 'Rollback differed: ' + relative)
    record('Rollback restores all three config files byte-identically')
    await click('Back')
    await heading('Choose capabilities')
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Review plan').disabled`), false)
    assert.equal(await js(`document.querySelector('h2').textContent`), 'Choose capabilities')
    record('Report Back returns to an actionable selection screen')
    assert.deepEqual(rendererErrors, [])
    save()
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    if (win && !win.isDestroyed()) writeFileSync(join(artifactDir, 'ui-failure.png'), (await win.webContents.capturePage()).toPNG())
    save(error)
    clearTimeout(deadline)
    throw error
  }
}
