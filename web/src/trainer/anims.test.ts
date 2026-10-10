import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ANIMS } from './anims.ts'

// Trainer3D falls back to the squat for an unknown key, so a typo would silently show the wrong movement.
test('every catalog exercise has its own animation', () => {
  const catalog: { id: string; anim: string }[] = JSON.parse(readFileSync(new URL('../../../api/exercises.json', import.meta.url), 'utf8'))
  assert.deepEqual(catalog.filter((e) => !(e.anim in ANIMS)).map((e) => e.id), [])
})
