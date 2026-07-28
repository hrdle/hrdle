import { describe, expect, test } from 'bun:test'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { sanitizeForG2, formatMessage } from '../types.ts'
import { screenText, wrapForPanel, wrapHeader } from '../display.ts'
import { BODY_WIDTH, HEADER_WIDTH, LIST_LINES, textWidth as width } from '../metrics.ts'
import { listRows, rowCursor, selectableRows } from '../display.ts'
import { NOTICE_DISMISS_MS } from '../controller.ts'
import { SPACE_W } from '../metrics.ts'
import { MAX_LINES } from '../metrics.ts'

describe('sanitizeForG2: tables', () => {
  const table = [
    '| 対象 | 版 |',
    '|---|---|',
    '| CC Hub 本体 | **v0.2.55**（本番更新済み） |',
    '| G2 グラスアプリ | `v0.1.32` |',
  ].join('\n')

  test('renders the cells instead of a meaningless [table] marker', () => {
    const out = sanitizeForG2(table)
    expect(out).not.toContain('[table]')
    expect(out).toContain('CC Hub 本体 | v0.2.55（本番更新済み）')
  })

  test('drops the |---|---| delimiter row', () => {
    expect(sanitizeForG2(table).split('\n')).toEqual([
      '対象 | 版',
      'CC Hub 本体 | v0.2.55（本番更新済み）',
      'G2 グラスアプリ | v0.1.32',
    ])
  })

  test('handles alignment markers and empty cells', () => {
    const out = sanitizeForG2('| a | b |\n|:--|--:|\n| 1 |  |')
    expect(out.split('\n')).toEqual(['a | b', '1'])
  })

  test('leaves prose containing a pipe alone', () => {
    expect(sanitizeForG2('grep foo | wc -l を実行')).toBe('grep foo | wc -l を実行')
  })
})

describe('wrapForPanel: line breaking', () => {
  test('never opens a line with a prohibited character (行頭禁則)', () => {
    const text =
      'その loadConversation が末尾でこうしていました。新着を取ってくるついでに、読んでいる人を毎回先頭へ戻していたわけです。'
    for (const line of wrapForPanel(text).split('\n')) {
      expect('。、）」！？…'.includes(line[0] ?? '')).toBe(false)
    }
  })

  test('never ends a line with a dangling opening bracket (行末禁則)', () => {
    const text = `${'あ'.repeat(27)}（補足です）そのあとに続く文章がここにあります`
    for (const line of wrapForPanel(text).split('\n')) {
      expect('（(「『'.includes(line.at(-1) ?? '')).toBe(false)
    }
  })

  test('keeps a short ASCII word whole', () => {
    const text = `${'あ'.repeat(26)}という理由で Beta に上げました`
    expect(wrapForPanel(text)).toContain('Beta')
    for (const line of wrapForPanel(text).split('\n')) {
      expect(line).not.toMatch(/(Bet|Be|B)$/)
    }
  })

  test('splits rather than leave a wide ragged margin', () => {
    // 14 characters of the identifier already sit on the line; carrying them
    // down would blank more than a quarter of it.
    const long = 'maybeRefreshConversation'
    const lines = wrapForPanel(`${'あ'.repeat(20)}${long}が動く`).split('\n')
    expect(lines.some((l) => l.includes(long))).toBe(false)
  })

  test('splits a word too long to ever fit on one line', () => {
    const url = `https://example.com/${'x'.repeat(80)}`
    const lines = wrapForPanel(`参照は ${url} です`).split('\n')
    // No blank columns bought anything — the URL was going to split regardless.
    expect(width(lines[0])).toBeGreaterThan(BODY_WIDTH - 40)
  })

  test('no line exceeds the panel width', () => {
    const text = sanitizeForG2(
      '会話を遡ると数秒で最新に戻る件は、**自動更新がスクロール位置を巻き添えにしていた**のが原因でした。\n\n| 対象 | 版 |\n|---|---|\n| CC Hub 本体 | v0.2.55 |',
    )
    for (const line of wrapForPanel(text).split('\n')) {
      expect(width(line)).toBeLessThanOrEqual(BODY_WIDTH)
    }
  })

  test('a space falling on the wrap point does not indent the next line', () => {
    // The gap between two words is where the break happened; carrying it down
    // showed up on the panel as an unexplained space mid-sentence.
    const text =
      'glasses ワークスペースは今までテストゼロだったので、bun test を入れて 13 件書きました。lint / test / typecheck / device・web 両ビルドとも通っています。'
    for (const line of wrapForPanel(text).split('\n')) {
      expect(line).not.toMatch(/^\s/)
      expect(line).not.toMatch(/\s$/)
    }
  })

  test('keeps indentation that came from a real newline', () => {
    expect(wrapForPanel('あ\n  いんでんと').split('\n')[1]).toBe('  いんでんと')
  })

  test('loses no characters while re-wrapping', () => {
    const text = 'あいうえお、かきくけこ。Beta と push のたびに（3 秒）動きます。'
    const strip = (s: string) => s.replace(/\s/g, '')
    expect(strip(wrapForPanel(text))).toBe(strip(text))
  })

  test('a single character wider than the line does not loop forever', () => {
    expect(wrapForPanel('あ'.repeat(200)).split('\n').length).toBeGreaterThan(1)
  })
})

