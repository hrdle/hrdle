// What the ring does before a server address exists.
//
// Everything that normally handles a gesture — the controller's own wiring —
// sits below an await that only resolves once an address has been stored. So
// this is the whole of the app's input on the screen a wearer sees first, and
// on the demo they can step into from it.
//
// It lives in its own file because it shipped broken twice for the same
// reason: it is a seam nobody could test. v0.0.39 wired a way out and no way
// around; v0.0.40 wired a way into the demo and left the demo's own gestures
// going to a noop. Both are one-line faults in a block that was buried inside
// an async function, behind a branch that only runs on an unconfigured device.
// Here it is a plain function over four callbacks, and the tests can hold it.

/** The parts of the app this needs, so a test can supply them. */
export interface SetupGateDeps {
  /** Canned data, drawn by the real controller on the real screens. */
  startDemo(): void
  /** Ring, forwarded once the demo is up. */
  tap(): void
  doubleTap(): void
  swipeUp(): void
  swipeDown(): void
  /** The host's own exit confirmation. */
  requestExit(): void
  /**
   * Forget what is on the panel.
   *
   * The setup guide is drawn straight at the bridge, behind `updateDisplay`'s
   * back, so its record is wrong the moment the demo starts. Without this a
   * second visit would upgrade the guide's containers in place — same ids,
   * different geometry — and draw a list into a screen shaped like a
   * paragraph.
   */
  invalidatePanel(): void
  trace(message: string): void
}

export interface SetupGate {
  onTap(): void
  onDoubleTap(): void
  onSwipeUp(): void
  onSwipeDown(): void
  /** Whether the demo is up. For the caller's own bookkeeping and the tests. */
  inDemo(): boolean
}

export function createSetupGate(deps: SetupGateDeps): SetupGate {
  let inDemo = false
  return {
    inDemo: () => inDemo,
    onSwipeUp() {
      if (inDemo) deps.swipeUp()
    },
    onSwipeDown() {
      if (inDemo) deps.swipeDown()
    },
    onTap() {
      // A reviewer has no server and is not going to install one, so without
      // the demo the app they were asked to judge is a paragraph of
      // instructions. Once it is up the tap belongs to it.
      if (inDemo) {
        deps.tap()
        return
      }
      inDemo = true
      deps.trace('demo started from the setup guide')
      deps.invalidatePanel()
      deps.startDemo()
    },
    onDoubleTap() {
      // Inside the demo the controller owns this: it walks back out of a
      // conversation or a picker, and from the demo's own root it asks for the
      // exit dialogue — the same question a root asks anywhere.
      if (inDemo) {
        deps.doubleTap()
        return
      }
      deps.trace('exit dialogue requested (setup guide double-tap)')
      deps.requestExit()
    },
  }
}
