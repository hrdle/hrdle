// Browser debug simulator — runs when the Even Hub SDK is absent (vite dev,
// port 8391, /api + /ws/mux proxied to a dev backend).
//
// It consumes the SAME GlassesController as the real G2 path (single
// handler/domain implementation — no duplicated logic), so automated browser
// tests exercise the exact state machine and relay flow that runs on the
// glasses. Mic/STT are faked: the "STT result" textbox injects what the Groq
// transcription would have returned.

import { setBaseUrl } from './api.ts'
import { GlassesController } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import type { AppState } from './display.ts'
import { formatMessage, recapBlockLines } from './types.ts'
import type { Session } from './types.ts'

function sName(s: Session): string {
  return s.customTitle || s.name || s.id.slice(0, 8)
}

function isWaiting(s: Session): boolean {
  return s.indicatorState === 'waiting_input' || (!!s.waitingToolName && s.waitingToolName !== 'UserInput')
}

// ── Text rendering of the same render model (approximates the G2 layout) ──

function renderSim(state: AppState): string {
  const lines: string[] = []
  const session = state.sessions[state.sessionIndex]

  if (state.mode === 'session_list') {
    const badge = state.relayWaiting.length > 0 ? ` !${state.relayWaiting.length}` : ''
    lines.push(`Sessions ${state.apiUsagePercent ? `API:${state.apiUsagePercent}` : ''}${badge}`)
    lines.push('')
    const relayWaitingIds = new Set(state.relayWaiting.map((i) => i.sessionId))
    const start = Math.max(0, state.sessionIndex - 3)
    const visible = state.sessions.slice(start, start + 8)
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i]
      const idx = start + i
      const icon = relayWaitingIds.has(s.id) || isWaiting(s) ? '!' : s.indicatorState === 'processing' ? '*' : ' '
      const cursor = idx === state.sessionIndex ? '>' : ' '
      lines.push(`${cursor}${icon} ${sName(s)}`)
    }
    lines.push('', 'tap:open  swipe:nav  dbl:overlay')
  } else if (state.mode === 'conversation') {
    const ind = session?.indicatorState
    const status = session && isWaiting(session) ? ' !' : ind === 'processing' ? ' *' : ''
    lines.push(`${session ? sName(session) : '---'}${status}`, '-'.repeat(40))
    // Waiting/info banner at the TOP of the conversation tab (#504)
    const top = state.relayWaiting[0]
    if (top) {
      const label = state.sessions.find((x) => x.id === top.sessionId)
      lines.push(`[!]${label ? sName(label) : top.sessionId}${top.choices?.length ? `(選択${top.choices.length})` : ''}`)
      lines.push(top.text.slice(0, 120))
      lines.push('-'.repeat(40))
    } else if (state.relayInfo[0]) {
      const info = state.relayInfo[0]
      const label = state.sessions.find((x) => x.id === info.sessionId)
      lines.push(`[i]${label ? sName(label) : info.sessionId}: ${info.text.slice(0, 80)}`, '-'.repeat(40))
    }
    // Recap heads the latest view (mirrors display.ts conversationContent).
    if (state.conversationOffset === 0 && state.conversationPage === 0) {
      lines.push(...recapBlockLines(session?.ccRecap))
    }
    const msgs = state.conversation
    const msgIndex = msgs.length > 0 ? Math.max(0, msgs.length - 1 - state.conversationOffset) : -1
    if (msgIndex >= 0) {
      const chunkSize = 300
      const fullText = formatMessage(msgs[msgIndex])
      const totalPages = Math.max(1, Math.ceil(fullText.length / chunkSize))
      const page = Math.min(state.conversationPage, totalPages - 1)
      lines.push(fullText.slice(page * chunkSize, (page + 1) * chunkSize))
      const pos = `${msgIndex + 1}/${msgs.length}${totalPages > 1 ? ` p${page + 1}/${totalPages}` : ''}`
      lines.push('', `${top ? 'tap:対応  dbl:後で' : 'dbl:back'}  ${pos}`)
    } else {
      lines.push('(no messages)')
      lines.push('', top ? 'tap:対応  dbl:後で' : 'dbl:back')
    }
  } else if (state.mode === 'overlay') {
    const waiting = state.relayWaiting
    const item = waiting.find((i) => i.id === state.overlayItemId) || waiting[0]
    if (item) {
      const label = state.sessions.find((x) => x.id === item.sessionId)
      lines.push(`${label ? sName(label) : item.sessionId} [!] ${waiting.indexOf(item) + 1}/${waiting.length}`, '-'.repeat(40))
      lines.push(item.text)
      if (item.choices?.length) {
        lines.push('-'.repeat(24))
        for (let i = 0; i < item.choices.length; i++) lines.push(` ${i + 1}. ${item.choices[i]}`)
      }
      lines.push('', 'tap:open  dbl:dismiss  swipe:next')
    } else {
      lines.push('(no waiting items)', '', 'dbl:back')
    }
  } else if (state.mode === 'choice') {
    lines.push(`${state.choiceSessionName || (session ? sName(session) : '---')} [SELECT]`, 'Select response:', '')
    for (let i = 0; i < state.choiceOptions.length; i++) {
      lines.push(`${i === state.choiceIndex ? '>' : ' '} ${state.choiceOptions[i]}`)
    }
    lines.push('', 'swipe:select  tap:send  dbl:cancel')
  } else if (state.mode === 'voice') {
    const name = state.voiceSessionName || (session ? sName(session) : '---')
    if (state.voicePhase === 'recording') {
      lines.push(`${name}  [録音中]`, '', '● 録音中 (debug: STT欄に入力)', '', 'tap:停止して認識  dbl:キャンセル')
    } else if (state.voicePhase === 'transcribing') {
      lines.push(`${name}  [認識中]`, '', '認識中…')
    } else {
      lines.push(`${name}  [確認]`, '', state.voiceText || '(認識できませんでした)', '', state.voiceText ? 'tap:送信  dbl:キャンセル' : 'dbl:戻る')
    }
  }
  return lines.join('\n')
}

