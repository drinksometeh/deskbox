// End-to-end smoke test. Starts a second DeskBox on temp folders (DESKBOX_ROOT / DESKBOX_DESKTOP, so the real
// desktop and boxes are never touched) and drives it over the DevTools protocol. Run: npm run e2e
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const koffi = require('koffi')
const electron = require('electron')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbox-e2e-'))
const ROOT = path.join(tmp, 'DeskBox')
const DESKTOP = path.join(tmp, 'Desktop')
const MAPPED = path.join(tmp, 'Mapped')
fs.mkdirSync(DESKTOP)
fs.mkdirSync(MAPPED)
fs.writeFileSync(path.join(MAPPED, 'mapped.txt'), '')
const MAIN_PORT = 9339
const PAGE_PORT = 9340

const user32 = koffi.load('user32.dll')
const EnumProc = koffi.proto('bool __stdcall EnumProc(intptr hwnd, intptr lp)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr lp)')
const RECT = koffi.struct('RECT', { l: 'int32', t: 'int32', r: 'int32', b: 'int32' })
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)')
function zOrder() {
  const list = [] // top-level windows, topmost first
  const cb = koffi.register((h) => list.push(h) > 0, koffi.pointer(EnumProc))
  EnumWindows(cb, 0)
  koffi.unregister(cb)
  return list
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what, fn, ms = 8000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}
const ok = (what) => console.log(`✔ ${what}`)

// Minimal DevTools-protocol client: evaluate an expression and get its value back.
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let next = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  }
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, ({ result, error }) => {
        if (error) return reject(new Error(error.message))
        if (result.exceptionDetails) return reject(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
        resolve(result.result.value)
      })
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  return { evaluate, close: () => ws.close() }
}
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json()

async function page(title) {
  return waitFor(`box "${title}"`, async () => {
    for (const t of await targets(PAGE_PORT)) {
      if (t.type !== 'page' || !t.url.includes('box.html')) continue
      const p = await connect(t.webSocketDebuggerUrl)
      if ((await p.evaluate('document.getElementById("title").textContent')) === title) return p
      p.close()
    }
  })
}