describe('formatMessage', () => {
  test('carries a table through to the rendered message', () => {
    const out = formatMessage({
      role: 'assistant',
      content: 'まとめ\n\n| 対象 | 版 |\n|---|---|\n| 本体 | v0.2.55 |',
    })
    expect(out).toContain('本体 | v0.2.55')
    expect(out).not.toContain('[table]')
  })

  test('a multi-line command stays on one line', () => {
    const out = formatMessage({
      role: 'assistant',
      content: '',
      toolUse: [{ name: 'Bash', input: { command: "python3 - <<'EOF'\nimport re\np = 1\nEOF" } }],
    })
    expect(out.split('\n')).toHaveLength(1)
  })

  test('a clipped tool line fits the panel, prefix included', () => {
    // The ellipsis is part of the budget; one column over and the "clipped"
    // line wraps, leaving a two-character stub on a line of its own.
    for (const name of ['Bash', 'Read', 'NotebookEdit']) {
      const out = formatMessage({
        role: 'assistant',
        content: '',
        toolUse: [{ name, input: { command: 'x'.repeat(300), file_path: `/a/${'b'.repeat(300)}` } }],
      })
      expect(wrapForPanel(out).split('\n')).toHaveLength(1)
      expect(width(out)).toBeLessThanOrEqual(BODY_WIDTH)
    }
  })

  test('a clipped CJK tool line fits too', () => {
    const out = formatMessage({
      role: 'assistant',
      content: '',
      toolUse: [{ name: 'Bash', input: { description: 'あ'.repeat(80) } }],
    })
    expect(wrapForPanel(out).split('\n')).toHaveLength(1)
  })

  test('leaves a detail that already fits untouched', () => {
    const out = formatMessage({
      role: 'assistant',
      content: '',
      toolUse: [{ name: 'Bash', input: { description: 'テストを流す' } }],
    })
    expect(out).toBe('[Bash] テストを流す')
  })
})

describe('conversation body', () => {
  const longRecap =
    'beelink-arch の保守中。カーネル更新のため再起動を実施し、新カーネル 7.1.3 で正常復帰済み。以後の健康診断で報告された Swap 2.2GB 増は圧迫ではなく健全な cold ページ退避と判定、対応不要。次アクションは特にありません。'
  const state = (recap?: string) => ({
    mode: 'conversation' as const,
    sessions: [{ id: 'a', name: 'linux', state: 'idle' as const, ccRecap: recap }],
    sessionIndex: 0,
    conversation: Array.from({ length: 6 }, (_, i) => ({
      role: 'assistant' as const,
      content: `${i} 番目のメッセージです。${'ながい説明が続きます。'.repeat(3)}`,
    })),
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 6,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
  })

  test('a one-sentence recap is capped in display lines, not logical ones', () => {
    // It used to pass the cap untouched and then wrap to six rows, leaving one
    // line for the conversation it was meant to introduce.
    const body = screenText(state(longRecap)).body.split('\n')
    expect(body[0].startsWith('要約: ')).toBe(true)
    // Two recap lines, then the separator — the rest of the page is the
    // conversation.
    expect(body.indexOf('-'.repeat(24))).toBe(2)
    expect(body[1]).toEndWith('…')
  })

  test('the body never exceeds one page, recap or not', () => {
    for (const recap of [undefined, longRecap]) {
      const body = screenText(state(recap)).body
      expect(wrapForPanel(body).split('\n').length).toBeLessThanOrEqual(7)
    }
  })
})

/**
 * How far short of the edge the clock may sit.
 *
 * The gap is padded with 5px spaces, so up to one of them is unspendable, and
 * kerning across the join takes a pixel more. Sweeping every minute of the day
 * against several titles, the worst case is exactly 6 — which is why asserting
 * "less than 6" was a test that passed until the clock read 10:22.
 */
const SPACE_SLACK = SPACE_W + 2

