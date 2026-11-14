const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { category, isGameShortcut, shortcutKind, moveInto, writeAtomic, readJson } = require('./fsutil')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskbox-'))

test('a damaged settings file falls back to the last good copy', () => {
  const tmp = tmpDir()
  const file = path.join(tmp, 'boxes.json')
  assert.deepStrictEqual(readJson(file), {}) // first run

  writeAtomic(file, '{"n":1}')
  assert.deepStrictEqual(readJson(file), { data: { n: 1 } }) // and that read is now the backup
  writeAtomic(file, '{"n":2}')
  assert.ok(!fs.existsSync(`${file}.tmp`))

  fs.writeFileSync(file, '') // what a power cut mid-write used to leave
  assert.deepStrictEqual(readJson(file), { data: { n: 1 }, damaged: true })
  assert.strictEqual(fs.readFileSync(`${file}.broken`, 'utf8'), '') // kept for a look, out of the way
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"n":1}') // back in place, even if nothing saves before the next start

  fs.writeFileSync(file, '{')
  fs.writeFileSync(`${file}.bak`, '{')
  assert.deepStrictEqual(readJson(file), { damaged: true }) // nothing usable: start fresh
  fs.rmSync(tmp, { recursive: true })
})

test('moveInto never overwrites and leaves nothing behind', () => {
  const tmp = tmpDir()
  const from = path.join(tmp, 'from')
  const to = path.join(tmp, 'to')
  fs.mkdirSync(from)
  fs.mkdirSync(to)
  fs.writeFileSync(path.join(from, 'a.txt'), 'new')
  fs.writeFileSync(path.join(to, 'a.txt'), 'old')

  const dest = moveInto(path.join(from, 'a.txt'), to)

  assert.strictEqual(dest, path.join(to, 'a (2).txt'))
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'new')
  assert.strictEqual(fs.readFileSync(path.join(to, 'a.txt'), 'utf8'), 'old')
  assert.ok(!fs.existsSync(path.join(from, 'a.txt')))
  assert.strictEqual(moveInto(dest, to), dest) // already in place: no-op
  fs.rmSync(tmp, { recursive: true })
})

test('category sorts desktop items by type', () => {
  const tmp = tmpDir()
  fs.mkdirSync(path.join(tmp, 'folder'))
  const files = ['a.lnk', 'b.PDF', 'c.png', 'd.7z', 'e.xyz']
  for (const f of files) fs.writeFileSync(path.join(tmp, f), '')

  const kinds = ['folder', ...files].map((f) => category(path.join(tmp, f)))

  assert.deepStrictEqual(kinds, ['目錄', '程式', '文檔', '圖片', '壓縮', '其它'])
  fs.rmSync(tmp, { recursive: true })
})

test('isGameShortcut tells games from apps', () => {
  const games = [
    'steam://rungameid/1422450',
    'com.epicgames.launcher://apps/abc?action=launch&silent=true',
    'D:\\Program Files\\steam\\steam.exe ',
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftConnect.exe ',
    'D:\\Games\\STORY OF SEASONS Grand Bazaar\\SOSGrandBazaar.exe ',
    ' --application-id "01008f6008c5e000" "C:\\x\\Pokemon Violet.xci"',
  ]
  const apps = [
    'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe ',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe --app-id=efmjfjelnicpmdcmfikempdhlmainjcb',
    'C:\\Users\\me\\AppData\\Local\\WeMod\\Wand.exe ',
    'C:\\Program Files\\Cheat Engine 7.5\\Cheat Engine.exe ',
    ' ',
  ]
  assert.deepStrictEqual(games.filter((t) => !isGameShortcut(t)), [])
  assert.deepStrictEqual(apps.filter(isGameShortcut), [])
})

test('shortcutKind sorts shortcuts into tabs', () => {
  const cases = {
    'Deadlock steam://rungameid/1422450 ': 'game',
    'Steam D:\\Program Files\\steam\\Steam.exe ': 'platform',
    'Wand (WeMod) C:\\Users\\me\\AppData\\Local\\WeMod\\Wand.exe ': 'platform',
    'Wallpaper Engine steam://rungameid/431960 ': 'tools',
    'Visual Studio Code C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe ': 'dev',
    'Adobe Photoshop 2020 C:\\Program Files\\Adobe\\Adobe Photoshop 2020\\Photoshop.exe ': 'design',
    'Google Chrome C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --source-shortcut-location=desktop': 'daily',
    'Chrome Remote Desktop C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe --app-id=efm': 'tools',
    'WizTree C:\\Program Files\\WizTree\\WizTree64.exe ': 'tools',
  }
  for (const [text, kind] of Object.entries(cases)) assert.strictEqual(shortcutKind(text), kind, text)
})
