const title = document.getElementById('title')
const fold = document.getElementById('fold')
const view = document.getElementById('view')
const lock = document.getElementById('lock')
const menu = document.getElementById('menu')
const tabs = document.getElementById('tabs')
const items = document.getElementById('items')

const svg = (paths) => `<svg viewBox="0 0 16 16">${paths}</svg>`
const ICONS = {
  collapse: svg('<path d="M4 10l4-4 4 4"/>'),
  expand: svg('<path d="M4 6l4 4 4-4"/>'),
  list: svg('<rect x="2.5" y="3" width="3" height="3"/><path d="M8 4.5h5.5"/><rect x="2.5" y="10" width="3" height="3"/><path d="M8 11.5h5.5"/>'),
  grid: svg('<rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/>'),
  unlocked: svg('<rect x="3.5" y="7.5" width="9" height="6.5" rx="1"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0"/>'),
  locked: svg('<rect x="3.5" y="7.5" width="9" height="6.5" rx="1"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/>'),
  menu: svg('<path d="M3 4.5h10M3 8h10M3 11.5h10"/>'),
}
menu.innerHTML = ICONS.menu

let state // from box.state()
const lists = new Map() // tab index -> items, so a tab switch paints at once
const selected = new Set() // selected item paths
const editing = () => document.querySelector('[contenteditable="true"]')

function paintSelection() {
  for (const el of items.children) el.classList.toggle('selected', selected.has(el.dataset.path))
}
function selectOnly(paths) {
  selected.clear()
  paths.forEach((p) => selected.add(p))
  paintSelection()
}

function itemEl(it) {
  const el = document.createElement('div')
  el.className = selected.has(it.path) ? 'item selected' : 'item'
  el.dataset.path = it.path
  el.title = it.label
  el.draggable = true
  const img = document.createElement('img')
  img.src = it.icon
  const label = document.createElement('span')
  label.textContent = it.label
  el.append(img, label)
  el.onmousedown = (e) => {
    if (e.button !== 0) return
    e.stopPropagation() // not the start of a marquee
    if (e.ctrlKey) selected.has(it.path) ? selected.delete(it.path) : selected.add(it.path)
    else if (!selected.has(it.path)) selected.clear(), selected.add(it.path) // keep a multi-selection so it can be dragged
    paintSelection()
  }
  el.ondblclick = () => box.open(it.path)
  el.oncontextmenu = (e) => {
    e.stopPropagation()
    if (!selected.has(it.path)) selectOnly([it.path])
    box.itemMenu([...selected])
  }
  el.ondragstart = (e) => {
    e.preventDefault() // hand over to a native drag so files can go to other boxes, the desktop or Explorer
    box.startDrag([...selected], it.icon)
  }
  return el
}

function tabEl(name, i) {
  const el = document.createElement('span')
  el.className = i === state.active ? 'tab active' : 'tab'
  el.textContent = name
  el.onclick = () => switchTab(i)
  el.ondblclick = () => editInline(el, name, (v) => box.renameTab(i, v))
  el.ondragover = (e) => e.preventDefault()
  el.ondrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    box.drop([...e.dataTransfer.files], i)
  }
  return el
}

function paintHeader() {
  document.body.classList.toggle('collapsed', state.collapsed)
  document.body.classList.toggle('list', state.view === 'list')
  title.textContent = state.name
  fold.innerHTML = state.collapsed ? ICONS.expand : ICONS.collapse
  fold.title = state.collapsed ? '展開' : '收合'
  view.innerHTML = state.view === 'list' ? ICONS.grid : ICONS.list // shows the mode a click switches to
  view.title = state.view === 'list' ? '切換為圖示顯示' : '切換為列表顯示'
  lock.innerHTML = state.locked ? ICONS.locked : ICONS.unlocked
  lock.title = state.locked ? '解除鎖定位置' : '鎖定位置'
  tabs.hidden = state.tabs.length < 2
  tabs.replaceChildren(...state.tabs.map(tabEl))
}

async function loadTab(i) {
  const list = await box.list(i)
  lists.set(i, list)
  if (state.active !== i || state.collapsed) return // the user has moved on
  for (const p of selected) if (!list.some((it) => it.path === p)) selected.delete(p)
  items.replaceChildren(...list.map(itemEl))
}

function switchTab(i) {
  if (i === state.active) return
  state.active = i
  selected.clear()
  paintHeader()
  items.replaceChildren(...(lists.get(i) ?? []).map(itemEl)) // cached copy now, fresh copy below
  box.switchTab(i)
  loadTab(i)
}

async function refresh() {
  if (editing()) return // don't wipe a rename in progress
  state = await box.state()
  paintHeader()
  if (!state.collapsed) await loadTab(state.active)
}

function editInline(el, current, commit) {
  el.contentEditable = 'true'
  el.focus()
  document.execCommand('selectAll')
  el.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      el.blur()
    }
    if (e.key === 'Escape') {
      el.textContent = current
      el.blur()
    }
  }
  el.onblur = async () => {
    el.contentEditable = 'false'
    el.onblur = el.onkeydown = null
    const next = el.textContent.trim()
    if (next && next !== current) await commit(next)
    refresh()
  }
}

// Marquee: drag on empty space to select every item the rectangle touches (Ctrl adds to the selection).
// ponytail: no auto-scroll while dragging past the edge; scroll first if the items are off-screen.
items.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  const keep = e.ctrlKey ? new Set(selected) : new Set()
  const rect = document.createElement('div')
  rect.className = 'marquee'
  let shown = false
  const move = (m) => {
    const l = Math.min(e.clientX, m.clientX)
    const t = Math.min(e.clientY, m.clientY)
    const r = Math.max(e.clientX, m.clientX)
    const b = Math.max(e.clientY, m.clientY)
    if (!shown && r - l < 3 && b - t < 3) return
    if (!shown) document.body.append(rect), (shown = true)
    Object.assign(rect.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` })
    selected.clear()
    keep.forEach((p) => selected.add(p))
    for (const el of items.children) {
      const q = el.getBoundingClientRect()
      if (q.left < r && q.right > l && q.top < b && q.bottom > t) selected.add(el.dataset.path)
    }
    paintSelection()
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    if (shown) rect.remove()
    else if (!e.ctrlKey) selectOnly([]) // plain click on empty space
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})

document.addEventListener('keydown', (e) => {
  if (editing()) return
  if (e.key === 'Delete' && selected.size) box.trash([...selected])
  if (e.key === 'Enter') selected.forEach((p) => box.open(p))
  if (e.key === 'Escape') selectOnly([])
  if (e.key === 'a' && e.ctrlKey) {
    e.preventDefault()
    selectOnly([...items.children].map((el) => el.dataset.path))
  }
})

let timer
box.onChange(() => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    lists.clear() // files changed: every cached tab may be stale
    refresh()
  }, 100) // fs.watch fires several times per change
})

refresh().then(() => {
  // warm the other tabs so the first switch is instant too
  state.tabs.forEach((_, i) => i !== state.active && box.list(i).then((l) => lists.set(i, l)))
})

title.ondblclick = () => editInline(title, title.textContent, box.renameBox)
fold.onclick = () => box.toggleCollapse()
view.onclick = () => box.toggleView()
lock.onclick = () => box.toggleLock()
menu.onclick = () => box.boxMenu()
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  box.boxMenu()
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  box.drop([...e.dataTransfer.files])
})
