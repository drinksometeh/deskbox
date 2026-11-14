const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, screen, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { category, freePath, shortcutKind, moveInto, writeAtomic, readJson } = require('./fsutil')
const { readLnk } = require('./lnk')
const native = require('./native')

// Test seam (see e2e.js): run against temp folders instead of the real desktop.
const TEST = !!process.env.DESKBOX_ROOT
const ROOT = process.env.DESKBOX_ROOT || path.join(app.getPath('home'), 'DeskBox') // every tab is a real folder in here
const CONFIG = path.join(ROOT, 'boxes.json')
const DESKTOP = process.env.DESKBOX_DESKTOP || app.getPath('desktop')
if (TEST) app.setPath('userData', path.join(ROOT, '.electron')) // own single-instance lock, so it runs beside the real one
const HIDDEN = new Set(['desktop.ini', 'thumbs.db'])
const HEADER = 30 // collapsed height = title bar + border, see box.html
const LOGIN = { name: 'DeskBox', path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
// Tabs of the box that collects loose desktop files: [tab name, category() kind]
const DOC_TABS = [
  ['目录', '目錄'],
  ['文档', '文檔'],
  ['压缩', '壓縮'],
  ['其它', '其它'],
  ['图片', '圖片'],
]
// Boxes auto-organize creates when a kind has no tab yet: box name -> [tab name, kind]
const GROUPS = {
  游戏: [
    ['游戏', 'game'],
    ['平台', 'platform'],
  ],
  应用: [
    ['常用', 'daily'],
    ['开发', 'dev'],
    ['设计', 'design'],
    ['工具', 'tools'],
  ],
  文档: DOC_TABS,
}
const STILL_WRITING = /\.(crdownload|part|download|tmp)$|^~\$/i // downloads in progress, Office lock files
const GRACE = 10000 // leave new desktop items alone this long: a new folder may still be getting its name typed

let boxes = [] // saved state, see load()
let autoOrganize = true // file new desktop items into boxes automatically
let startupChosen = false // set once the installed app has turned on start-at-login the first time
let keep = new Set() // desktop names the user moved back on purpose; auto-organize leaves them alone
const live = new Map() // box id -> { win, watchers }
let iconsHidden = false
let tray

const visible = (f) => !f.startsWith('.') && !HIDDEN.has(f.toLowerCase())
const save = () => writeAtomic(CONFIG, JSON.stringify({ autoOrganize, startupChosen, keep: [...keep], boxes }, null, 2))
const toDesktop = (p) => {
  keep.add(path.basename(moveInto(p, DESKTOP)))
  save()
}
const readText = (p) => {
  const buf = fs.readFileSync(p)
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')
}
const boxOf = (sender) => boxes.find((b) => live.get(b.id)?.win.webContents === sender)
const notify = (box) => live.get(box.id)?.win.webContents.send('changed')
const shrink = (win) =>
  native.setHeight(win.getNativeWindowHandle(), Math.round(HEADER * screen.getDisplayMatching(win.getBounds()).scaleFactor))

function load() {
  const { data, damaged } = readJson(CONFIG)
  if (damaged)
    dialog.showMessageBox({
      type: 'warning',
      message: data ? '盒子設定檔損壞，已用上次啟動時的備份還原。' : '盒子設定檔損壞，也沒有可用的備份，盒子已重設。',
      detail: `盒子裡的檔案都還在 ${ROOT}。損壞的設定檔留在 ${CONFIG}.broken。`,
    })
  if (!data) return []
  autoOrganize = data.autoOrganize ?? true
  startupChosen = data.startupChosen ?? false
  keep = new Set(data.keep ?? [])
  if (Array.isArray(data.boxes)) return data.boxes
  // v0.1 saved { [boxName]: bounds } and kept the box's files in DeskBox/<boxName>
  return Object.entries(data).map(([name, b]) => ({ id: name, name, ...b, tabs: [{ name: '預設', dir: path.join(ROOT, name) }], active: 0 }))
}

async function confirm(box, message, detail, ok) {
  const win = box && live.get(box.id)?.win
  const opts = { type: 'question', buttons: [ok, '取消'], cancelId: 1, message, detail }
  const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
  return response === 0
}

const FOLDER_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#e8a317" d="M4 12a3 3 0 0 1 3-3h11l4 4h19a3 3 0 0 1 3 3v3H4z"/><path fill="#ffc94d" d="M4 18h40v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/></svg>',
  )
