// The replay player for the glasses screen-mirror recording (#127) — its own
// page (`?player`), reached from the simulator or bookmarked directly.
//
// It exists because the first player lived in the simulator's side panel, a
// whole screen away from the panel it was driving. Here the page is shaped
// like a video player: the screen large in the middle, the transport controls
// directly beneath it, nothing else competing for the eye.
//
// Drawing goes through the same painter the simulator uses (panel-paint.ts)
// and the same `wrapForPanel`, so a replayed frame wraps and clamps exactly as
// the wearer saw it.

import { getRecordingDay, getRecordingDays, setBaseUrl } from './api.ts'
import { wrapForPanel } from './display.ts'
import { createPanelPainter } from './panel-paint.ts'
import type { GlassesInputKind, GlassesScreen, RecordedGlassesLine } from './types.ts'

/** Real-time cap on one wait between frames. The recording is a transition
 *  log — a quiet hour is one line — and a demo should skim it, not sit
 *  through it. */
const MAX_WAIT_MS = 2500
/** Floor, so a burst of quick transitions stays watchable. */
const MIN_WAIT_MS = 120

const STYLE = `
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body { background: #0b0f0a; color: #d8ded6;
         font: 14px/1.6 -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
         min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
  .wrap { width: min(920px, 100%); padding: 18px 16px 32px; display: flex;
          flex-direction: column; gap: 12px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 16px; font-weight: 700; color: #9fb39a; }
  h1 a { color: inherit; text-decoration: none; }
  .day-row { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  select, button { font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 6px;
                   border: 1px solid #33402f; background: #1d251c; color: #d8ded6; cursor: pointer; }
  select { background: #0f140e; }
  button:hover { background: #263021; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #7cc98f; outline-offset: 2px; }

  .lens { position: relative; border-radius: 10px; overflow: hidden;
          background: #101410 center/cover no-repeat; aspect-ratio: 2 / 1;
          box-shadow: 0 8px 40px rgba(0,0,0,.5); }
  .lens::after { content: ''; position: absolute; inset: 0;
                 background: linear-gradient(180deg, rgba(4,8,6,.22), rgba(4,8,6,.30)); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; }

  .gesture { position: absolute; right: 14px; bottom: 12px; z-index: 2; padding: 4px 12px;
             border-radius: 999px; background: rgba(10,16,10,.78); border: 1px solid #3a5c3f;
             color: #6affa0; font-size: 15px; opacity: 0; transition: opacity .15s;
             pointer-events: none; }
  .gesture.show { opacity: 1; }

  .transport { display: flex; align-items: center; gap: 10px; }
  .transport button.play { min-width: 84px; }
  input[type=range] { flex: 1; accent-color: #6affa0; }
  .clock { font-family: ui-monospace, Menlo, monospace; font-size: 13px; color: #9fb39a;
           min-width: 11ch; text-align: right; }
  .status { font-size: 12px; color: #6b736a; min-height: 1.6em; }
  .keys { font-size: 11px; color: #4d554b; }
  kbd { border: 1px solid #33402f; border-radius: 4px; padding: 0 5px;
        font: 11px ui-monospace, Menlo, monospace; }
`

