const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { readLnk } = require('./lnk')

test('readLnk reads target, arguments and icon of a Windows-made shortcut', () => {
  const lnk = readLnk(path.join(__dirname, 'test-fixtures', 'notepad.lnk'))
  assert.match(lnk.target, /\\Windows\\System32\\notepad\.exe$/i)
  assert.strictEqual(lnk.args, 'x.txt')
  assert.match(lnk.icon, /\\Windows\\System32\\shell32\.dll$/i)
})