const expand = (s) => s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m)

// Electron gives every .lnk/.url the generic shortcut icon, so use the icon of what the shortcut points to.
// ponytail: ignores the shortcut's icon index (multi-icon .exe/.dll show their first icon); pass iconIndex via a native call if that matters.
function iconSource(p) {
  try {
    if (/\.url$/i.test(p)) {
      const icon = expand(/^IconFile=(.+)$/im.exec(readText(p))?.[1].trim() ?? '')
      return icon && fs.existsSync(icon) ? icon : p
    }
    if (!/\.lnk$/i.test(p)) return p
    const { icon, target } = readLnk(p)
    const candidates = [/\.dll$/i.test(icon) ? '' : icon, target].filter(Boolean).map(expand)
    return candidates.find((s) => fs.existsSync(s)) ?? p
  } catch {
    return p
  }
}

// Asking Windows for icons is the slow part of painting a tab, so remember them until the file changes.
// ponytail: unbounded; fine for a few hundred desktop items.
const iconCache = new Map()
async function iconOf(p) {
  const stat = fs.statSync(p, { throwIfNoEntry: false })
  if (stat?.isDirectory()) return FOLDER_ICON // Electron's folder icon looks like a drive
  const key = `${p}|${stat?.mtimeMs}`
  if (!iconCache.has(key)) {
    const src = iconSource(p)
    iconCache.set(
      key,
      /\.ico$/i.test(src)
        ? `data:image/x-icon;base64,${fs.readFileSync(src).toString('base64')}` // getFileIcon shows a blank page for .ico
        : (await app.getFileIcon(src, { size: 'large' })).toDataURL(),
    )
  }
  return iconCache.get(key)
}

// Where a box goes: its saved spot, unless that's on a monitor that's gone (unplugged, or off at boot) where nobody
// could reach it; then onto the nearest screen. The saved spot is kept, so the box goes back when the monitor does.
function placeOf(box) {
  if (box.x == null) return {} // never moved: Electron centers it
  const mid = { x: Math.round(box.x + box.width / 2), y: box.y + HEADER / 2 } // middle of the title bar
  const has = ({ x, y, width, height }) => mid.x >= x && mid.x < x + width && mid.y >= y && mid.y < y + height
  if (screen.getAllDisplays().some((d) => has(d.workArea))) return { x: box.x, y: box.y }
  const a = screen.getDisplayNearestPoint(mid).workArea
  return { x: Math.max(a.x, Math.min(box.x, a.x + a.width - box.width)), y: Math.max(a.y, Math.min(box.y, a.y + a.height - HEADER)) }
}
// Window moves made here don't fire 'moved' (that's only the user's drags), so the saved spots stay as they were.
function placeAll() {
  for (const box of boxes) {
    const win = live.get(box.id)?.win
    const { x, y } = placeOf(box)
    if (!win || x == null) continue
    win.setPosition(x, y)
    if (box.collapsed) shrink(win)
  }
}

