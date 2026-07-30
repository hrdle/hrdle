import { describe, expect, test } from 'bun:test'
import {
  CONNECT_STEP,
  CONNECTED_STEP,
  TOTAL_STEPS,
  WIZARD_STEPS,
  isAtOrAfter,
  nextStep,
  parseStep,
  prevStep,
  stepById,
  stepIndex,
} from '../setup-wizard.ts'

describe('wizard order', () => {
  test('walking forward from the first step visits every step once', () => {
    const visited: string[] = ['intro']
    let current = 'intro' as const as ReturnType<typeof parseStep>
    for (let i = 0; i < TOTAL_STEPS * 2; i++) {
      const next = nextStep(current)
      if (next === current) break
      current = next
      visited.push(next)
    }
    expect(visited).toEqual(WIZARD_STEPS.map((s) => s.id))
    expect(new Set(visited).size).toBe(TOTAL_STEPS)
  })

  test('the last step stays put rather than falling off the end', () => {
    const last = WIZARD_STEPS[WIZARD_STEPS.length - 1].id
    expect(nextStep(last)).toBe(last)
  })

  test('the first step stays put when going back', () => {
    expect(prevStep('intro')).toBe('intro')
  })

  test('back undoes forward', () => {
    for (const step of WIZARD_STEPS.slice(0, -1)) {
      expect(prevStep(nextStep(step.id))).toBe(step.id)
    }
  })
})

describe('connecting completes everything before it', () => {
  // A server that answers proves herdr, Tailscale and Hrdle are all running, so
  // the screens that ask about them have nothing left to ask. If the connected
  // step were not the last one, connecting would skip real work.
  test('the connected step is the end of the wizard', () => {
    expect(CONNECTED_STEP).toBe(WIZARD_STEPS[WIZARD_STEPS.length - 1].id)
  })

  test('the gate sits immediately before it', () => {
    expect(nextStep(CONNECT_STEP)).toBe(CONNECTED_STEP)
  })

  test('landing on the connected step counts every earlier step as passed', () => {
    for (const step of WIZARD_STEPS) {
      expect(isAtOrAfter(CONNECTED_STEP, step.id)).toBe(true)
    }
  })

  test('a step before the gate has not passed it', () => {
    expect(isAtOrAfter('install', CONNECT_STEP)).toBe(false)
    expect(isAtOrAfter(CONNECT_STEP, CONNECT_STEP)).toBe(true)
  })
})

describe('restoring a stored position', () => {
  test('a stored step id comes back', () => {
    expect(parseStep('tailscale')).toBe('tailscale')
  })

  test('surrounding whitespace does not lose the position', () => {
    expect(parseStep(' install\n')).toBe('install')
  })

  // A value that no longer names a step is what a renamed or removed step leaves
  // in the store. Starting over is annoying; a blank screen with no way forward
  // is worse.
  test('an unknown id starts over rather than leaving a dead screen', () => {
    expect(parseStep('herdr')).toBe('intro')
    expect(parseStep('')).toBe('intro')
    expect(parseStep(null)).toBe('intro')
    expect(parseStep(undefined)).toBe('intro')
  })
})

describe('step metadata', () => {
  test('every step says which device the work happens on', () => {
    for (const step of WIZARD_STEPS) {
      expect(['phone', 'pc']).toContain(step.where)
      expect(step.label.length).toBeGreaterThan(0)
    }
  })

  test('the commands to type are all on the PC', () => {
    for (const id of ['agent', 'tailscale', 'install', 'start'] as const) {
      expect(stepById(id).where).toBe('pc')
    }
  })

  test('stepIndex agrees with the declared order', () => {
    WIZARD_STEPS.forEach((step, i) => {
      expect(stepIndex(step.id)).toBe(i)
    })
  })
})
