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
let dragging = new Set() // paths being dragged out of this box, until the drop is done
const editing = () => document.querySelector('[contenteditable="true"]')
const droppedPaths = (e) => [...e.dataTransfer.files].map(box.pathOf)

// The item a drop at (x, y) lands in front of (null = the end): the first item past the pointer in reading order,
// not counting the items being dragged.
function dropTarget(x, y) {
  const els = [...items.children]
  const list = document.body.classList.contains('list')
  let i = els.findIndex((el) => {
    const r = el.getBoundingClientRect()
    if (y < r.top) return true
    if (y > r.bottom) return false
    return list ? y < r.top + r.height / 2 : x < r.left + r.width / 2
  })
  if (i < 0) i = els.length
  while (i < els.length && dragging.has(els[i].dataset.path)) i++
  return els[i] ?? null
}
function clearDrop() {
  for (const el of items.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after')
}
function showDrop(before) {
  clearDrop()
  if (before) before.classList.add('drop-before')
  else items.lastElementChild?.classList.add('drop-after')
}

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
  el.ondragstart = async (e) => {
    e.preventDefault() // hand over to a native drag so files can go to other boxes, the desktop or Explorer
    const paths = [...items.children].map((c) => c.dataset.path).filter((p) => selected.has(p)) // keep their order
    dragging = new Set(paths)
    await box.startDrag(paths, it.icon)
    dragging = new Set()
    clearDrop()
  }
  return el
}

function tabEl(name, i) {
  const el = document.createElement('span')
  el.className = i === state.active ? 'tab active' : 'tab'
  el.textContent = name
  el.onclick = () => switchTab(i)
  el.ondblclick = () => editInline(el, name, (v) => box.renameTab(i, v))
  // Dragging onto a tab: it glows while the pointer is over it and flashes once the items land in it.
  const takes = () => !(dragging.size && i === state.active) // items dragged out of this tab onto itself go nowhere
  el.ondragover = (e) => {
    e.preventDefault()
    clearDrop()
    if (takes()) el.classList.add('drop-target')
  }
  el.ondragleave = () => el.classList.remove('drop-target')
  el.ondrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    el.classList.remove('drop-target')
    if (!takes()) return
    for (const c of [...items.children]) if (dragging.has(c.dataset.path)) c.remove() // they're leaving this tab
    el.classList.add('dropped')
    el.addEventListener('animationend', () => el.classList.remove('dropped'), { once: true })
    box.drop(droppedPaths(e), i)
  }
  return el
}

function paintHeader(tabsChanged) {
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
  // Rebuild the tabs only when they changed, so a running drop flash isn't cut off by the refresh the drop causes.
  if (tabsChanged) tabs.replaceChildren(...state.tabs.map(tabEl))
  else [...tabs.children].forEach((el, j) => el.classList.toggle('active', j === state.active))
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
  ;[...tabs.children].forEach((el, j) => el.classList.toggle('active', j === i)) // keep the tab elements so a double-click (rename) still lands
  items.replaceChildren(...(lists.get(i) ?? []).map(itemEl)) // cached copy now, fresh copy below
  box.switchTab(i)
  loadTab(i)
}

async function refresh() {
  if (editing()) return // don't wipe a rename in progress
  const before = state?.tabs.join('\n')
  state = await box.state()
  const tabsChanged = state.tabs.join('\n') !== before
  if (tabsChanged) lists.clear() // tabs added/removed/renamed: cached indexes no longer line up
  paintHeader(tabsChanged)
  if (state.collapsed) return
  await loadTab(state.active)
  // refresh the other tabs in the background so switching shows current content at once
  state.tabs.forEach((_, i) => i !== state.active && box.list(i).then((l) => lists.set(i, l)))
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
  timer = setTimeout(refresh, 100) // fs.watch fires several times per change
})
refresh()

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
document.addEventListener('dragleave', (e) => e.relatedTarget || clearDrop()) // pointer left the window
document.addEventListener('drop', (e) => {
  e.preventDefault()
  box.drop(droppedPaths(e)) // on the title bar: file it, no position
})
items.addEventListener('dragover', (e) => {
  e.preventDefault()
  showDrop(dropTarget(e.clientX, e.clientY))
})
items.addEventListener('drop', (e) => {
  e.preventDefault()
  e.stopPropagation()
  const before = dropTarget(e.clientX, e.clientY)
  clearDrop()
  // Rearranging inside this box: move the icons now instead of waiting for the reload.
  for (const el of [...items.children]) if (dragging.has(el.dataset.path)) items.insertBefore(el, before)
  box.drop(droppedPaths(e), undefined, before?.dataset.path ?? '')
})