describe('header clock', () => {
  const base = {
    sessions: [{ id: 'a', name: 'グラス開発', state: 'working' as const }],
    sessionIndex: 0,
    conversation: [{ role: 'assistant' as const, content: 'やあ' }],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 1,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: ['はい', 'いいえ'],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    voicePhase: 'recording' as const,
  }

  test('sits at the right edge on every screen', () => {
    // The list screen has no header; its clock rides in the footer, which is
    // the same bar geometry and the same right edge.
    expect(screenText({ ...base, mode: 'session_list' as const }).footer).toMatch(/ \d\d:\d\d$/)
    for (const mode of ['conversation', 'choice', 'voice', 'overlay'] as const) {
      const header = screenText({ ...base, mode }).header
      expect(header).toMatch(/ \d\d:\d\d$/)
      // The header container holds exactly one line — 28px of inner height
      // against a 27px line — so an overflow takes the clock off the panel.
      expect(width(header)).toBeLessThanOrEqual(HEADER_WIDTH)
      expect(wrapHeader(header).split('\n')).toHaveLength(1)
    }
  })

  test('a long title is clipped rather than pushing the clock off', () => {
    const header = screenText({
      ...base,
      mode: 'conversation' as const,
      sessions: [{ id: 'a', name: 'と'.repeat(60), state: 'working' as const }],
    }).header
    expect(header).toMatch(/ \d\d:\d\d$/)
    expect(width(header)).toBeLessThanOrEqual(HEADER_WIDTH)
  })

  test('leaves at least one space between title and clock', () => {
    const header = screenText({ ...base, mode: 'conversation' as const }).header
    expect(header).toMatch(/[^ ] +\d\d:\d\d$/)
  })

  test('actually reaches the right edge', () => {
    // A space is 5px on this panel. Padding it out as if it were a 10.69px
    // column left the clock near the middle — 293px into a 568px header.
    for (const name of ['linux', 'グラス開発', 'cchub-work-1']) {
      const header = screenText({
        ...base,
        mode: 'conversation' as const,
        sessions: [{ id: 'a', name, state: 'working' as const }],
      }).header
      expect(HEADER_WIDTH - width(header)).toBeLessThanOrEqual(SPACE_SLACK)
    }
  })
})

describe('session list', () => {
  const state = {
    mode: 'session_list' as const,
    sessions: [
      { id: 'a', name: 'グラス開発', state: 'working' as const, indicatorState: 'waiting_input' as const },
      { id: 'b', name: '2脚ロボ開発', state: 'idle' as const, indicatorState: 'completed' as const },
      { id: 'c', name: 'life', state: 'idle' as const, indicatorState: 'processing' as const },
    ],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
  }

  test('every name starts in the same column whether or not it has a badge', () => {
    // The blank badge is a full-width space — the same 320 units as a spinner
    // frame — so a row with nothing to say lines up with one that has.
    const starts = screenText(state)
      .body.split('\n')
      .map((l) => l.search(/[^ >\u3000▲▶▼◀]/))
    expect(new Set(starts).size).toBe(1)
  })
})

