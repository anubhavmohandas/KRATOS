import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold, nextEvent, review, type RepEvent } from './review.ts'

test('events come from the counter’s own verdicts', () => {
  assert.deepEqual(nextEvent({ reps: 2, cue: 'Go' }, { reps: 3, cue: 'Good rep' }, 5), { t: 5, kind: 'good' })
  assert.deepEqual(nextEvent({ reps: 3, cue: 'Go' }, { reps: 3, cue: 'Not counted — too fast, control it' }, 6),
    { t: 6, kind: 'rejected', why: 'too fast, control it' })
  assert.equal(nextEvent({ reps: 3, cue: 'Not counted — x' }, { reps: 3, cue: 'Not counted — x' }, 7), null, 'a cue held over frames counts once')
  assert.equal(nextEvent({ reps: 3, cue: 'Go' }, { reps: 3, cue: 'Partial rep — use the full range' }, 8)?.kind, 'partial')
  assert.equal(nextEvent({ reps: 3, cue: 'Go' }, { reps: 3, cue: 'Now back up' }, 9), null)
})

test('a tracking blip doesn’t log a verdict twice', () => {
  const states = [
    { reps: 3, cue: 'Go', visible: true },
    { reps: 3, cue: 'Not counted — hips', visible: true },
    { reps: 3, cue: 'Step back so your whole body is in frame', visible: false },
    { reps: 3, cue: 'Not counted — hips', visible: true },
  ]
  let prev = { reps: 3, cue: '' }
  const events: RepEvent[] = []
  states.forEach((s, t) => {
    const [next, e] = fold(prev, s, t)
    prev = next
    if (e) events.push(e)
  })
  assert.deepEqual(events.map((e) => e.why), ['hips'])
})

const reps = (gaps: number[]): RepEvent[] => gaps.reduce<RepEvent[]>((out, g) => [...out, { t: (out.at(-1)?.t ?? 0) + g * 1000, kind: 'good' }], [{ t: 0, kind: 'good' }])

test('tempo: steady, slowing, speeding up', () => {
  assert.equal(review(reps([2, 2, 2, 2])).tempo, 'Steady tempo throughout.')
  assert.match(review(reps([2, 2, 3, 3.5])).tempo!, /slowed/)
  assert.match(review(reps([3, 3, 2, 1.8])).tempo!, /sped up/)
  assert.equal(review(reps([2, 2])).tempo, null, 'too few reps to call a trend')
  assert.equal(review(reps([2, 3])).secondsPerRep, 2.5)
})

test('rejected attempts are tallied by reason', () => {
  const r = review([...reps([2]), { t: 9, kind: 'rejected', why: 'hips' }, { t: 10, kind: 'rejected', why: 'hips' }, { t: 11, kind: 'partial', why: 'partial range of motion' }])
  assert.equal(r.counted, 2)
  assert.equal(r.rejected, 3)
  assert.deepEqual(r.reasons, [{ why: 'hips', n: 2 }, { why: 'partial range of motion', n: 1 }])
})
