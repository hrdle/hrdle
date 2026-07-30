/**
 * How late the timers are, and when they started being late.
 *
 * Every exit with a measurable last heartbeat interval had a stretched one: a
 * run that beat at exactly 30.0s twenty times in a row produced one interval of
 * 53.7s and was then closed. The app was drawing successfully throughout, so a
 * `setInterval` arriving 24 seconds late is not this app blocking its own event
 * loop - it is the renderer not being scheduled, which points at the phone.
 *
 * A 30-second heartbeat cannot say more than that. It only notices lateness that
 * pushes a beat past the next 30-second boundary, and a run starved and then
 * killed inside one interval leaves no trace at all - which is a sampling bias,
 * not a gap in the data: the stretches on record are drawn from the runs that
 * outlived their late beat.
 *
 * A one-second tick sees sub-second lateness. That is the point of it: if the
 * starvation ramps, the small gaps show up before the fatal one and the record
 * has a predictor. If instead the tick runs clean to the last second before a
 * kill, the starvation account is wrong for that run. Either answer is worth
 * having, and neither is reachable at 30-second resolution.
 *
 * What it still cannot do is see the gap it dies inside. Lateness is only ever
 * measured after the fact - the tick has to fire to report that it fired late -
 * so a run killed mid-gap reports nothing, at any resolution. This narrows the
 * blind spot from 30 seconds to one; it does not remove it.
 *
 * Pure by design: the timer lives in the caller and the clock is a parameter, so
 * an episode can be replayed from synthetic timestamps in a test instead of by
 * waiting for a phone to starve.
 */

/** Lateness at or above this is an episode rather than jitter. */
export const DRIFT_THRESHOLD_MS = 500

/** How much worse an episode must get before it says so again. Without this a
 *  long episode would report every tick, and the log is the scarce resource. */
const RAMP_FACTOR = 1.5

/** Lines one episode may spend on getting worse. The start and the recovery are
 *  not counted against it - those are the two that always matter. */
const RAMP_LINES_MAX = 5

export class DriftMonitor {
  private readonly intervalMs: number
  private readonly thresholdMs: number
  /** When the next tick is due. Re-based on every tick, so what is measured is
   *  this tick's lateness rather than the accumulated total. */
  private expected: number
  private inEpisode = false
  private episodeStart = 0
  private episodeWorst = 0
  private episodeLateTicks = 0
  private rampLines = 0
  private worstEver = 0
  private lateTicksEver = 0

  constructor(startedAt: number, intervalMs = 1000, thresholdMs = DRIFT_THRESHOLD_MS) {
    this.intervalMs = intervalMs
    this.thresholdMs = thresholdMs
    this.expected = startedAt + intervalMs
  }

  /**
   * Feed the wall clock. Returns the lines worth logging, usually none.
   *
   * Rounded to whole milliseconds because nothing here is asking about
   * fractions of one, and a log line is read by a person.
   */
  tick(now: number): string[] {
    const late = Math.round(now - this.expected)
    this.expected = now + this.intervalMs

    if (late >= this.thresholdMs) {
      this.lateTicksEver++
      if (late > this.worstEver) this.worstEver = late
      if (!this.inEpisode) {
        this.inEpisode = true
        this.episodeStart = now
        this.episodeWorst = late
        this.episodeLateTicks = 1
        this.rampLines = 0
        return [`timer late: +${late}ms`]
      }
      this.episodeLateTicks++
      if (late > this.episodeWorst * RAMP_FACTOR && this.rampLines < RAMP_LINES_MAX) {
        this.episodeWorst = late
        this.rampLines++
        return [`timer late: +${late}ms (worse, ${this.episodeLateTicks} late ticks)`]
      }
      if (late > this.episodeWorst) this.episodeWorst = late
      return []
    }

    if (!this.inEpisode) return []
    this.inEpisode = false
    const heldMs = Math.round(now - this.episodeStart)
    return [
      `timer recovered: ${heldMs}ms episode, worst +${this.episodeWorst}ms, ${this.episodeLateTicks} late ticks`,
    ]
  }

  /**
   * The run's worst lateness, for the heartbeat to carry.
   *
   * Empty while nothing has been late, so a healthy heartbeat keeps the shape it
   * had before this existed. A run that dies with an episode open still leaves
   * its worst on the last beat that got out.
   */
  note(): string {
    if (!this.lateTicksEver) return ''
    return ` drift=+${this.worstEver}ms/${this.lateTicksEver}${this.inEpisode ? '/late-now' : ''}`
  }
}
