import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYouTube } from './youtube.ts'

const V = 'dQw4w9WgXcQ'
const L = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'

test('video links in every common shape', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${V}`, `https://youtu.be/${V}?si=abc`, `https://m.youtube.com/watch?v=${V}&t=42s`,
    `https://music.youtube.com/watch?v=${V}`, `https://www.youtube.com/shorts/${V}`, `https://www.youtube.com/embed/${V}`,
    `https://www.youtube.com/live/${V}`, V,
  ]) assert.deepEqual(parseYouTube(url), { video: V, list: undefined }, url)
})

test('playlists, and videos inside playlists', () => {
  assert.deepEqual(parseYouTube(`https://www.youtube.com/playlist?list=${L}`), { video: undefined, list: L })
  assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${V}&list=${L}&index=3`), { video: V, list: L })
  assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${V}&list=RD${V}`), { video: V, list: undefined }) // auto-mix ignored
})

test('rejects non-YouTube and malformed input', () => {
  for (const bad of ['https://evil.com/watch?v=' + V, 'https://youtube.com.evil.com/watch?v=' + V, 'https://www.youtube.com/watch?v=short', 'hello', 'javascript:alert(1)', ''])
    assert.equal(parseYouTube(bad), null, bad)
})