async function run(main) {
  const m = (body) => main.evaluate(`(async () => { const { live, fs, electron, boxes, keep } = globalThis.__deskbox; ${body} })()`)
  // Native menus and dialogs can't be clicked from here: capture menus, auto-confirm dialogs, keep trash/open local.
  await m(`
    const { Menu, dialog, shell } = electron
    Menu.prototype.popup = function () { globalThis.__menu = this }
    dialog.showMessageBox = async () => ({ response: 0 })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(MAPPED)}] })
    shell.trashItem = async (p) => fs.rmSync(p, { recursive: true })
    shell.openPath = async (p) => { (globalThis.__opened ??= []).push(p); return '' }
  `)
  const clickMenu = (label) => m(`globalThis.__menu.items.find((i) => i.label.startsWith(${JSON.stringify(label)})).click()`)
  const hwndOf = (name) => m(`return Number(live.get(boxes().find((b) => b.name === ${JSON.stringify(name)}).id).win.getNativeWindowHandle().readBigInt64LE())`)

  const box = await page('盒子')
  const ev = box.evaluate
  const dir = await m('return boxes()[0].tabs[0].dir')
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, f), '')
  const count = () => ev('document.querySelectorAll(".item").length')
  const selected = () => ev('document.querySelectorAll(".item.selected").length')
  const key = (k, ctrl = false) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${ctrl} }))`)
  await waitFor('3 items', async () => (await count()) === 3)
  ok('files put in a tab folder show up')

  await ev(`(() => {
    const [a, b] = document.querySelectorAll('.item')
    const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect()
    document.getElementById('items').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r1.left - 4, clientY: r1.top - 4 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: r2.right - 2, clientY: r2.bottom - 2 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
  })()`)
  assert.equal(await selected(), 2, 'marquee selects the two items it touches')
  await ev(`(() => {
    const items = document.getElementById('items'), r = items.getBoundingClientRect()
    items.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.right - 10, clientY: r.bottom - 10 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
  })()`)
  assert.equal(await selected(), 0, 'a click on empty space clears the selection')
  await key('a', true)
  assert.equal(await selected(), 3, 'Ctrl+A selects all')
  await key('Escape')
  assert.equal(await selected(), 0, 'Esc clears')
  ok('marquee, click-to-clear, Ctrl+A, Esc')

  await key('a', true)
  await key('Enter')
  await waitFor('open calls', async () => (await m('return globalThis.__opened?.length')) === 3)
  await key('Escape')
  await ev(`document.querySelector('.item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await key('Delete')
  await waitFor('deleted item gone', async () => (await count()) === 2)
  assert.equal(fs.readdirSync(dir).length, 2)
  ok('Enter opens the selection, Delete sends it to the recycle bin')

  // Rearranging: the drop line marks the spot under the pointer; a drop there sticks; new files go last.
  const labels = () => ev('[...document.querySelectorAll(".item span")].map((s) => s.textContent).join()')
  const at = (name) => JSON.stringify(path.join(dir, name))
  const marked = await ev(`(() => {
    const r = document.querySelector('.item').getBoundingClientRect()
    document.getElementById('items').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 10 }))
    const el = document.querySelector('.drop-before')
    document.dispatchEvent(new DragEvent('dragleave', { relatedTarget: null }))
    return el?.textContent + '|' + document.querySelectorAll('.drop-before').length
  })()`)
  assert.equal(marked, 'b.txt|0', 'drop line before the first item, gone when the drag leaves')
  await ev(`box.drop([${at('c.txt')}], undefined, ${at('b.txt')})`)
  await waitFor('c before b', async () => (await labels()) === 'c.txt,b.txt')
  fs.writeFileSync(path.join(dir, 'a2.txt'), '')
  await waitFor('new file last', async () => (await labels()) === 'c.txt,b.txt,a2.txt')
  fs.rmSync(path.join(dir, 'a2.txt'))
  await waitFor('back to 2 items', async () => (await count()) === 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'boxes.json'), 'utf8')).boxes[0].tabs[0].order, ['c.txt', 'b.txt'])
  ok('drag to rearrange: drop line, order saved, new files go last')

  await ev('box.boxMenu()')
  await clickMenu('新增分頁')
  await waitFor('2 tabs', async () => (await ev('document.querySelectorAll(".tab").length')) === 2)
  const tab2 = await m('return boxes()[0].tabs[1].dir')
  fs.writeFileSync(path.join(tab2, 'x.txt'), '')
  await waitFor('x.txt in the new tab', async () => (await count()) === 1)
  ok('new tab from the box menu, same window (no reopen)')

  // A drop that can't move a file (in use, gone) skips just that one, and still repaints so icons taken out early come back.
  const missing = JSON.stringify(path.join(tmp, 'missing.txt'))
  await ev(`document.querySelector('.item').remove()`)
  await ev(`box.drop([${missing}], 1)`)
  await waitFor('icon back after a failed drop', async () => (await count()) === 1)
  const y = path.join(tmp, 'y.txt')
  fs.writeFileSync(y, '')
  await ev(`box.drop([${missing}, ${JSON.stringify(y)}], 1)`)
  await waitFor('the file after the failed one still moves', async () => (await count()) === 2)
  fs.rmSync(path.join(tab2, 'y.txt'))
  await waitFor('back to 1 item', async () => (await count()) === 1)
  ok('a drop where one file fails moves the rest and repaints')

  // Dragging onto another tab: it glows while hovered, flashes on drop, and the refresh the drop causes keeps the flash.
  const tabClass = () => ev('document.querySelectorAll(".tab")[0].className')
  await ev(`document.querySelectorAll('.tab')[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))`)
  assert.match(await tabClass(), /drop-target/, 'hovered tab glows')
  await ev(`document.querySelectorAll('.tab')[0].dispatchEvent(new DragEvent('dragleave'))`)
  assert.doesNotMatch(await tabClass(), /drop-target/, 'and stops when the drag leaves')
  await ev(`document.querySelectorAll('.tab')[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))`)
  assert.match(await tabClass(), /dropped/, 'tab flashes on drop')
  await m('live.get(boxes()[0].id).win.webContents.send("changed")') // the refresh a real drop triggers
  await sleep(250)
  assert.match(await tabClass(), /dropped/, 'a refresh mid-flash lets it finish')
  await waitFor('flash ends by itself', async () => !/dropped/.test(await tabClass()), 3000)
  ok('drag over a tab: glow while hovering, flash on drop')

  const switchMs = (i, n) =>
    ev(`(async () => {
      const t0 = performance.now()
      document.querySelectorAll('.tab')[${i}].click()
      while (document.querySelectorAll('.item').length !== ${n}) await new Promise((r) => setTimeout(r, 2))
      return Math.round(performance.now() - t0)
    })()`)
  const ms1 = await switchMs(0, 2)
  const ms2 = await switchMs(1, 1)
  assert.ok(ms1 < 50 && ms2 < 50, `tab switches took ${ms1}ms / ${ms2}ms`)
  ok(`tab switch paints in ${ms1}ms / ${ms2}ms`)

  // Double-clicking a tab that isn't active: the first click switches tabs, and the tab must survive that to get the dblclick.
  await switchMs(0, 2)
  await m('live.get(boxes()[0].id).win.focus()') // a real double-click activates the box; unfocused pages fire no blur
  await sleep(200)
  await ev(`(() => {
    const tab = document.querySelectorAll('.tab')[1]
    tab.click()
    tab.click()
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tab.textContent = '遊戲'
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  })()`)
  await waitFor('tab renamed by double-click', async () => (await m('return boxes()[0].tabs[1].name')) === '遊戲')
  await ev(`box.renameBox('工具箱')`)
  assert.equal(await m('return boxes()[0].name'), '工具箱')
  ok('rename an inactive tab by double-click, rename box')

  await ev('box.toggleView()')
  await waitFor('list view', () => ev('document.body.classList.contains("list")'))
  await ev('box.toggleView()')
  await ev('box.toggleLock()')
  assert.equal(await m('return live.get(boxes()[0].id).win.isMovable()'), false, 'locked box is not movable')
  await ev('box.toggleLock()')
  await ev('box.toggleCollapse()')
  await waitFor('collapsed', () => ev('document.body.classList.contains("collapsed")'))
  const rect = {}
  GetWindowRect(await hwndOf('工具箱'), rect)
  assert.ok(rect.b - rect.t <= 45, `collapsed window is ${rect.b - rect.t}px tall`)
  await ev('box.toggleCollapse()')
  await waitFor('expanded', async () => !(await ev('document.body.classList.contains("collapsed")')))
  ok(`list view, lock, collapse (${rect.b - rect.t}px tall when collapsed)`)

  // A box saved on a monitor that's gone comes onto a screen that's there, keeps its saved spot, and goes back once the monitor does.
  const placed = await m(`
    const { screen } = electron
    const b = boxes()[0], win = live.get(b.id).win
    const onScreen = ({ x, y }) => screen.getAllDisplays().some(({ workArea: a }) => x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height)
    Object.assign(b, { x: -30000, y: -30000 })
    screen.emit('display-removed')
    await new Promise((r) => setTimeout(r, 300)) // room for a 'moved' that would overwrite the saved spot
    const away = { reachable: onScreen(win.getBounds()), kept: b.x === -30000 }
    const a = screen.getPrimaryDisplay().workArea
    Object.assign(b, { x: a.x + 100, y: a.y + 100 })
    screen.emit('display-added')
    const { x, y } = win.getBounds()
    return { ...away, back: Math.abs(x - a.x - 100) <= 1 && Math.abs(y - a.y - 100) <= 1 }
  `)
  assert.deepEqual(placed, { reachable: true, kept: true, back: true })
  ok('a box from a missing monitor shows up on screen, and goes back when the monitor returns')

  // A box stays under app windows even when it has focus.
  const boxHwnd = await hwndOf('工具箱')
  const coverHwnd = await m(`
    const b = live.get(boxes()[0].id).win.getBounds()
    const cover = new electron.BrowserWindow({ x: b.x + 40, y: b.y + 40, width: 300, height: 200 })
    globalThis.__cover = cover
    await cover.loadURL('about:blank')
    cover.focus()
    await new Promise((r) => setTimeout(r, 300))
    live.get(boxes()[0].id).win.focus()
    await new Promise((r) => setTimeout(r, 300))
    return Number(cover.getNativeWindowHandle().readBigInt64LE())
  `)
  const z = zOrder()
  assert.ok(z.indexOf(boxHwnd) > z.indexOf(coverHwnd), 'focused box is still below the app window')
  assert.equal(await m('return live.get(boxes()[0].id).win.isFocused()'), true, 'and it has keyboard focus')
  await m('globalThis.__cover.destroy()')
  ok('box stays behind app windows even when clicked/focused')

  await ev('box.boxMenu()')
  await clickMenu('新增資料夾映射分頁')
  await waitFor('mapped tab shows the folder', async () => (await ev('[...document.querySelectorAll(".item span")].map((s) => s.textContent).join()')) === 'mapped.txt')
  await ev('box.boxMenu()')
  await clickMenu('刪除分頁')
  await waitFor('back to 2 tabs', async () => (await ev('document.querySelectorAll(".tab").length')) === 2)
  assert.ok(fs.existsSync(path.join(MAPPED, 'mapped.txt')), 'deleting a mapped tab leaves the folder alone')
  ok('folder-mapped tab, and deleting it keeps the folder')

  await ev(`box.itemMenu([${JSON.stringify(path.join(dir, 'b.txt'))}])`)
  await clickMenu('移回桌面')
  assert.ok(fs.existsSync(path.join(DESKTOP, 'b.txt')))
  // New desktop items get filed after the grace period; b.txt was put back on purpose and must stay.
  fs.writeFileSync(path.join(DESKTOP, 'game.url'), '[InternetShortcut]\r\nURL=steam://rungameid/1\r\n')
  fs.writeFileSync(path.join(DESKTOP, 'notes.txt'), '')
  fs.mkdirSync(path.join(DESKTOP, 'folderX'))
  await waitFor('desktop sorted', () => ['game.url', 'notes.txt', 'folderX'].every((f) => !fs.existsSync(path.join(DESKTOP, f))), 25000)
  const where = await m(`return Object.fromEntries(boxes().flatMap((b) => b.tabs).flatMap((t) => fs.readdirSync(t.dir).map((f) => [f, t.kind ?? null])))`)
  assert.equal(where['game.url'], 'game')
  assert.equal(where['notes.txt'], '文檔')
  assert.equal(where['folderX'], '目錄')
  assert.ok(fs.existsSync(path.join(DESKTOP, 'b.txt')), 'item moved back on purpose stays on the desktop')
  ok('auto-organize: game / document / folder filed, moved-back item left alone')

  // Last of the window checks: after an un-minimize, Windows' focus-stealing guard blocks programmatic focus().
  await m('live.get(boxes()[0].id).win.minimize()')
  await waitFor('box un-minimizes itself', async () => !(await m('return live.get(boxes()[0].id).win.isMinimized()')))
  ok('a minimized box restores itself')

  const tabDirs = await m(`return boxes().find((b) => b.name === '工具箱').tabs.map((t) => t.dir)`)
  await ev('box.boxMenu()')
  await clickMenu('刪除盒子')
  await waitFor('box removed', async () => !(await m(`return boxes().some((b) => b.name === '工具箱')`)))
  assert.ok(tabDirs.every((d) => !fs.existsSync(d)), 'its tab folders are gone')
  assert.ok(['c.txt', 'x.txt'].every((f) => fs.existsSync(path.join(DESKTOP, f))), 'its items went back to the desktop')
  ok('delete box puts its items back on the desktop')

  // All boxes share one page process: crash it and every box must load again by itself.
  await m(`
    const pages = boxes().map((b) => live.get(b.id).win.webContents)
    const reloaded = Promise.all(pages.map((wc) => new Promise((r) => wc.once('did-finish-load', r))))
    pages[0].forcefullyCrashRenderer()
    await Promise.race([reloaded, new Promise((_, no) => setTimeout(() => no(new Error('boxes did not reload')), 8000))])
  `)
  for (const name of await m('return boxes().map((b) => b.name)')) {
    const p = await page(name)
    await waitFor(`${name} shows its items again`, async () => (await p.evaluate('document.querySelectorAll(".item").length')) > 0)
    p.close()
  }
  ok('boxes reload after their page process crashes')
}

// DESKBOX_EXE=dist\win-unpacked\DeskBox.exe tests the packaged build instead of the source.
const [bin, ...appArg] = process.env.DESKBOX_EXE ? [process.env.DESKBOX_EXE] : [electron, '.']
const app = spawn(bin, [...appArg, `--inspect=${MAIN_PORT}`, `--remote-debugging-port=${PAGE_PORT}`], {
  cwd: __dirname,
  env: { ...process.env, DESKBOX_ROOT: ROOT, DESKBOX_DESKTOP: DESKTOP },
  stdio: 'ignore',
})
;(async () => {
  let failed = false
  try {
    const mainTarget = await waitFor('main process inspector', async () => (await targets(MAIN_PORT))[0])
    const main = await connect(mainTarget.webSocketDebuggerUrl)
    await waitFor('DeskBox ready', () => main.evaluate('!!globalThis.__deskbox'))
    await run(main)
    console.log('\nall e2e checks passed')
  } catch (e) {
    failed = true
    console.error(`\n✖ ${e.stack ?? e}`)
  } finally {
    app.kill()
    await sleep(500)
    fs.rmSync(tmp, { recursive: true, force: true })
    process.exit(failed ? 1 : 0)
  }
})()