describe('paging', () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i} 行目の内容がここに入ります。`).join('\n')
  const state = (page: number) => ({
    mode: 'conversation' as const,
    sessions: [{ id: 'a', name: 'x', state: 'idle' as const }],
    sessionIndex: 0,
    conversation: [{ role: 'assistant' as const, content: long }],
    conversationOffset: 0,
    conversationPage: page,
    conversationLastLoaded: 1,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
  })

  const pageCount = () => {
    const m = screenText(state(0)).footer.match(/p\d+\/(\d+)/)
    return m ? Number(m[1]) : 1
  }

  test('pages tile: no line is shown twice', () => {
    const seen: string[] = []
    for (let p = 0; p < pageCount(); p++) seen.push(...screenText(state(p)).body.split('\n'))
    const meaningful = seen.filter((l) => l.trim())
    expect(new Set(meaningful).size).toBe(meaningful.length)
  })

  test('pages leave no gap', () => {
    const shown = new Set<string>()
    for (let p = 0; p < pageCount(); p++)
      for (const l of screenText(state(p)).body.split('\n')) if (l.trim()) shown.add(l)
    for (let i = 0; i < 40; i++) expect([...shown].some((l) => l.startsWith(`${i} 行目`) || l.includes(`${i} 行目`))).toBe(true)
  })

  test('paging forward and back returns to the same page', () => {
    const total = pageCount()
    expect(screenText(state(0)).body).toBe(screenText(state(0)).body)
    expect(screenText(state(total - 1)).body).not.toBe(screenText(state(0)).body)
  })
})

describe('glyph coverage', () => {
  test('rewrites a status emoji the panel renders as tofu', () => {
    // pretext measures ✅ at 320px from an emoji font the device does not
    // have, so measuring alone would have let it through.
    expect(sanitizeForG2('- ✅ health-check.sh を修正')).toBe('- ○ health-check.sh を修正')
  })

  test('rewrites marks the firmware fonts do not carry', () => {
    expect(sanitizeForG2('結果: ✓ OK / ✗ NG / ❓ 不明')).toBe('結果: ○ OK / × NG / ？ 不明')
    expect(sanitizeForG2('⚠️ 注意 ⭐ 重要 💡 ヒント ➡️ 次へ')).toBe('！ 注意 ★ 重要 ※ ヒント → 次へ')
  })

  test('keeps the three states of a status light apart', () => {
    expect(sanitizeForG2('🟢 稼働 🟡 警告 🔴 停止')).toBe('○ 稼働 △ 警告 × 停止')
  })

  test('drops decoration, which has nothing to become', () => {
    expect(sanitizeForG2('🎉 完了 🚀 デプロイ')).toBe('完了 デプロイ')
  })

  test('keeps the symbols the panel can actually draw', () => {
    const line = '★ 重要 ● 項目 → 次へ ※ 注記 ① ▲ ◆'
    expect(sanitizeForG2(line)).toBe(line)
  })

  test('leaves ordinary text untouched', () => {
    const line = '絵文字なしの普通の行です。'
    expect(sanitizeForG2(line)).toBe(line)
  })

  test('keeps line structure', () => {
    expect(sanitizeForG2('✅ 一行目\n🎉 二行目').split('\n')).toEqual(['○ 一行目', '二行目'])
  })

  test('a line that lost a glyph never leaves a double space', () => {
    expect(sanitizeForG2('前 🎉 後')).not.toMatch(/ {2}/)
  })
})

describe('recap lifetime', () => {
  const RECAP = 'beelink-arch の保守中。カーネル更新のため再起動を実施し正常復帰済み。'
  const state = (recapAt?: string, newestAt?: string) => ({
    mode: 'conversation' as const,
    sessions: [{ id: 'a', name: 'linux', state: 'idle' as const, ccRecap: RECAP, ccRecapAt: recapAt }],
    sessionIndex: 0,
    conversation: [
      { role: 'assistant' as const, content: '古いメッセージ', timestamp: '2026-07-27T04:00:00.000Z' },
      { role: 'assistant' as const, content: '最新のメッセージ', timestamp: newestAt },
    ],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 2,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
  })
  const hasRecap = (st: ReturnType<typeof state>) => screenText(st).body.startsWith('要約: ')

  test('shows while nothing newer has arrived', () => {
    expect(hasRecap(state('2026-07-27T06:00:00.000Z', '2026-07-27T05:00:00.000Z'))).toBe(true)
  })

  test('goes once the conversation moves past it', () => {
    // Three of seven lines are better spent on the conversation than on a
    // description of what came before it.
    expect(hasRecap(state('2026-07-27T04:48:00.000Z', '2026-07-27T05:30:00.000Z'))).toBe(false)
  })

  test('a message written at the same moment does not count as past it', () => {
    const at = '2026-07-27T05:00:00.000Z'
    expect(hasRecap(state(at, at))).toBe(true)
  })

  test('keeps showing when there is no timestamp to judge by', () => {
    expect(hasRecap(state(undefined, '2026-07-27T05:00:00.000Z'))).toBe(true)
    expect(hasRecap(state('2026-07-27T04:00:00.000Z', undefined))).toBe(true)
  })

  test('keeps showing when a timestamp will not parse', () => {
    expect(hasRecap(state('not a date', '2026-07-27T05:00:00.000Z'))).toBe(true)
  })
})

describe('turn prefixes', () => {
  test('the user turn is marked like a shell prompt', () => {
    expect(formatMessage({ role: 'user', content: 'リリースお願いします' })).toBe('$ リリースお願いします')
  })

  test('the agent turn carries no prefix', () => {
    // The turn that is not marked is the answer to the one that is; an `A>` in
    // front of every reply spends columns on something already visible.
    expect(formatMessage({ role: 'assistant', content: '進めます' })).toBe('進めます')
  })

  test('the reclaimed columns go to the tool detail', () => {
    const out = formatMessage({
      role: 'assistant',
      content: '',
      toolUse: [{ name: 'Bash', input: { command: 'x'.repeat(300) } }],
    })
    expect(width(out)).toBeLessThanOrEqual(BODY_WIDTH)
    expect(width(out)).toBeGreaterThan(BODY_WIDTH - 24)
  })
})

describe('working indicator', () => {
  const st = (tick: number, indicatorState: 'processing' | 'waiting_input' | 'completed') => ({
    mode: 'conversation' as const,
    sessions: [{ id: 'a', name: 'グラス開発', state: 'working' as const, indicatorState }],
    sessionIndex: 0,
    conversation: [{ role: 'assistant' as const, content: '作業中' }],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 1,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    spinnerTick: tick,
  })
  const mark = (tick: number) => screenText(st(tick, 'processing')).header.replace(/^グラス開発\s+|\s+\d\d:\d\d$/g, '')

  test('moves while the session is working', () => {
    const frames = [0, 1, 2, 3].map(mark)
    expect(new Set(frames).size).toBe(4)
  })

  test('comes back round', () => {
    expect(mark(4)).toBe(mark(0))
  })

  test('every frame is the same width, so nothing after it shifts', () => {
    // An uneven set reads as a shiver rather than a rotation.
    const widths = [0, 1, 2, 3].map((t) => width(mark(t)))
    expect(new Set(widths).size).toBe(1)
  })

  test('the header still fits at every frame', () => {
    for (const t of [0, 1, 2, 3]) {
      expect(width(screenText(st(t, 'processing')).header)).toBeLessThanOrEqual(HEADER_WIDTH)
    }
  })

  test('other states do not animate', () => {
    const waiting = [0, 1, 2].map((t) => screenText(st(t, 'waiting_input')).header)
    expect(new Set(waiting.map((h) => h.replace(/\d\d:\d\d/, ''))).size).toBe(1)
    expect(waiting[0]).toContain('[!] WAITING')
    expect(screenText(st(1, 'completed')).header).not.toContain('[!]')
  })
})

describe('back label', () => {
  const st = (offset: number, page: number) => ({
    mode: 'conversation' as const,
    sessions: [{ id: 'a', name: 'グラス開発', state: 'idle' as const }],
    sessionIndex: 0,
    conversation: [
      { role: 'user' as const, content: '質問' },
      { role: 'assistant' as const, content: Array.from({ length: 20 }, (_, i) => `${i} 行目`).join('\n') },
    ],
    conversationOffset: offset,
    conversationPage: page,
    conversationLastLoaded: 2,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
  })

  test('leaves the session from the newest message', () => {
    expect(screenText(st(0, 0)).footer).toContain('dbl:back')
  })

  test('returns to the top once the reader has paged', () => {
    expect(screenText(st(0, 1)).footer).toContain('dbl:top')
  })

  test('returns to the top once the reader has gone back a message', () => {
    expect(screenText(st(1, 0)).footer).toContain('dbl:top')
  })
})

describe('fenced code', () => {
  test('shows a short block instead of a marker', () => {
    // `[code]` said only that something was there, and took the content a
    // sentence had just promised.
    const out = sanitizeForG2('フッターの表示です。\n\n```\n最新    dbl:back\nページ2  dbl:top\n```')
    expect(out.split('\n')).toEqual(['フッターの表示です。', '最新    dbl:back', 'ページ2  dbl:top'])
  })

  test('drops the shared indentation so more of it fits', () => {
    expect(sanitizeForG2('```ts\n    const a = 1\n      const b = 2\n```').split('\n'))
      .toEqual(['const a = 1', '  const b = 2'])
  })

  test('summarises a block whose lines will not fit', () => {
    const wide = 'x'.repeat(200)
    expect(sanitizeForG2(`\`\`\`\n${wide}\n\`\`\``)).toBe('[code 1行]')
  })

  test('summarises a block long enough to become the page', () => {
    const many = Array.from({ length: 6 }, (_, i) => `${i}行目`).join('\n')
    expect(sanitizeForG2(`\`\`\`\n${many}\n\`\`\``)).toBe('[code 6行]')
  })

  test('an unterminated fence is still rendered', () => {
    expect(sanitizeForG2('```\nbun run test')).toBe('bun run test')
  })

  test('an empty block leaves nothing behind', () => {
    expect(sanitizeForG2('前\n```\n\n```\n後').split('\n')).toEqual(['前', '後'])
  })
})

