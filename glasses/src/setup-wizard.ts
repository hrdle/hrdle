// The setup wizard's steps and the rules for moving between them.
//
// Getting Hrdle running takes a machine, two other tools, a shell command that
// needs sudo, and a URL nobody has memorised. The phone screen used to present
// all of that as one scrolling page with the URL field already visible at the
// bottom, which invites someone who has installed nothing to type something into
// it and fail. One screen, one thing to do, is the whole idea.
//
// This file holds no DOM. `phone-ui.ts` renders the steps; what lives here is
// the order, the traversal and the parsing of a stored position — the parts that
// can be tested without a browser.

/**
 * One screen of the wizard.
 *
 * `done` is the end of the wizard rather than a tenth chore: it carries the
 * voice-input settings (which only work once a server answers) and the "launch
 * it from the glasses menu" sign-off.
 */
export type WizardStepId =
  | 'intro'
  | 'machine'
  | 'agent'
  | 'tailscale'
  | 'install'
  | 'connect'
  | 'done'

export interface WizardStep {
  id: WizardStepId
  /** Short name for the progress row. */
  label: string
  /**
   * Which device the work happens on.
   *
   * The wizard says this on every screen. Someone is holding the phone and
   * reading instructions for a computer across the room, and "copy this" is
   * ambiguous in exactly the way that wastes ten minutes.
   */
  where: 'phone' | 'pc'
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  { id: 'intro', label: 'What this is', where: 'phone' },
  { id: 'machine', label: 'A machine', where: 'pc' },
  { id: 'agent', label: 'Coding agent', where: 'pc' },
  { id: 'tailscale', label: 'Tailscale', where: 'pc' },
  { id: 'install', label: 'Install', where: 'pc' },
  { id: 'connect', label: 'Connect', where: 'phone' },
  { id: 'done', label: 'Glasses', where: 'phone' },
]

const FIRST_STEP: WizardStepId = 'intro'

/**
 * Steps that no longer exist, and where the people standing on them go.
 *
 * Without this a retired id would be unrecognised, and `parseStep` would drop
 * someone six screens into a setup back at the first one.
 */
const RETIRED_STEPS: Record<string, WizardStepId> = {
  // Putting the phone on the tailnet was its own screen, and nothing on it
  // could be checked: there is no way to see from a WebView whether Tailscale
  // is installed, and the only HTTPS host inside the tailnet worth reaching is
  // the server whose address the next screen asks for. Connecting is what
  // proves the tailnet works, so the two are one screen.
  phone: 'connect',
  // Starting the server was a screen because the installer stopped after
  // copying the binary. It registers the service itself now and prints the QR
  // code when it is done, so there is nothing left to ask for here.
  start: 'install',
}

/**
 * Where a successful connection lands you, wherever you were standing.
 *
 * A server that answers is proof that herdr, Tailscale and Hrdle are all
 * installed and running — there is nothing left for the earlier screens to ask
 * about, so they are all completed at once rather than walked through. This is
 * what lets someone who already knows the drill jump from the first screen to
 * the URL field, and someone returning to a working setup see no wizard at all.
 */
export const CONNECTED_STEP: WizardStepId = 'done'

/** The step where the URL is entered — the wizard's only real gate. */
export const CONNECT_STEP: WizardStepId = 'connect'

export const TOTAL_STEPS = WIZARD_STEPS.length

/** Zero-based position, or -1 for an id that is not a step. */
export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((step) => step.id === id)
}

export function stepAt(index: number): WizardStep {
  return WIZARD_STEPS[Math.min(Math.max(index, 0), WIZARD_STEPS.length - 1)]
}

export function stepById(id: WizardStepId): WizardStep {
  return stepAt(stepIndex(id))
}

/** The next screen. The last one stays put rather than falling off the end. */
export function nextStep(id: WizardStepId): WizardStepId {
  return stepAt(stepIndex(id) + 1).id
}

/** The previous screen. The first one stays put. */
export function prevStep(id: WizardStepId): WizardStepId {
  return stepAt(stepIndex(id) - 1).id
}

/** True when `a` is at or past `b` in the order. */
export function isAtOrAfter(a: WizardStepId, b: WizardStepId): boolean {
  return stepIndex(a) >= stepIndex(b)
}

/**
 * Read a stored position.
 *
 * Anything unrecognised starts over. A stored value that no longer names a step
 * is what a renamed or removed step leaves behind, and dropping the reader back
 * at the beginning of a nine-screen wizard is annoying; leaving them on a blank
 * screen with no way forward is worse.
 */
export function parseStep(value: string | null | undefined): WizardStepId {
  if (!value) return FIRST_STEP
  const trimmed = value.trim()
  if (WIZARD_STEPS.some((step) => step.id === trimmed)) return trimmed as WizardStepId
  return RETIRED_STEPS[trimmed] ?? FIRST_STEP
}
