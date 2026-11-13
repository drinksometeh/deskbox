const fs = require('node:fs')
const path = require('node:path')

const EXTENSIONS = {
  程式: ['.lnk', '.url', '.exe', '.bat', '.cmd', '.msi'],
  文檔: ['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.json'],
  圖片: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.heic'],
  壓縮: ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso'],
}

function category(p) {
  if (fs.statSync(p).isDirectory()) return '目錄'
  const ext = path.extname(p).toLowerCase()
  return Object.keys(EXTENSIONS).find((k) => EXTENSIONS[k].includes(ext)) ?? '其它'
}

// Game shortcut = store launch URL (Steam/Epic/Ubisoft), something installed under a games/launcher folder, or an emulator.
// ponytail: keyword heuristic; a game installed somewhere else lands in the apps box until dragged over.
const GAME =
  /(steam:\/\/rungameid|com\.epicgames\.launcher:|uplay:)|\\(steam|steamapps|steamlibrary|epic games|ubisoft[^\\]*|games)\\|ryujinx|yuzu|citra|mgba|pcsx2|rpcs3|dolphin|cemu|--application-id/i
const isGameShortcut = (target) => GAME.test(target)

// Which tab a shortcut goes to, tested against "<shortcut name> <target> <args>"; first match wins, the rest are 'tools'.
// ponytail: keyword lists; an app nobody listed lands in 'tools' until dragged elsewhere.
const SHORTCUT_RULES = [
  ['tools', /wallpaper engine|rungameid\/431960/i], // a Steam app, but not a game
  ['platform', /\\steam\.exe|epicgameslauncher|ubisoftconnect|\\upc\.exe|battle\.net|eadesktop|galaxyclient|wemod|\\wand\.exe|cheat engine/i],
  ['game', GAME],
  ['dev', /\\code\.exe|cursor|github|gitextensions|git bash|docker|postman|filezilla|android studio|jetbrains|idea64|pycharm|webstorm|python|node\.js|terminal|ngrok|claude|pixel agents|xampp|hxd|notepad\+\+|kdiff/i],
  ['design', /photoshop|illustrator|premiere|after effects|blender|figma|rive|clipchamp|obs64|录屏|apowerrec/i],
  ['daily', /\\chrome\.exe|msedge|firefox|discord|messenger|whatsapp|telegram|unigram|slack|teams|spotify|grok|moomoo|outlook/i],
]
const shortcutKind = (text) => SHORTCUT_RULES.find(([, re]) => re.test(text))?.[0] ?? 'tools'

// First free name in dir: "a.txt", then "a (2).txt", "a (3).txt", ...
function freePath(dir, base) {
  const { name, ext } = path.parse(base)
  let p = path.join(dir, base)
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${name} (${i})${ext}`)
  return p
}

// Moves a file or folder into dir. Never overwrites, works across drives.
function moveInto(src, dir) {
  if (path.resolve(path.dirname(src)).toLowerCase() === path.resolve(dir).toLowerCase()) return src
  const dest = freePath(dir, path.basename(src))
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true })
    fs.rmSync(src, { recursive: true })
  }
  return dest
}

module.exports = { category, freePath, isGameShortcut, shortcutKind, moveInto }