describe('workspace and pane list', () => {
  const panes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      paneId: `%${i + 1}`,
      currentPath: '/home/m0a/repos/wheel-leg-bot',
      agentSessionId: `agent-${i}`,
      indicatorState: 'waiting_input' as const,
      metrics: { contextPercent: 30 - i * 15 },
    }))
  const sessions = [
    { id: 'a', name: 'グラス開発', state: 'working' as const, panes: panes(1) },
    { id: 'b', name: '2脚ロボ開発', state: 'idle' as const, panes: panes(2) },
    { id: 'c', name: 'life', state: 'idle' as const },
  ]
  const st = (sessionIndex: number, selectedPaneId?: string) => ({
    mode: 'session_list' as const,
    sessions,
    sessionIndex,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    selectedPaneId,
  })

  test('a workspace with one pane is not expanded', () => {
    // `%1` under a name it already carries is hierarchy that says nothing.
    expect(listRows(sessions).filter((r) => r.sessionIndex === 0)).toEqual([{ sessionIndex: 0 }])
  })

  test('a workspace with two panes lists them under a heading', () => {
    expect(listRows(sessions).filter((r) => r.sessionIndex === 1)).toEqual([
      { sessionIndex: 1, header: true },
      { sessionIndex: 1, paneId: '%1' },
      { sessionIndex: 1, paneId: '%2' },
    ])
  })

  test('the heading is not a place the cursor can be', () => {
    // Its own row would open the representative pane the server picked — one
    // of them, arbitrarily, which is the ambiguity the pane rows remove.
    expect(selectableRows(sessions).some((r) => r.sessionIndex === 1 && !r.paneId)).toBe(false)
  })

  test('a heading carries no cursor marker', () => {
    const line = screenText(st(1, '%1')).body.split('\n')[1]
    expect(line.startsWith('>')).toBe(false)
    expect(line).toContain('2脚ロボ開発')
  })

  test('the cursor walks workspaces and panes with one gesture', () => {
    expect(rowCursor(st(1, '%2'))).toBe(3)
    // A workspace with panes resolves to its first one, never to the heading.
    expect(listRows(sessions)[rowCursor(st(1))].paneId).toBe('%1')
  })

  test('panes are drawn as a tree under their workspace', () => {
    const body = screenText(st(1)).body.split('\n')
    expect(body[2]).toContain('├ %1')
    expect(body[3]).toContain('└ %2')
  })

  test('the list gets the row the header used to occupy', () => {
    expect(LIST_LINES).toBe(MAX_LINES + 1)
  })

  test('the footer carries the position and the clock', () => {
    const footer = screenText(st(1)).footer
    // Four selectable rows: the single-pane workspace, two panes, and the
    // workspace with none. The heading is not among them.
    expect(footer).toMatch(/2\/4/)
    expect(footer).toMatch(/ \d\d:\d\d$/)
    expect(width(footer)).toBeLessThanOrEqual(HEADER_WIDTH)
  })

  test('the list screen has no header', () => {
    expect(screenText(st(0)).header).toBe('')
  })

  test('a pane row drops the directory its siblings share', () => {
    // Two panes of one repo repeat the same folder name; the second one
    // teaches the reader nothing.
    const body = screenText(st(1)).body
    expect(body).toContain('├ %1  30%')
    expect(body).not.toContain('wheel-leg-bot')
  })

  test('the conversation header names the pane being read', () => {
    const header = screenText({ ...st(1, '%2'), mode: 'conversation' as const }).header
    expect(header).toContain('2脚ロボ開発 %2')
  })
})

