// Timer lateness, replayed from synthetic timestamps.
//
// The thing being measured happens on a phone, minutes apart, and ends with the
// app being killed - so the logic is driven by a clock parameter instead, and
// these are the episodes it has to describe correctly.

import { describe, expect, test } from 'bun:test'
import { DriftMonitor } from '../drift.ts'

/** Feed a run of tick times, collecting everything the monitor said. */
function replay(startedAt: number, times: number[]) {
  const d = new DriftMonitor(startedAt)
  const lines: string[] = []
  for (const t of times) lines.push(...d.tick(t))
  return { lines, note: d.note() }
}

/** A tick every second, on time, for `n` seconds. */
function onTime(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + (i + 1) * 1000)
}

describe('drift monitor', () => {
  test('says nothing while the ticks are on time', () => {
    const { lines, note } = replay(0, onTime(0, 30))
    expect(lines).toEqual([])
    // The heartbeat keeps the shape it had before this existed.
    expect(note).toBe('')
  })

  test('ordinary jitter is not an episode', () => {
    // A few hundred milliseconds is a busy event loop, not a starved renderer.
    const { lines } = replay(0, [1000, 2120, 3210, 4300, 5150])
    expect(lines).toEqual([])
  })

  test('reports the moment lateness starts', () => {
    // The one line that has to be written before the app can die: a run killed
    // two seconds into an episode still leaves this behind.
    const { lines } = replay(0, [1000, 2000, 5400])
    expect(lines).toEqual(['timer late: +2400ms'])
  })

  test('measures each tick against the one before it, not the schedule', () => {
    // Re-basing is what stops one long gap from making every later tick look
    // late for the rest of the run.
    const { lines } = replay(0, [1000, 2000, 5000, 6000, 7000, 8000])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('timer late: +2000ms')
    expect(lines[1]).toContain('timer recovered')
  })

  test('says so when an episode gets materially worse', () => {
    const { lines } = replay(0, [1000, 2800, 6800])
    expect(lines).toEqual([
      'timer late: +800ms',
      'timer late: +3000ms (worse, 2 late ticks)',
    ])
  })

  test('a long episode does not fill the log', () => {
    // Every tick being late must not mean every tick writing a line - the log
    // is the scarce resource, and a starved renderer would flood it.
    const times = [1000]
    let t = 1000
    for (let i = 0; i < 200; i++) times.push((t += 1600))
    const { lines } = replay(0, times)
    expect(lines).toHaveLength(1)
  })

  test('a ramping episode is capped at five worsening lines', () => {
    const times = [1000]
    let t = 1000
    let gap = 300
    for (let i = 0; i < 20; i++) {
      gap = Math.round(gap * 2)
      times.push((t += 1000 + gap))
    }
    const { lines } = replay(0, times)
    // One start plus at most five worsening lines.
    expect(lines.length).toBeLessThanOrEqual(6)
    expect(lines[0]).toBe('timer late: +600ms')
    expect(lines.filter((l) => l.includes('worse'))).toHaveLength(5)
  })

  test('recovery reports how long it held and how bad it got', () => {
    const { lines } = replay(0, [1000, 3000, 5500, 6500, 7500])
    const recovered = lines.find((l) => l.startsWith('timer recovered'))
    expect(recovered).toBeDefined()
    expect(recovered).toContain('worst +1500ms')
    expect(recovered).toContain('2 late ticks')
    // Dated from the first late tick (3000) to the one that recovered (6500),
    // so the number is how long the app spent starved rather than the gap.
    expect(recovered).toContain('3500ms episode')
  })

  test('the heartbeat carries the worst of the run', () => {
    const { note } = replay(0, [1000, 2000, 4000, 5000, 6000])
    expect(note).toBe(' drift=+1000ms/1')
  })

  test('the heartbeat says when an episode is still open', () => {
    // A run killed mid-episode leaves this on the last beat that got out.
    const { note } = replay(0, [1000, 2000, 4000, 6000])
    expect(note).toContain('/late-now')
  })

  test('a second episode does not lose the first one\'s worst', () => {
    const { lines, note } = replay(0, [1000, 4000, 5000, 6000, 8000, 9000])
    expect(lines.filter((l) => l.startsWith('timer late')).length).toBe(2)
    expect(note).toBe(' drift=+2000ms/2')
  })
})