function openBox(box) {
  for (const t of box.tabs) if (!t.mapped) fs.mkdirSync(t.dir, { recursive: true })
  const win = new BrowserWindow({
    ...placeOf(box),
    width: box.width,
    height: box.collapsed ? HEADER : box.height,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    show: false,
    minimizable: false,
    maximizable: false,
    movable: !box.locked,
    resizable: !box.locked && !box.collapsed,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  const hwnd = win.getNativeWindowHandle()
  native.pinToDesktop(hwnd)
  native.blurBehind(hwnd)
  if (box.collapsed) shrink(win)
  win.loadFile('box.html')
  win.once('ready-to-show', () => iconsHidden || win.showInactive())
  // All boxes share one page process (see process-per-site), so if it dies they all go blank: load them again.
  // ponytail: a page that crashes on load would reload every second; add a retry limit if that ever happens.
  win.webContents.on('render-process-gone', () => setTimeout(() => win.isDestroyed() || win.reload(), 1000))
  const remember = () => {
    const { x, y, width, height } = win.getBounds()
    Object.assign(box, { x, y, width }, box.collapsed ? {} : { height })
    save()
  }
  win.on('moved', remember)
  win.on('resized', remember)
  // Boxes never minimize: undo Win+M, or a launcher that asked for a minimized start.
  win.on('minimize', () => win.showInactive())
  const watchers = new Map() // tab dir -> fs.FSWatcher
  for (const t of box.tabs) watchTab(box, watchers, t)
  win.on('closed', () => {
    if (live.get(box.id)?.win !== win) return // closed on purpose by closeBox()
    watchers.forEach((w) => w.close())
    live.delete(box.id)
    // Explorer restarted (our owner, the desktop window, died with it) or Alt+F4: boxes aren't meant to close.
    reopenWhenDesktopIsBack(box)
  })
  live.set(box.id, { win, watchers })
}

function watchTab(box, watchers, t) {
  if (!watchers.has(t.dir) && fs.existsSync(t.dir)) watchers.set(t.dir, fs.watch(t.dir, () => notify(box)))
}

function reopenWhenDesktopIsBack(box) {
  setTimeout(() => {
    if (!boxes.includes(box) || live.has(box.id)) return
    if (!native.hasDesktop()) return reopenWhenDesktopIsBack(box) // Explorer still starting
    openBox(box)
    if (iconsHidden) toggleDesktop() // the new desktop shows its icons again; match it
  }, 2000)
}

function closeBox(box) {
  const l = live.get(box.id)
  if (!l) return
  l.watchers.forEach((w) => w.close()) // Windows keeps watched folders locked
  live.delete(box.id)
  l.win.destroy()
}

function newBox(name, tabNames = ['預設']) {
  const box = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    width: 360,
    height: 260,
    tabs: tabNames.map((t) => ({ name: t, dir: freePath(ROOT, tabNames.length > 1 ? `${name}・${t}` : name) })),
    active: 0,
  }
  boxes.push(box)
  save()
  openBox(box)
  return box
}

function addTab(box, tab) {
  if (!tab.mapped) fs.mkdirSync(tab.dir, { recursive: true })
  box.tabs.push(tab)
  box.active = box.tabs.length - 1
  save()
  watchTab(box, live.get(box.id).watchers, tab)
  notify(box)
}

// Moves a tab's items to the desktop; optionally removes its folder once empty. Mapped folders are never touched.
function emptyTab(t, removeFolder) {
  if (t.mapped || !fs.existsSync(t.dir)) return
  for (const f of fs.readdirSync(t.dir).filter(visible)) {
    try {
      toDesktop(path.join(t.dir, f))
    } catch {} // in use: leave it where it is
  }
  if (removeFolder && !fs.readdirSync(t.dir).some(visible)) fs.rmSync(t.dir, { recursive: true })
}

async function deleteTab(box, i) {
  const t = box.tabs[i]
  const detail = t.mapped ? '只移除這個分頁，資料夾本身不會被動到。' : '分頁裡的東西會先移回桌面。'
  if (!(await confirm(box, `刪除分頁「${t.name}」？`, detail, '刪除'))) return
  const { watchers } = live.get(box.id)
  watchers.get(t.dir)?.close() // Windows keeps watched folders locked
  watchers.delete(t.dir)
  emptyTab(t, true)
  box.tabs.splice(i, 1)
  box.active = 0
  save()
  notify(box)
}

async function deleteBox(box) {
  if (!(await confirm(box, `刪除盒子「${box.name}」？`, '裡面的東西會先全部移回桌面，映射的資料夾不會被動到。', '刪除'))) return
  closeBox(box)
  box.tabs.forEach((t) => emptyTab(t, true))
  boxes = boxes.filter((b) => b !== box)
  save()
}

function toggleCollapse(box) {
  const { win } = live.get(box.id)
  box.collapsed = !box.collapsed
  win.setResizable(!box.collapsed && !box.locked)
  if (box.collapsed) shrink(win)
  else win.setSize(box.width, box.height)
  save()
  notify(box)
}

function toggleLock(box) {
  const { win } = live.get(box.id)
  box.locked = !box.locked
  win.setMovable(!box.locked)
  win.setResizable(!box.locked && !box.collapsed)
  if (box.collapsed) shrink(win)
  save()
  notify(box)
}

function shortcutTarget(p) {
  try {
    if (/\.url$/i.test(p)) return /^URL=(.+)$/im.exec(readText(p))?.[1] ?? ''
    const { target, args } = readLnk(p)
    return `${target} ${args}`
  } catch {
    return ''
  }
}

// Where a desktop item belongs: shortcuts by shortcutKind (game, platform, daily, dev, design, tools),
// files/folders by their DOC_TABS kind.
function kindOf(p) {
  if (/\.(lnk|url)$/i.test(p)) return shortcutKind(`${path.basename(p).replace(/\.(lnk|url)$/i, '')} ${shortcutTarget(p)}`)
  const k = category(p)
  return k === '程式' ? '其它' : k // loose .exe files go with the other files, like Coodesker did
}

// The tab that collects a kind. If it's missing, add it to its group's box, or create that box with all its tabs.
function tabFor(kind) {
  const found = boxes.flatMap((b) => b.tabs).find((t) => t.kind === kind)
  if (found) return found
  const [boxName, group] = Object.entries(GROUPS).find(([, g]) => g.some(([, k]) => k === kind))
  const home = boxes.find((b) => b.tabs.some((t) => group.some(([, k]) => k === t.kind)))
  if (home) {
    const [tabName] = group.find(([, k]) => k === kind)
    addTab(home, { name: tabName, dir: freePath(ROOT, `${home.name}・${tabName}`), kind })
    return home.tabs.at(-1)
  }
  const box = newBox(boxName, group.map(([name]) => name))
  box.tabs.forEach((t, i) => (t.kind = group[i][1]))
  save()
  return box.tabs.find((t) => t.kind === kind)
}

// Files every desktop item into its box. Returns how many were left behind (in use or still being written).
function sweepDesktop() {
  let left = 0
  const files = fs.readdirSync(DESKTOP).filter(visible)
  keep = new Set([...keep].filter((f) => files.includes(f))) // forget items that have left the desktop
  save()
  for (const f of files) {
    if (keep.has(f)) continue
    const p = path.join(DESKTOP, f)
    try {
      const { mtimeMs, birthtimeMs } = fs.statSync(p)
      if (STILL_WRITING.test(f) || Date.now() - Math.max(mtimeMs, birthtimeMs) < GRACE) throw new Error('busy')
      moveInto(p, tabFor(kindOf(p)).dir)
    } catch {
      left++
    }
  }
  return left
}

let sweepTimer
function scheduleSweep(delay = 1000) {
  clearTimeout(sweepTimer)
  sweepTimer = setTimeout(() => autoOrganize && sweepDesktop() && scheduleSweep(GRACE), delay) // retry leftovers later
}

async function organizeDesktop() {
  const count = fs.readdirSync(DESKTOP).filter(visible).length
  if (!count) return
  const detail = '遊戲捷徑→「游戏」，其他捷徑→「应用」，檔案和資料夾按類型→「文档」。隨時能用盒子選單的「全部移回桌面」放回去。'
  if (!(await confirm(null, `把桌面上的 ${count} 個項目收進盒子？`, detail, '整理'))) return
  const left = sweepDesktop()
  if (left) dialog.showMessageBox({ message: `有 ${left} 個項目正在使用中，留在桌面上。` })
}

function toggleDesktop() {
  iconsHidden = !iconsHidden
  native.setDesktopIconsVisible(!iconsHidden)
  for (const { win } of live.values()) iconsHidden ? win.hide() : win.showInactive()
}

ipcMain.handle('state', (e) => {
  const { name, tabs, active, collapsed, locked, view } = boxOf(e.sender)
  return { name, tabs: tabs.map((t) => t.name), active, collapsed: !!collapsed, locked: !!locked, view: view ?? 'grid' }
})

// A tab shows its items in the order the user dragged them into; items never placed follow, in folder order.
function ordered(t, files) {
  const at = new Map((t.order ?? []).map((f, i) => [f, i]))
  return files.sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || 0)
}