export function startDebugUI(): void {
  // Apply hub URL from query params
  const params = new URLSearchParams(location.search)
  const hubUrl = params.get('hub')
  if (hubUrl) setBaseUrl(hubUrl)

  const W = 576, H = 288, SCALE = 1.5
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <div style="font-family: monospace; padding: 20px; max-width: 900px; margin: auto;">
      <h2>CC Hub Glasses — Debug</h2>
      <div style="display:flex; gap:16px; align-items:start;">
        <div>
          <div id="g2sim" style="
            width:${W * SCALE}px; height:${H * SCALE}px;
            background:#000; color:#0f0; font-family:monospace;
            font-size:${12 * SCALE}px; line-height:${16 * SCALE}px;
            padding:8px; box-sizing:border-box; border:2px solid #0f0;
            border-radius:8px; white-space:pre-wrap; overflow:hidden;
          "></div>
          <div id="g2mode" style="color:#0f0; font-family:monospace; margin-top:4px; font-size:14px;"></div>
          <div id="g2relay" style="color:#0f0; font-family:monospace; margin-top:4px; font-size:14px;"></div>
        </div>
        <div>
          <p><b>Ring Controls:</b></p>
          <button onclick="window._dbg.swipeUp()">Swipe Up</button>
          <button onclick="window._dbg.swipeDown()">Swipe Down</button><br><br>
          <button onclick="window._dbg.tap()">Tap</button>
          <button onclick="window._dbg.doubleTap()">Double Tap</button>
          <p style="margin-top:16px;"><b>Voice (STT fake):</b></p>
          <input id="dbg-stt" type="text" placeholder="STT結果テキスト"
            style="width:220px; font-family:monospace; padding:4px;" />
          <p style="color:#888; font-size:12px;">voice モードで tap → この文字列が認識結果になる</p>
        </div>
      </div>
    </div>
  `

  const sim = document.getElementById('g2sim')!
  const modeLabel = document.getElementById('g2mode')!
  const relayLabel = document.getElementById('g2relay')!
  const sttInput = document.getElementById('dbg-stt') as HTMLInputElement

  const platform: GlassesPlatform = {
    render(state) {
      sim.textContent = renderSim(state)
      renderDiag(state)
    },
    startMicCapture: () => Promise.resolve(true),
    stopMicCapture: () => Promise.resolve(),
    // The textbox injects what Groq STT would have returned.
    transcribeAudio: () => Promise.resolve(sttInput.value.trim()),
  }

  const controller = new GlassesController(platform)
  controller.connect()

  function renderDiag(state: AppState): void {
    const ws = controller.ws
    const session = state.sessions[state.sessionIndex]
    const bufText = session ? ws.getTerminalText(session.id) : ''
    const choices = session ? ws.getChoices(session.id) : []
    modeLabel.textContent = `Mode: ${state.mode} | WS: ${ws.getState()} | Sub: ${ws.getSubscribed() || 'none'} | Buf: ${bufText.length}ch | Choices: [${choices.join(', ')}]`
    const top = state.relayWaiting[0]
    relayLabel.textContent =
      `Relay: waiting=${state.relayWaiting.length} info=${state.relayInfo.length}` +
      (top ? ` | top: [${top.kind}] ${top.sessionId}${top.paneId ?? ''} "${top.text.slice(0, 40)}"${top.choices?.length ? ` choices=${top.choices.length}` : ''}` : '') +
      (state.overlayItemId ? ` | overlay=${state.overlayItemId}` : '')
  }

  // Diag line also changes outside controller render events (terminal buffers,
  // WS state) — keep it fresh on an interval like the old simulator did.
  setInterval(() => renderDiag(controller.state), 500)

  ;(window as unknown as Record<string, unknown>)._ws = controller.ws
  ;(window as unknown as Record<string, unknown>)._dbg = {
    swipeUp: () => controller.swipeUp(),
    swipeDown: () => controller.swipeDown(),
    tap: () => controller.tap(),
    doubleTap: () => controller.doubleTap(),
  }
  ;(window as unknown as Record<string, unknown>)._controller = controller
}