export function startPlayerUI(): void {
  const params = new URLSearchParams(location.search)
  const hubUrl = params.get('hub')
  if (hubUrl) setBaseUrl(hubUrl)

  document.title = `${__PRODUCT_NAME__} - glasses replay`
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  // Same default backdrop as the simulator: the G2 is a see-through display,
  // and frames replayed over a room read as what they are - a recording of
  // something worn, not a green terminal.
  const bgUrl = params.get('bg') ?? `${import.meta.env.BASE_URL}scene-meeting.jpg`
  const simHref = hubUrl ? `./?hub=${encodeURIComponent(hubUrl)}` : './'

  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <div class="wrap">
      <header>
        <h1>${__PRODUCT_NAME__} glasses replay</h1>
        <a href="${simHref}">simulator</a>
        <div class="day-row">
          <select id="day"></select>
          <button type="button" id="reload">Reload</button>
        </div>
      </header>
      <div class="lens" id="lens">
        <canvas id="screen" width="576" height="288"></canvas>
        <div class="gesture" id="gesture"></div>
      </div>
      <div class="transport">
        <button type="button" class="play" id="play" disabled>Play</button>
        <input type="range" id="seek" min="0" max="0" value="0" disabled />
        <span class="clock" id="clock">--:--:--</span>
        <select id="speed" title="Playback speed">
          <option value="1">1x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
          <option value="5">5x</option>
          <option value="20" selected>20x</option>
          <option value="60">60x</option>
        </select>
      </div>
      <div class="status" id="status">Loading recordings...</div>
      <div class="keys"><kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> step · <kbd>Home</kbd>/<kbd>End</kbd> jump</div>
    </div>
  `
  ;(document.getElementById('lens') as HTMLDivElement).style.backgroundImage = `url("${bgUrl}")`

  const canvas = document.getElementById('screen') as HTMLCanvasElement
  const daySel = document.getElementById('day') as HTMLSelectElement
  const reloadBtn = document.getElementById('reload') as HTMLButtonElement
  const playBtn = document.getElementById('play') as HTMLButtonElement
  const seek = document.getElementById('seek') as HTMLInputElement
  const clock = document.getElementById('clock') as HTMLSpanElement
  const speedSel = document.getElementById('speed') as HTMLSelectElement
  const status = document.getElementById('status') as HTMLDivElement

  const gesture = document.getElementById('gesture') as HTMLDivElement
  const painter = createPanelPainter(canvas)

  let lines: RecordedGlassesLine[] = []
  let index = 0
  let playing = false
  let timer: number | undefined

  /** Timeline position of a line — the server's arrival clock, falling back
   *  to the device's own stamp for recordings that predate `receivedAt`. A
   *  focus line orders by arrival only: its `at` is when the focus was
   *  claimed, which can predate the whole recording. */
  const timeOf = (line: RecordedGlassesLine): number => {
    if ('focus' in line) return line.receivedAt
    if ('gap' in line || 'input' in line) return line.at
    return line.receivedAt ?? line.at
  }

  /** A drawable screen, as opposed to the event lines (gap, gesture, focus). */
  const isFrame = (line: RecordedGlassesLine): line is GlassesScreen & { receivedAt: number } =>
    !('gap' in line) && !('input' in line) && !('focus' in line)

  const GESTURE_LABEL: Record<GlassesInputKind, string> = {
    tap: '● tap',
    doubleTap: '●● double tap',
    swipeUp: '↑ swipe up',
    swipeDown: '↓ swipe down',
  }

  let gestureTimer: number | undefined
  function flashGesture(kind: GlassesInputKind): void {
    gesture.textContent = GESTURE_LABEL[kind]
    gesture.classList.add('show')
    if (gestureTimer !== undefined) clearTimeout(gestureTimer)
    gestureTimer = window.setTimeout(() => gesture.classList.remove('show'), 900)
  }

  // Which line's frame is on the canvas, so a gesture line (which draws
  // nothing itself) only repaints when a seek landed it somewhere new.
  let drawnIndex = -1
  function drawFrameLine(line: GlassesScreen, i: number): void {
    drawnIndex = i
    painter.drawScreen({
      header: line.header,
      notice: line.notice ? wrapForPanel(line.notice) : undefined,
      body: wrapForPanel(line.body),
      footer: line.footer,
    })
  }

  function showFrame(i: number): void {
    const line = lines[i]
    if (!line) return
    index = i
    seek.value = String(i)
    clock.textContent = new Date(timeOf(line)).toLocaleTimeString()
    const pos = `frame ${i + 1}/${lines.length}`
    if ('gap' in line) {
      // An empty panel — what the live mirror's audience gets when the device
      // goes away.
      drawnIndex = -1
      painter.drawScreen({ header: '', body: '', footer: '' })
      status.textContent = `${pos} - device disconnected`
      return
    }
    if ('input' in line || 'focus' in line) {
      // An event line rides over whichever frame was on screen when it
      // happened; after a seek that frame has to be found and repainted.
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]
        if (!prev || 'gap' in prev) {
          if (drawnIndex !== -1) {
            drawnIndex = -1
            painter.drawScreen({ header: '', body: '', footer: '' })
          }
          break
        }
        if (isFrame(prev)) {
          if (drawnIndex !== j) drawFrameLine(prev, j)
          break
        }
      }
      if ('input' in line) {
        flashGesture(line.input)
        status.textContent = `${pos} - ${GESTURE_LABEL[line.input]}`
      } else {
        status.textContent = line.focus
          ? `${pos} - working in ${line.focus}${line.deviceType ? ` (${line.deviceType})` : ''}`
          : `${pos} - focus cleared`
      }
      return
    }
    drawFrameLine(line, i)
    const inSession = line.session?.name ?? line.session?.id
    status.textContent = `${pos} - ${line.mode}${inSession ? ` · ${inSession}` : ''}${playing ? '' : ' (paused)'}`
  }

  function pause(): void {
    playing = false
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    playBtn.textContent = 'Play'
  }

  function scheduleNext(): void {
    if (!playing) return
    const next = lines[index + 1]
    if (!next) {
      pause()
      status.textContent = `Finished (${lines.length} frames). Play starts over.`
      return
    }
    const cur = lines[index]
    const speed = Number(speedSel.value) || 1
    const recorded = cur ? (timeOf(next) - timeOf(cur)) / speed : 0
    const wait = Math.min(Math.max(recorded, MIN_WAIT_MS), MAX_WAIT_MS)
    timer = window.setTimeout(() => {
      showFrame(index + 1)
      scheduleNext()
    }, wait)
  }

  function play(): void {
    if (lines.length === 0) return
    playing = true
    playBtn.textContent = 'Pause'
    // Play after finishing starts over; play after pause resumes.
    if (index >= lines.length - 1) index = 0
    showFrame(index)
    scheduleNext()
  }

  async function loadDay(day: string): Promise<void> {
    pause()
    if (!day) return
    try {
      const res = await getRecordingDay(day)
      lines = res.lines
      seek.max = String(Math.max(lines.length - 1, 0))
      seek.disabled = lines.length === 0
      playBtn.disabled = lines.length === 0
      if (lines.length === 0) {
        status.textContent = `${day} is empty.`
        return
      }
      showFrame(0)
      status.textContent = `${lines.length} frames loaded from ${day}. Space plays.`
    } catch (err) {
      status.textContent = `Failed to load ${day}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async function loadDays(): Promise<void> {
    status.textContent = 'Loading recordings...'
    try {
      const { enabled, days } = await getRecordingDays()
      daySel.innerHTML = ''
      if (days.length === 0) {
        daySel.appendChild(new Option('(no recordings)', ''))
        playBtn.disabled = true
        seek.disabled = true
        status.textContent = enabled
          ? 'Recording is on; nothing captured yet.'
          : 'No recordings. Set HRDLE_GLASSES_RECORD=1 on the server to start capturing.'
        return
      }
      for (const d of days) {
        daySel.appendChild(new Option(`${d.day} (${(d.bytes / 1024).toFixed(1)} KB)`, d.day))
      }
      // Open on the newest day - the reason the page was opened.
      const newest = days[days.length - 1]
      if (newest) {
        daySel.value = newest.day
        await loadDay(newest.day)
      }
    } catch (err) {
      status.textContent = `Failed to list recordings: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  playBtn.addEventListener('click', () => {
    if (playing) {
      pause()
      showFrame(index)
    } else {
      play()
    }
  })

  daySel.addEventListener('change', () => void loadDay(daySel.value))
  reloadBtn.addEventListener('click', () => void loadDays())

  seek.addEventListener('input', () => {
    if (lines.length === 0) return
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    showFrame(Number(seek.value))
    if (playing) scheduleNext()
  })

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return
    if (e.target instanceof HTMLSelectElement) return
    if (lines.length === 0) return
    const step = (to: number) => {
      pause()
      showFrame(Math.min(Math.max(to, 0), lines.length - 1))
    }
    if (e.code === 'Space') {
      e.preventDefault()
      if (playing) {
        pause()
        showFrame(index)
      } else {
        play()
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      step(index - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      step(index + 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      step(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      step(lines.length - 1)
    }
  })

  void loadDays()
}