ipcMain.handle('list', async (e, tab) => {
  const box = boxOf(e.sender)
  const t = box.tabs[tab ?? box.active]
  const dir = t?.dir
  if (!dir) return []
  if (!fs.existsSync(dir)) return []
  const files = ordered(t, fs.readdirSync(dir).filter(visible))
  return Promise.all(
    files.map(async (f) => {
      const p = path.join(dir, f)
      return { path: p, label: f.replace(/\.(lnk|url)$/i, ''), icon: await iconOf(p) }
    }),
  )
})

ipcMain.handle('open', (e, p) => shell.openPath(p))

// before: path of the item the drop landed in front of, '' for the end, undefined when dropped on a tab (no position).
ipcMain.handle('drop', (e, paths, tab, before) => {
  const box = boxOf(e.sender)
  const t = box.tabs[tab ?? box.active]
  const moved = []
  for (const p of paths) {
    try {
      moved.push(path.basename(moveInto(p, t.dir)))
    } catch {} // in use or gone: it stays where it was, the others still move
  }
  if (before != null) {
    const rest = ordered(t, fs.readdirSync(t.dir).filter(visible)).filter((f) => !moved.includes(f))
    const i = rest.indexOf(path.basename(before))
    rest.splice(i < 0 ? rest.length : i, 0, ...moved)
    t.order = rest
    save()
  }
  // Repaint even when no file changed (a reorder in one folder, or nothing could move): no watcher fires then, and
  // the renderer has already taken the dragged icons out or moved them.
  notify(box)
})