describe('panes across tabs', () => {
  const sessions = [
    {
      id: 'a',
      name: '2脚ロボ開発',
      state: 'idle' as const,
      activeTabId: 'w4H:t1',
      panes: [
        { paneId: '%1', tabId: 'w4H:t1', metrics: { contextPercent: 31 } },
        { paneId: '%4', tabId: 'w4H:t2', metrics: { contextPercent: 6 } },
      ],
    },
  ]
  const st = {
    mode: 'session_list' as const,
    sessions,
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
  }

  test('a pane in another tab looks like any other', () => {
    // It was marked while a reply to it could not land. The server switches
    // tabs to deliver now, so the tab is a fact with no decision attached.
    const body = screenText(st).body
    expect(body).toContain('%1  31%')
    expect(body).toContain('%4  6%')
    expect(body).not.toContain('別タブ')
  })
})

describe('list badge', () => {
  const mk = (indicatorState?: 'processing' | 'waiting_input') => ({
    mode: 'session_list' as const,
    sessions: [{ id: 'a', name: 'グラス開発', state: 'working' as const, indicatorState }],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    spinnerTick: 0,
  })

  test('a working row turns', () => {
    expect(screenText({ ...mk('processing'), spinnerTick: 0 }).body).toContain('▲')
    expect(screenText({ ...mk('processing'), spinnerTick: 1 }).body).toContain('▶')
  })

  test('waiting is no longer marked', () => {
    // Seven of eight rows carried `[!]` on a real machine — a mark almost
    // everything has stops distinguishing anything.
    const body = screenText(mk('waiting_input')).body
    expect(body).not.toContain('[!]')
    expect(body).not.toContain('▲')
  })

  test('an unmarked row is padded to a badge width', () => {
    expect(screenText(mk()).body).toContain('\u3000 グラス開発')
  })

  test('a relay item still marks its workspace', () => {
    const withRelay = {
      ...mk(),
      relayWaiting: [
        { id: 'r', sessionId: 'a', kind: 'waiting' as const, text: 'x', source: 'auto' as const, createdAt: 1 },
      ],
    }
    expect(screenText(withRelay).body).toContain('！ グラス開発')
  })
})

