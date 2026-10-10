import { test } from 'node:test'
import assert from 'node:assert/strict'
import { elapsedMs, fmt, pause, resume, start, total, view, type TimerCfg } from './logic.ts'

const tabata: TimerCfg = { kind: 'intervals', work: 20, rest: 10, rounds: 8, prepare: 10, label: 'Tabata' }
const at = (s: number) => view(tabata, s * 1000)

test('interval phases and rounds', () => {
  assert.deepEqual([at(0).phase, at(9.9).phase], ['prepare', 'prepare'])
  assert.deepEqual([at(10).phase, at(10).round], ['work', 1])
  assert.deepEqual([at(30).phase, at(30).round], ['rest', 1])
  assert.deepEqual([at(40).phase, at(40).round], ['work', 2])
  assert.equal(total(tabata), 240)
  assert.deepEqual([at(239.9).phase, at(239.9).round], ['work', 8]) // no rest after the last round
  assert.equal(at(240).phase, 'done')
  assert.equal(Math.round(at(35).remaining), 5000)
})

test('countdown and stopwatch', () => {
  const c: TimerCfg = { kind: 'countdown', seconds: 90, label: 'Rest' }
  assert.equal(view(c, 89_001).phase, 'work')
  assert.equal(view(c, 90_000).phase, 'done')
  assert.equal(view({ kind: 'stopwatch', label: '' }, 5000).remaining, Infinity)
})

test('pause excludes paused time; wall-clock based', () => {
  let r = start(tabata, 1000)
  r = pause(r, 6000) // 5 s in
  assert.equal(elapsedMs(r, 60_000), 5000) // frozen while paused
  r = resume(r, 60_000)
  assert.equal(elapsedMs(r, 62_000), 7000)
  assert.equal(pause(pause(r, 70_000), 80_000).pausedAt, 70_000) // double pause is a no-op
})

test('fmt rounds countdowns up', () => {
  assert.equal(fmt(89_001), '1:30')
  assert.equal(fmt(0), '0:00')
  assert.equal(fmt(61_999, false), '1:01')
})