ipcMain.handle('switch-tab', (e, i) => {
  boxOf(e.sender).active = i // the renderer already repainted; just remember it
  save()
})

ipcMain.handle('rename-box', (e, name) => {
  boxOf(e.sender).name = name
  save()
})

ipcMain.handle('rename-tab', (e, i, name) => {
  boxOf(e.sender).tabs[i].name = name
  save()
})

ipcMain.handle('toggle-collapse', (e) => toggleCollapse(boxOf(e.sender)))
ipcMain.handle('toggle-lock', (e) => toggleLock(boxOf(e.sender)))
ipcMain.handle('toggle-view', (e) => {
  const box = boxOf(e.sender)
  box.view = box.view === 'list' ? 'grid' : 'list'
  save()
  notify(box)
})

const trash = (paths) => Promise.all(paths.map((p) => shell.trashItem(p).catch(() => {})))
ipcMain.handle('trash', (e, paths) => trash(paths))

ipcMain.handle('item-menu', (e, paths) => {
  const n = paths.length > 1 ? `（${paths.length} 個）` : ''
  Menu.buildFromTemplate([
    { label: `移回桌面${n}`, click: () => paths.forEach(toDesktop) },
    { label: '在檔案總管中顯示', click: () => shell.showItemInFolder(paths[0]) },
    { type: 'separator' },
    { label: `刪除（移到資源回收筒）${n}`, click: () => trash(paths) },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) })
})

let dragIcon // app icon, for drags whose item icon can't be turned into an image (the SVG folder)
ipcMain.handle('start-drag', (e, paths, iconUrl) => {
  const icon = nativeImage.createFromDataURL(iconUrl)
  e.sender.startDrag({ file: paths[0], files: paths, icon: icon.isEmpty() ? dragIcon : icon.resize({ width: 32 }) })
  // Returns once the drop is done. Items dropped on the desktop were put there on purpose: don't auto-file them back.
  for (const p of paths) if (!fs.existsSync(p) && fs.existsSync(path.join(DESKTOP, path.basename(p)))) keep.add(path.basename(p))
  save()
})