describe('lifecycle events', () => {
  test('the host reports every reason it stops us', () => {
    // Whether the app was backgrounded or killed is the question a whole day
    // of guessing could not settle from inside the page.
    expect(OsEventTypeList.FOREGROUND_ENTER_EVENT).toBe(4)
    expect(OsEventTypeList.FOREGROUND_EXIT_EVENT).toBe(5)
    expect(OsEventTypeList.ABNORMAL_EXIT_EVENT).toBe(6)
    expect(OsEventTypeList.SYSTEM_EXIT_EVENT).toBe(7)
  })

  test('lifecycle codes do not collide with ring gestures', () => {
    // They are dispatched before the gesture debounce; sharing a value with a
    // gesture would make a resume look like a tap.
    const gestures = [
      OsEventTypeList.CLICK_EVENT,
      OsEventTypeList.DOUBLE_CLICK_EVENT,
      OsEventTypeList.SCROLL_TOP_EVENT,
      OsEventTypeList.SCROLL_BOTTOM_EVENT,
    ]
    const lifecycle = [
      OsEventTypeList.FOREGROUND_ENTER_EVENT,
      OsEventTypeList.FOREGROUND_EXIT_EVENT,
      OsEventTypeList.ABNORMAL_EXIT_EVENT,
      OsEventTypeList.SYSTEM_EXIT_EVENT,
    ]
    expect(gestures.some((g) => lifecycle.includes(g))).toBe(false)
  })
})

describe('notification banner on the list', () => {
  const info = (sessionId: string, text: string, createdAt = 1) => ({
    id: `i-${sessionId}-${createdAt}`,
    sessionId,
    kind: 'info' as const,
    text,
    source: 'auto' as const,
    createdAt,
  })

  const mk = (relayInfo: ReturnType<typeof info>[], sessionCount = 1) => ({
    mode: 'session_list' as const,
    sessions: Array.from({ length: sessionCount }, (_, i) => ({
      id: i === 0 ? 'a' : `s${i}`,
      name: i === 0 ? 'グラス開発' : `ws${i}`,
      state: 'working' as const,
    })),
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo,
    overlayItemId: null,
    spinnerTick: 0,
  })

  test('nothing to report costs the list no line', () => {
    const body = screenText(mk([])).body
    expect(body.split('\n')[0]).toContain('グラス開発')
  })

  test('a notification heads the list, named by its workspace', () => {
    const body = screenText(mk([info('a', '応答が完了しました')])).body.split('\n')
    expect(body[0]).toBe('[i]グラス開発: 応答が完了しました')
    // The list itself is still there, one row lower.
    expect(body[1]).toContain('グラス開発')
  })

  test('an unknown workspace falls back to its id rather than vanishing', () => {
    const body = screenText(mk([info('gone', '応答が完了しました')])).body
    expect(body.split('\n')[0]).toBe('[i]gone: 応答が完了しました')
  })

  test('the count of the others survives even when the text is cut', () => {
    const long = 'あ'.repeat(120)
    const banner = screenText(mk([info('a', long, 2), info('s1', long, 1)], 2)).body.split('\n')[0]
    expect(banner.startsWith('[i]グラス開発+1: ')).toBe(true)
  })

  test('the banner takes its line from the list, never from the panel', () => {
    const many = mk([], 12)
    const rowsWithout = screenText(many).body.split('\n').length
    const rowsWith = screenText({ ...many, relayInfo: [info('a', 'x')] }).body.split('\n').length
    expect(rowsWithout).toBe(LIST_LINES)
    expect(rowsWith).toBe(LIST_LINES)
  })

  test('the cursor row stays on screen with the banner present', () => {
    const many = { ...mk([info('a', 'x')], 12), sessionIndex: 11 }
    const body = screenText(many).body.split('\n')
    expect(body.some((l) => l.startsWith('>'))).toBe(true)
  })
})

describe('notice dialog (overlay)', () => {
  const relayItem = (kind: 'waiting' | 'info', id: string, text: string, extra = {}) => ({
    id, sessionId: 'a', kind, text, source: 'auto' as const, createdAt: 1, ...extra,
  })

  const mk = (over: Record<string, unknown>) => ({
    mode: 'overlay' as const,
    sessions: [{ id: 'a', name: 'グラス開発', state: 'working' as const }],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    spinnerTick: 0,
    ...over,
  })

  test('a notification fills the panel, marked [i] and named by its workspace', () => {
    const s = screenText(mk({
      relayInfo: [relayItem('info', 'i1', '応答が完了しました')],
      overlayItemId: 'i1',
    }))
    expect(s.header).toContain('グラス開発')
    expect(s.header).toContain('[i]')
    expect(s.body).toContain('応答が完了しました')
  })

  test('closing a notification is not answering it', () => {
    // "後で" is a reply to a question. A notification asked nothing.
    const s = screenText(mk({
      relayInfo: [relayItem('info', 'i1', '応答が完了しました')],
      overlayItemId: 'i1',
    }))
    expect(s.footer).toContain('dbl:閉じる')
    expect(s.footer).not.toContain('後で')
  })

  test('a question keeps its own wording and mark', () => {
    const s = screenText(mk({
      relayWaiting: [relayItem('waiting', 'w1', 'Which approach?', { choices: ['A', 'B'] })],
      overlayItemId: 'w1',
    }))
    expect(s.header).toContain('[!]')
    expect(s.footer).toContain('dbl:後で')
    expect(s.footer).toContain('tap:選択へ')
  })

  test('a queue of one drops the counter and the swipe hint', () => {
    const s = screenText(mk({
      relayInfo: [relayItem('info', 'i1', 'done')],
      overlayItemId: 'i1',
    }))
    expect(s.header).not.toMatch(/\d+\/\d+/)
    expect(s.footer).not.toContain('swipe')
  })

  test('a question outranks a notification when both are queued', () => {
    const s = screenText(mk({
      relayWaiting: [relayItem('waiting', 'w1', 'Which approach?')],
      relayInfo: [relayItem('info', 'i1', '応答が完了しました')],
      overlayItemId: 'w1',
    }))
    expect(s.header).toContain('[!] 1/2')
    expect(s.footer).toContain('swipe:次')
  })

  test('the notification is second in that queue, not first', () => {
    const s = screenText(mk({
      relayWaiting: [relayItem('waiting', 'w1', 'Which approach?')],
      relayInfo: [relayItem('info', 'i1', '応答が完了しました')],
      overlayItemId: 'i1',
    }))
    expect(s.header).toContain('[i] 2/2')
  })

  test('an emptied queue says so instead of rendering a blank panel', () => {
    expect(screenText(mk({ overlayItemId: 'gone' })).body).toBe('(なし)')
  })

  test('the dialog gives the panel back on its own', () => {
    // The value is the guarantee, not the number: a wearer must never have to
    // clear a completion by hand.
    expect(NOTICE_DISMISS_MS).toBeGreaterThan(0)
    expect(NOTICE_DISMISS_MS).toBeLessThanOrEqual(15_000)
  })
})

