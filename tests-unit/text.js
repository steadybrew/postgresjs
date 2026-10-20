import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, text } from '../src/text.js'

const samples = Buffer.from([
  9, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0xEF, 0xBB, 0xBF, 0x61, 0xC3, 0xA9, 0xE2, 0x82, 0xAC,
  0xFF, 0xC3, 0x28, 0xF0, 0x9F, 0x98, 0x80, 0x7F, 0, 0x31, 0x2E, 0x35, 0x74
]).subarray(1)

const decodesLikeToString = (decode, name) => {
  for (let start = 0; start <= samples.length; start++) {
    for (let end = 0; end <= samples.length + 2; end++)
      assert.equal(decode(samples, start, end), samples.toString('utf8', start, end), `${ name } ${ start }..${ end }`)
  }
}

test('text and cell decode like Buffer#toString for every range, short ASCII, BOM and invalid bytes included', () => {
  decodesLikeToString(text, 'text')
  decodesLikeToString(cell, 'cell')
  assert.equal(text(samples, 3), samples.toString('utf8', 3))
})

test('text falls back to Buffer#toString where utf8Slice is missing', async() => {
  const utf8Slice = Buffer.prototype.utf8Slice
  delete Buffer.prototype.utf8Slice
  const fallback = await import('../src/text.js?without-utf8Slice').finally(() => Buffer.prototype.utf8Slice = utf8Slice)
  decodesLikeToString(fallback.text, 'fallback text')
  decodesLikeToString(fallback.cell, 'fallback cell')
})
