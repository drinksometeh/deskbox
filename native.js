// Win32 calls Electron doesn't expose. ponytail: koffi FFI straight into user32/dwmapi, no native build step.
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const kernel32 = koffi.load('kernel32.dll')

const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
  pt: POINT,
  mouseData: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  extra: 'uintptr',
})
const ACCENT_POLICY = koffi.struct('ACCENT_POLICY', { state: 'int32', flags: 'int32', color: 'uint32', animation: 'int32' })
const WCA_DATA = koffi.struct('WCA_DATA', { attrib: 'int32', data: 'void *', size: 'size_t' })
const HookProc = koffi.proto('intptr __stdcall HookProc(int code, uintptr wParam, void *lParam)')

const FindWindowW = user32.func('intptr __stdcall FindWindowW(str16 cls, str16 name)')
const FindWindowExW = user32.func('intptr __stdcall FindWindowExW(intptr parent, intptr after, str16 cls, str16 name)')
const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int cmd)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)')
const WindowFromPoint = user32.func('intptr __stdcall WindowFromPoint(POINT pt)')
const SendMessageW = user32.func('intptr __stdcall SendMessageW(intptr hwnd, uint32 msg, uintptr wParam, intptr lParam)')
const GetDoubleClickTime = user32.func('uint32 __stdcall GetDoubleClickTime()')
const SetWindowCompositionAttribute = user32.func('bool __stdcall SetWindowCompositionAttribute(intptr hwnd, WCA_DATA *data)')
const SetWindowsHookExW = user32.func('intptr __stdcall SetWindowsHookExW(int id, HookProc *proc, intptr module, uint32 thread)')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(intptr hook, int code, uintptr wParam, void *lParam)')
const DwmSetWindowAttribute = dwmapi.func('int32 __stdcall DwmSetWindowAttribute(intptr hwnd, uint32 attr, int32 *value, uint32 size)')
const GetModuleHandleW = kernel32.func('intptr __stdcall GetModuleHandleW(str16 name)')

const RECT = koffi.struct('RECT', { l: 'int32', t: 'int32', r: 'int32', b: 'int32' })
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)')
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int w, int h, uint32 flags)')

const handle = (buf) => Number(buf.readBigInt64LE())

// Chromium won't size a transparent frameless window below ~64px; skipping WM_WINDOWPOSCHANGING gets around it.
// ponytail: Electron's own setBounds/setPosition re-apply that limit, so call this after any of them.
function setHeight(buf, physicalHeight) {
  const hwnd = handle(buf)
  const r = {}
  GetWindowRect(hwnd, r)
  SetWindowPos(hwnd, 0, 0, 0, r.r - r.l, physicalHeight, 0x0002 | 0x0004 | 0x0010 | 0x0400) // NOMOVE|NOZORDER|NOACTIVATE|NOSENDCHANGING
}

const hasDesktop = () => FindWindowW('Progman', null) !== 0

// Owned by the desktop window: sits just above the desktop and survives Win+D.
function pinToDesktop(buf) {
  SetWindowLongPtrW(handle(buf), -8 /* GWLP_HWNDPARENT */, FindWindowW('Progman', null))
}

// Blurs what's behind the window. Unlike Electron's backgroundMaterial it keeps blurring while the window is inactive.
const accent = koffi.alloc(ACCENT_POLICY, 1)
koffi.encode(accent, ACCENT_POLICY, { state: 3 /* ACCENT_ENABLE_BLURBEHIND */, flags: 0, color: 0, animation: 0 })
function blurBehind(buf) {
  const hwnd = handle(buf)
  SetWindowCompositionAttribute(hwnd, { attrib: 19 /* WCA_ACCENT_POLICY */, data: accent, size: koffi.sizeof(ACCENT_POLICY) })
  DwmSetWindowAttribute(hwnd, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, new Int32Array([2]) /* round */, 4)
}

// The desktop icon list lives under Progman, or under a WorkerW once a wallpaper slideshow etc. has run.
function desktop() {
  let host = FindWindowW('Progman', null)
  let view = FindWindowExW(host, 0, 'SHELLDLL_DefView', null)
  for (let w = FindWindowExW(0, 0, 'WorkerW', null); !view && w; w = FindWindowExW(0, w, 'WorkerW', null)) {
    view = FindWindowExW(w, 0, 'SHELLDLL_DefView', null)
    if (view) host = w
  }
  return { host, view, list: view ? FindWindowExW(view, 0, 'SysListView32', null) : 0 }
}

function setDesktopIconsVisible(show) {
  const { list } = desktop()
  if (list) ShowWindow(list, show ? 5 /* SW_SHOW */ : 0 /* SW_HIDE */)
}

// True when a double-click hit empty desktop: no icon got selected, or the icons are hidden.
function onEmptyDesktop(pt) {
  const { host, view, list } = desktop()
  if (!list) return false
  const hit = WindowFromPoint(pt)
  if (!IsWindowVisible(list)) return hit === view || hit === host
  return hit === list && SendMessageW(list, 0x1032 /* LVM_GETSELECTEDCOUNT */, 0, 0) === 0
}

// Low-level mouse hook: the desktop belongs to Explorer, so its clicks never reach our windows.
let proc // keep the callback alive for as long as the hook is installed
function onDesktopDoubleClick(cb) {
  const maxGap = GetDoubleClickTime()
  let last = { time: -Infinity, x: 0, y: 0 }
  proc = koffi.register((code, wParam, lParam) => {
    if (code === 0 && wParam === 0x201 /* WM_LBUTTONDOWN */) {
      const { pt, time } = koffi.decode(lParam, MSLLHOOKSTRUCT)
      const double = time - last.time <= maxGap && Math.abs(pt.x - last.x) <= 4 && Math.abs(pt.y - last.y) <= 4
      last = double ? { time: -Infinity, x: 0, y: 0 } : { time, x: pt.x, y: pt.y }
      if (double) setTimeout(() => onEmptyDesktop(pt) && cb(), 80) // let Explorer handle the click first
    }
    return CallNextHookEx(0, code, wParam, lParam)
  }, koffi.pointer(HookProc))
  SetWindowsHookExW(14 /* WH_MOUSE_LL */, proc, GetModuleHandleW(null), 0)
}

module.exports = { hasDesktop, pinToDesktop, blurBehind, setHeight, setDesktopIconsVisible, onDesktopDoubleClick }