describe('no notification about what is already on screen', () => {
  const info = (sessionId: string, text: string, createdAt = 1) => ({
    id: `i-${sessionId}`, sessionId, kind: 'info' as const, text,
    source: 'auto' as const, createdAt,
  })

  const mk = (over: Record<string, unknown>) => ({
    mode: 'conversation' as const,
    sessions: [
      { id: 'a', name: 'グラス開発', state: 'working' as const },
      { id: 'b', name: '2脚ロボ開発', state: 'idle' as const },
    ],
    sessionIndex: 0, // reading 'a'
    conversation: [
      { role: 'assistant' as const, content: '本文です', timestamp: '2026-07-28T00:00:00Z' },
    ],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    spinnerTick: 0,
    ...over,
  })

  test('the session being read does not announce itself, not even as a count', () => {
    // An agent working in bursts fires one of these per turn; counting them
    // would leave a mark permanently lit about the thing being watched.
    const s = screenText(mk({ relayInfo: [info('a', '応答が完了しました')] }))
    expect(s.header).not.toContain('[i]')
    expect(s.body).not.toContain('[i]')
    expect(s.body).toContain('本文です')
  })

  test('another session is reported as a count in the header, not as body text', () => {
    // The dialog already showed it in full and the list still holds it; a
    // third showing would cost two of the seven lines being read.
    const s = screenText(mk({ relayInfo: [info('b', '応答が完了しました')] }))
    expect(s.header).toContain('[i]1')
    expect(s.body).not.toContain('応答が完了しました')
  })

  test('the open session is not counted, the others are', () => {
    const s = screenText(mk({
      relayInfo: [info('a', 'これは数えない', 2), info('b', 'これは数える', 1)],
    }))
    expect(s.header).toContain('[i]1')
    expect(s.body).not.toContain('これは数える')
    expect(s.body).not.toContain('これは数えない')
  })

  test('nothing waiting means no mark at all', () => {
    expect(screenText(mk({})).header).not.toContain('[i]')
  })

  test('a long workspace name gives way so the count survives', () => {
    // withClock truncates from the right; without the tail split the mark
    // itself would be what fell off the edge.
    const s = screenText(mk({
      sessions: [
        { id: 'a', name: 'とても長いワークスペース名前ですこれは実機の幅を超えます', state: 'working' as const },
        { id: 'b', name: 'b', state: 'idle' as const },
      ],
      relayInfo: [info('b', 'x')],
    }))
    expect(s.header).toContain('[i]1')
    expect(width(s.header)).toBeLessThanOrEqual(HEADER_WIDTH)
  })

  test('a question about the open session still shows — it carries the choices', () => {
    const body = screenText(mk({
      relayWaiting: [{
        id: 'w', sessionId: 'a', kind: 'waiting' as const, text: 'Which one?',
        source: 'auto' as const, createdAt: 1, choices: ['A', 'B'],
      }],
    })).body
    expect(body).toContain('[!]グラス開発')
  })

  test('the list is untouched: nothing there is "on screen"', () => {
    // sessionIndex is a cursor on the list, not a conversation being read.
    const body = screenText(mk({
      mode: 'session_list' as const,
      relayInfo: [info('a', '応答が完了しました')],
    })).body
    expect(body).toContain('[i]グラス開発: 応答が完了しました')
  })
})
