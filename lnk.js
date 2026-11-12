// Minimal .lnk reader (MS-SHLLINK). Electron's shell.readShortcutLink crashes the whole app on some shortcuts
// (the VS Code installer's, for one), and a native crash can't be caught, so read the file ourselves.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// A shortcut that only stores a relative path stops resolving once moved; the ones in DeskBox came from a desktop.
const BASES = [path.join(os.homedir(), 'Desktop'), path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop')]
const fromRelative = (file, rel) =>
  [path.dirname(file), ...BASES].map((d) => path.resolve(d, rel)).find((p) => fs.existsSync(p)) ?? path.resolve(path.dirname(file), rel)

const expand = (s) => s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m)
const astr = (b, off) => b.toString('latin1', off, b.indexOf(0, off))
function wstr(b, off) {
  let end = off
  while (end + 1 < b.length && b.readUInt16LE(end)) end += 2
  return b.toString('utf16le', off, end)
}

function readLnk(file) {
  const b = fs.readFileSync(file)
  if (b.length < 0x4c || b.readUInt32LE(0) !== 0x4c) throw new Error('not a shortcut')
  const flags = b.readUInt32LE(0x14)
  const unicode = flags & 0x80
  let pos = 0x4c
  if (flags & 0x01) pos += 2 + b.readUInt16LE(pos) // skip LinkTargetIDList

  let target = ''
  if (flags & 0x02) {
    // LinkInfo: local base path + suffix, Unicode copies when the header is big enough to have them
    const headerSize = b.readUInt32LE(pos + 4)
    if (b.readUInt32LE(pos + 8) & 0x01) {
      target =
        headerSize >= 0x24
          ? wstr(b, pos + b.readUInt32LE(pos + 0x1c)) + wstr(b, pos + b.readUInt32LE(pos + 0x20))
          : astr(b, pos + b.readUInt32LE(pos + 0x10)) + astr(b, pos + b.readUInt32LE(pos + 0x18))
    }
    pos += b.readUInt32LE(pos)
  }

  const strings = {}
  for (const [bit, key] of [[0x04, 'name'], [0x08, 'relativePath'], [0x10, 'workingDir'], [0x20, 'args'], [0x40, 'icon']]) {
    if (!(flags & bit)) continue
    const n = b.readUInt16LE(pos)
    pos += 2
    const s = unicode ? b.toString('utf16le', pos, pos + n * 2) : b.toString('latin1', pos, pos + n)
    strings[key] = s.replace(/\0+$/, '') // some writers (Ryujinx) count the terminating null
    pos += unicode ? n * 2 : n
  }

  // ExtraData: environment-variable target (0xA0000001) and icon (0xA0000007) blocks, each with a 520-byte Unicode path
  const env = {}
  while (pos + 8 <= b.length) {
    const size = b.readUInt32LE(pos)
    if (size < 8) break
    const sig = b.readUInt32LE(pos + 4)
    if ((sig === 0xa0000001 || sig === 0xa0000007) && size >= 0x314) env[sig] = wstr(b, pos + 8 + 260)
    pos += size
  }

  target ||= expand(env[0xa0000001] ?? '') || (strings.relativePath ? fromRelative(file, strings.relativePath) : '')
  return { target, args: strings.args ?? '', icon: expand(strings.icon || env[0xa0000007] || '') }
}

module.exports = { readLnk }