ipcMain.handle('box-menu', (e) => {
  const box = boxOf(e.sender)
  const { win } = live.get(box.id)
  const tab = box.tabs[box.active]
  const nextTab = `分頁 ${box.tabs.length + 1}`
  Menu.buildFromTemplate([
    { label: '新增分頁', click: () => addTab(box, { name: nextTab, dir: freePath(ROOT, `${box.name}・${nextTab}`) }) },
    {
      label: '新增資料夾映射分頁…',
      click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        const dir = r.filePaths[0]
        if (!r.canceled) addTab(box, { name: path.basename(dir) || dir, dir, mapped: true })
      },
    },
    { label: `刪除分頁「${tab.name}」`, enabled: box.tabs.length > 1, click: () => deleteTab(box, box.active) },
    { type: 'separator' },
    { label: box.collapsed ? '展開' : '收合', click: () => toggleCollapse(box) },
    { label: '鎖定位置', type: 'checkbox', checked: !!box.locked, click: () => toggleLock(box) },
    { type: 'separator' },
    { label: '全部移回桌面', click: () => box.tabs.forEach((t) => emptyTab(t, false)) },
    { label: '刪除盒子', click: () => deleteBox(box) },
  ]).popup({ window: win })
})

// Boxes are small static pages and the blur is drawn by Windows (DWM), so skip the GPU and let every box share
// one renderer process: ~300 MB -> ~170 MB. ponytail: one box's renderer crashing now blanks them all.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('process-per-site') // every box is file://box.html, so one site, one process

if (!app.requestSingleInstanceLock()) app.exit()
app.on('window-all-closed', () => {}) // keep running in the tray
app.on('will-quit', () => native.setDesktopIconsVisible(true)) // never leave the desktop without icons

app.whenReady().then(async () => {
  fs.mkdirSync(ROOT, { recursive: true })
  boxes = load()
  if (boxes.length) boxes.forEach((b) => openBox(b))
  else newBox('盒子')
  if (TEST) global.__deskbox = { live, fs, electron: require('electron'), boxes: () => boxes, keep: () => keep }
  else {
    native.setDesktopIconsVisible(true) // in case a previous run died while they were hidden
    native.onDesktopDoubleClick(toggleDesktop)
  }
  for (const e of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(e, placeAll)
  // ponytail: only the user's own desktop; shortcuts installers drop on the all-users desktop need admin to move
  fs.watch(DESKTOP, () => scheduleSweep())
  scheduleSweep(0)

  if (app.isPackaged && !startupChosen && !TEST) {
    // First run of the installed app: start with Windows. The tray checkbox turns it off for good.
    app.setLoginItemSettings({ ...LOGIN, openAtLogin: true })
    startupChosen = true
    save()
  }
  dragIcon = await app.getFileIcon(process.execPath)
  tray = new Tray(dragIcon)
  tray.setToolTip('DeskBox')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '新增盒子', click: () => newBox('盒子') },
      {
        label: '自動整理桌面',
        type: 'checkbox',
        checked: autoOrganize,
        click: (item) => {
          autoOrganize = item.checked
          save()
          scheduleSweep(0)
        },
      },
      { label: '立即整理桌面', click: organizeDesktop },
      { label: '打開 DeskBox 資料夾', click: () => shell.openPath(ROOT) },
      { type: 'separator' },
      {
        label: '開機自動啟動',
        type: 'checkbox',
        // openAtLogin ignores LOGIN.name on Windows, so look for our entry in launchItems instead
        checked: !!app.getLoginItemSettings(LOGIN).launchItems?.some((i) => i.name === LOGIN.name && i.enabled),
        click: (item) => app.setLoginItemSettings({ ...LOGIN, openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: '結束', click: () => app.quit() },
    ]),
  )
}).catch((e) => {
  // Otherwise it keeps running with no box and no tray icon, and holds the single-instance lock so it can't be reopened.
  dialog.showErrorBox('DeskBox 無法啟動', String(e?.stack ?? e))
  app.exit(1)
})
