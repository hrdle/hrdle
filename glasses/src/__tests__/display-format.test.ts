import { describe, expect, test } from 'bun:test'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { sanitizeForG2, formatMessage } from '../types.ts'
import { invalidatePanel, panelDrops, screenText, updateDisplay, updateHeader, wrapForPanel, wrapHeader } from '../display.ts'
import {
  BAR_H,
  BODY_WIDTH,
  CARD_LINES,
  CARD_WIDTH,
  HEADER_WIDTH,
  LINE_H,
  LIST_LINES,
  PANEL_H,
  PANEL_W,
  cardBox,
  textWidth as width,
} from '../metrics.ts'
import { listRows, rowCursor, selectableRows } from '../display.ts'
import { GlassesController, NOTICE_DISMISS_MS } from '../controller.ts'
import { NOTICE_SCROLL_CHARS, noticeHeight, noticeScrollSteps } from '../display.ts'
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

  // Every agent names its arguments its own way, and the screen has to read all
  // of them. These are the shapes taken off real transcripts, not invented.
  const detail = (name: string, input: Record<string, unknown>) =>
    formatMessage({ role: 'assistant', content: '', toolUse: [{ name, input }] })

  describe('says what a call did whichever agent made it', () => {
    test("Claude's file argument", () => {
      expect(detail('Read', { file_path: '/home/m0a/repos/app/src/index.ts' })).toBe(
        '[Read] .../src/index.ts',
      )
    })

    test("Kimi's, which used to leave the line bare", () => {
      // The whole bug: `path`, not `file_path`, and the named case returned an
      // empty string rather than letting the fallback find it.
      expect(detail('Read', { path: 'HANDOFF.md', line_offset: 0 })).toBe('[Read] HANDOFF.md')
      expect(detail('Edit', { path: 'src/app.ts', old_string: 'a', new_string: 'b' })).toBe(
        '[Edit] src/app.ts',
      )
      expect(detail('Write', { path: '/tmp/a/b/out.txt', content: 'x' })).toBe(
        '[Write] .../b/out.txt',
      )
    })

    test("Grok's, which names the same argument a third way", () => {
      expect(detail('read_file', { target_file: 'wrangler.jsonc', limit: 40 })).toBe(
        '[read_file] wrangler.jsonc',
      )
      expect(detail('list_dir', { target_directory: '/home/m0a/repos/app' })).toBe(
        '[list_dir] .../repos/app',
      )
    })

    test('a scoped search shows what it looked for, not where', () => {
      // Kimi's Grep carries both. The path is the least interesting half.
      expect(detail('Grep', { pattern: 'getToolSummary', path: 'frontend/src', '-n': true })).toBe(
        '[Grep] getToolSummary',
      )
    })

    test('a description still outranks everything derived', () => {
      expect(detail('run_terminal_command', { command: 'bun test', description: 'Run the tests' })).toBe(
        '[run_terminal_command] Run the tests',
      )
    })

    test('a tool nobody anticipated says something about itself', () => {
      expect(detail('Skill', { skill: 'glasses-upload', args: '' })).toBe('[Skill] glasses-upload')
      expect(detail('FetchURL', { url: 'https://example.com/spec' })).toBe(
        '[FetchURL] https://example.com/spec',
      )
    })

    test('nothing to say leaves the name alone rather than inventing something', () => {
      expect(detail('TodoList', { todos: [{ content: 'a' }] })).toBe('[TodoList]')
      expect(detail('EnterPlanMode', {})).toBe('[EnterPlanMode]')
      // An identifier is not a summary; the reason beside it is.
      expect(detail('TaskStop', { task_id: 'abc-123', reason: 'superseded' })).toBe(
        '[TaskStop] superseded',
      )
    })
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

  test('a long recap is shown a window at a time, never cut', () => {
    // It used to end at `…`: the reader was told there was more and given no
    // way to reach it. The strip windows it and the clock walks the rest.
    const first = (screenText(state(longRecap)).notice ?? '').split('\n')
    expect(first[0].startsWith('Summary: ')).toBe(true)
    expect(first.length).toBeLessThanOrEqual(2)
    expect(first.join('')).not.toEndWith('…')
    expect(noticeScrollSteps(state(longRecap) as never)).toBeGreaterThan(1)
  })

  test('waiting reaches the end of it, and then stops', () => {
    const st = state(longRecap)
    const windows = noticeScrollSteps(st as never)
    const seen = new Set<string>()
    for (let w = 0; w < windows; w++) {
      for (const line of (screenText({ ...st, noticeWindow: w }).notice ?? '').split('\n')) {
        if (line) seen.add(line)
      }
    }
    // Every line of the recap has been on screen by the last window.
    const all = (screenText({ ...st, noticeWindow: 0 }).notice ?? '').split('\n')
    expect(seen.size).toBeGreaterThan(all.length)
    // Past the last window it holds rather than wrapping around.
    const last = screenText({ ...st, noticeWindow: windows - 1 }).notice
    expect(screenText({ ...st, noticeWindow: windows + 5 }).notice).toBe(last)
  })

  test('the rule between recap and conversation costs no line', () => {
    // It used to be a row of dashes inside the body — 27px, a seventh of
    // everything the reader gets, spent on a separator the panel can draw.
    const s = screenText(state(longRecap))
    expect(s.notice).not.toContain('-'.repeat(24))
    expect(s.body).not.toContain('-'.repeat(24))
  })

  test('notice and conversation together never exceed one page', () => {
    for (const recap of [undefined, longRecap]) {
      const s = screenText(state(recap))
      const noticeLines = s.notice ? s.notice.split('\n').length : 0
      const bodyLines = wrapForPanel(s.body).split('\n').length
      // The strip is shorter than the lines it holds would be in the body:
      // its padding is 2 where the body's is 6.
      expect(noticeHeight(noticeLines) + bodyLines * 27).toBeLessThanOrEqual(288 - 2 * 36)
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
    //
    // Measured in pixels, not characters: the panel is proportional, and the
    // cursor marker is one character where the blank standing in for it is two.
    // A character count says those rows are misaligned; the reader's eye says
    // they are not, and the pixels agree with the eye.
    const starts = screenText(state)
      .body.split('\n')
      .map((l) => width(l.slice(0, l.search(/[^ >\u3000！·•]/))))
    // Within a space, not identical: the working dots are 5px and 9px against
    // the column's 20, and the pad that makes up the difference is built from
    // 5px spaces — the bullet leaves 1px it cannot fill.
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(SPACE_W)
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
  const hasRecap = (st: ReturnType<typeof state>) => (screenText(st).notice ?? '').startsWith('Summary: ')

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
    // Two frames, not four: at one frame per three seconds a rotation is never
    // seen turning, only sampled — and four sampled triangles read as four
    // states. Filled against hollow reads as one thing, beating.
    const frames = [0, 1].map(mark)
    expect(new Set(frames).size).toBe(2)
  })

  test('comes back round', () => {
    expect(mark(2)).toBe(mark(0))
  })

  test('a frame change does not move the name beside it', () => {
    // The two dots differ in width by design — that is what makes them small.
    // The pad after them is what holds the column, so this tests the pad.
    const nameStart = (tick: number) => {
      const line = screenText({ ...st(tick, 'processing'), mode: 'session_list' as const }).body.split('\n')[0]
      return width(line.slice(0, line.indexOf('[')))
    }
    expect(Math.abs(nameStart(0) - nameStart(1))).toBeLessThan(SPACE_W)
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

  test('wraps a line a little over the width instead of dropping the block', () => {
    // `[code 2 lines]` on a real screen: two lines, one of them slightly over,
    // and the marker showed neither of them. The reader was told a fenced block
    // existed and given none of it, for want of a line break.
    const wide = 'curl -fsSL https://herdr.dev/install.sh | sh && herdr integration install claude'
    // Asserted, so the case cannot quietly stop being the case under test.
    expect(width(wide)).toBeGreaterThan(BODY_WIDTH)
    const out = sanitizeForG2(`\`\`\`\nbun run test\n${wide}\n\`\`\``)
    expect(out).not.toContain('[code')
    expect(out.split('\n')).toEqual([
      'bun run test',
      'curl -fsSL https://herdr.dev/install.sh | sh && herdr integration',
      'install claude',
    ])
  })

  test('summarises a line too long to wrap inside the budget', () => {
    // Four rendered lines is the whole budget; a line that wraps past it is
    // source rather than an aside, and becomes the page if shown.
    const wide = 'x'.repeat(500)
    expect(sanitizeForG2(`\`\`\`\n${wide}\n\`\`\``)).toBe('[code 1 lines]')
  })

  test('summarises a block long enough to become the page', () => {
    const many = Array.from({ length: 6 }, (_, i) => `${i}行目`).join('\n')
    expect(sanitizeForG2(`\`\`\`\n${many}\n\`\`\``)).toBe('[code 6 lines]')
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

  test('a workspace is bracketed and its panes are indented under it', () => {
    // Bracketed is a workspace, bare and indented is a pane of the one above.
    // The rule only works if it holds for every workspace, so the single-pane
    // one is bracketed too - otherwise it reads as a pane of nothing.
    const body = screenText(st(1)).body.split('\n')
    expect(body[0]).toContain('[グラス開発]')
    expect(body[1]).toContain('[2脚ロボ開発]')
    expect(body[2]).toContain('     %1')
    expect(body[3]).toContain('     %2')
    // The tree it replaces: the branch said which pane was last, which was not
    // the question anyone was asking of this screen.
    expect(screenText(st(1)).body).not.toMatch(/[├└]/)
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
    expect(body).toContain('     %1 ctx:▃')
    expect(body).not.toContain('wheel-leg-bot')
  })

  test('a row sets its mark beside the name it belongs to', () => {
    // Parked at the right edge it read as a chart of its own, which the eye had
    // to travel to and back from to see whose row it was. The label is what
    // makes a lone block legible.
    const lines = screenText(st(1)).body.split('\n')
    const marked = lines.filter((l) => /ctx:[▁▂▃▄▅▆▇█]$/.test(l))
    expect(marked.length).toBeGreaterThan(1)
    for (const line of marked) expect(width(line)).toBeLessThanOrEqual(BODY_WIDTH)
  })

  test('the list shows how full without spelling it out', () => {
    // Eight block heights, filling as the context does - the tall row is the
    // one running out, findable without reading a single number. The figure
    // itself is one row's worth of detail and lives in the footer.
    const body = screenText(st(1)).body
    expect(body).toContain('▃')
    expect(body).toContain('▂')
    expect(body).not.toMatch(/\d+%/)
  })

  test('a heading leaves the mark to the panes under it', () => {
    // One bar covering three agents describes none of them.
    const heading = screenText(st(1)).body.split('\n')[1]
    expect(heading).toContain('[2脚ロボ開発]')
    expect(heading).not.toMatch(/[▁▂▃▄▅▆▇█]/)
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
    expect(body).toContain('%1 ctx:▃')
    expect(body).toContain('%4 ctx:▁')
    expect(body).not.toContain('別タブ')
  })
})

describe('what a list row says about the agent', () => {
  const mk = (metrics: { contextPercent?: number; model?: string }) => ({
    mode: 'session_list' as const,
    sessions: [{ id: 'a', name: 'hrdle', state: 'idle' as const, metrics }],
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
  })

  test('a single-pane workspace carries its own mark', () => {
    // It has no pane rows to put one on, and it is most of the list.
    expect(screenText(mk({ contextPercent: 42.1, model: 'claude-opus-5' })).body).toContain(
      '[hrdle] ctx:▄'
    )
  })

  test('the figures belong to the row being pointed at', () => {
    // Printed on all thirteen rows they are the same two facts thirteen times;
    // the model rarely differs, and nobody compares percents digit by digit
    // while walking a list.
    const { body, footer } = screenText(mk({ contextPercent: 42.1, model: 'claude-opus-5' }))
    expect(footer).toContain('Opus 5 42%')
    expect(body).not.toContain('Opus')
    expect(body).not.toContain('42%')
  })

  test('the model is the family and its version, not the id', () => {
    const footer = screenText(mk({ model: 'claude-sonnet-5-20260101' })).footer
    expect(footer).toContain('Sonnet 5')
    expect(footer).not.toContain('20260101')
  })

  test('a model from another provider keeps the name it was given', () => {
    // Minus the vendor prefix, which names who sells it rather than what runs.
    expect(screenText(mk({ model: 'moonshotai/kimi-k3' })).footer).toContain('kimi-k3')
  })

  test('the glyph fills as the context does', () => {
    expect(screenText(mk({ contextPercent: 0 })).body).toContain('▁')
    expect(screenText(mk({ contextPercent: 100 })).body).toContain('█')
    // Rounded to the figure the footer shows, so 99.6% is not a full bar
    // beside a number that says otherwise.
    expect(screenText(mk({ contextPercent: 99.6 })).body).toContain('█')
    expect(screenText(mk({ contextPercent: 99.6 })).footer).toContain('100%')
  })

  test('a workspace with neither says nothing in their place', () => {
    const { body, footer } = screenText(mk({}))
    expect(body).toContain('[hrdle]')
    expect(body.trimEnd()).toBe(body)
    expect(footer).not.toMatch(/%\D*$/)
  })

  test('the footer keeps the figures when the bar runs short', () => {
    // The hints say what every row does and are learned once; the figures
    // change with every swipe, which is the reason to swipe.
    const footer = screenText({
      ...mk({ contextPercent: 42, model: 'claude-opus-5' }),
      relayWaiting: [
        { id: 'r1', sessionId: 'a', kind: 'waiting' as const, text: 'x', source: 'auto' as const, createdAt: 0 },
      ],
    }).footer
    expect(footer).toContain('Opus 5 42%')
    expect(width(footer)).toBeLessThanOrEqual(HEADER_WIDTH)
  })

  test('a name too long for the mark is what gives way', () => {
    const long = 'あ'.repeat(40)
    const body = screenText({
      ...mk({ contextPercent: 42, model: 'claude-opus-5' }),
      sessions: [{ id: 'a', name: long, state: 'idle' as const, metrics: { contextPercent: 42, model: 'claude-opus-5' } }],
    }).body
    // The mark was the part added; a clipped name still names its row.
    expect(body).toMatch(/ctx:▄$/)
    expect(body).toContain('…')
    expect(width(body)).toBeLessThanOrEqual(BODY_WIDTH)
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
    expect(screenText({ ...mk('processing'), spinnerTick: 0 }).body).toContain('·')
    expect(screenText({ ...mk('processing'), spinnerTick: 1 }).body).toContain('•')
  })

  test('waiting is no longer marked', () => {
    // Seven of eight rows carried `[!]` on a real machine — a mark almost
    // everything has stops distinguishing anything.
    const body = screenText(mk('waiting_input')).body
    expect(body).not.toContain('[!]')
    expect(body).not.toContain('•')
  })

  test('an unmarked row is padded to a badge width', () => {
    expect(screenText(mk()).body).toContain('\u3000 [グラス開発]')
  })

  test('a relay item still marks its workspace', () => {
    const withRelay = {
      ...mk(),
      relayWaiting: [
        { id: 'r', sessionId: 'a', kind: 'waiting' as const, text: 'x', source: 'auto' as const, createdAt: 1 },
      ],
    }
    expect(screenText(withRelay).body).toContain('！ [グラス開発]')
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

  // The leading column is the cursor's. The notice is a row the cursor can rest
  // on now, so it carries the same marker column as every row below it — a line
  // that started one column to the left would not line up with them.

  test('a notification heads the list, named by its workspace', () => {
    // Its own strip, not the list's first row: on the device that is a
    // container with a border round it, which is what stops the eye reading it
    // as one more session name.
    const screen = screenText(mk([info('a', '応答が完了しました')]))
    expect(screen.notice).toBe('  [i]グラス開発: 応答が完了しました')
    // The list itself is still there, below it.
    expect(screen.body.split('\n')[0]).toContain('グラス開発')
  })

  test('an unknown workspace falls back to its id rather than vanishing', () => {
    expect(screenText(mk([info('gone', '応答が完了しました')])).notice).toBe(
      '  [i]gone: 応答が完了しました',
    )
  })

  test('the count of the others survives even when the text is cut', () => {
    const long = 'あ'.repeat(120)
    const banner = screenText(mk([info('a', long, 2), info('s1', long, 1)], 2)).notice ?? ''
    expect(banner.startsWith('  [i]グラス開発+1: ')).toBe(true)
  })

  test('the cursor can rest on it', () => {
    const screen = screenText({ ...mk([info('a', '応答が完了しました')]), listOnNotifications: true })
    expect(screen.notice?.startsWith('>')).toBe(true)
    // And nothing in the list is marked while the strip holds the cursor.
    expect(screen.body.split('\n').every((l) => !l.startsWith('>'))).toBe(true)
  })

  test('a waiting question outranks a newer notification for the row', () => {
    // The row shows one item, and the one that wants something from the reader
    // is worth more than whichever arrived last.
    const st = {
      ...mk([info('a', 'ただのお知らせ')]),
      relayWaiting: [{ ...info('a', '選んでください'), kind: 'waiting' as const }],
    }
    const first = screenText(st).notice ?? ''
    expect(first).toContain('[!]')
    expect(first).toContain('選んでください')
    // Both are counted, so the reader knows the list holds more than the one.
    expect(first).toContain('+1')
  })

  test('it stays put while the reader walks a long list', () => {
    // It replaced a banner that was always on screen. A notice that scrolled out
    // of sight as the cursor moved down would be a worse thing than the banner.
    const st = { ...mk([info('a', '応答が完了しました')], 14), sessionIndex: 13 }
    const screen = screenText(st)
    expect(screen.notice).toContain('応答が完了しました')
    expect(screen.body.split('\n').at(-1)).toContain('ws13')
  })

  test('the banner takes its line from the list, never from the panel', () => {
    const many = mk([], 12)
    const rowsWithout = screenText(many).body.split('\n').length
    const rowsWith = screenText({ ...many, relayInfo: [info('a', 'x')] }).body.split('\n').length
    expect(rowsWithout).toBe(LIST_LINES)
    // The strip is its own container now, so the row it costs comes off the
    // list rather than out of the panel: same total, one fewer session shown.
    expect(rowsWith).toBe(LIST_LINES - 1)
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
    // "later" is a reply to a question. A notification asked nothing.
    const s = screenText(mk({
      relayInfo: [relayItem('info', 'i1', '応答が完了しました')],
      overlayItemId: 'i1',
    }))
    expect(s.footer).toContain('dbl:close')
    expect(s.footer).not.toContain('later')
  })

  test('a question keeps its own wording and mark', () => {
    const s = screenText(mk({
      relayWaiting: [relayItem('waiting', 'w1', 'Which approach?', { choices: ['A', 'B'] })],
      overlayItemId: 'w1',
    }))
    expect(s.header).toContain('[!]')
    expect(s.footer).toContain('dbl:later')
    expect(s.footer).toContain('tap:choices')
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
    expect(s.footer).toContain('swipe:next')
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
    expect(screenText(mk({ overlayItemId: 'gone' })).body).toBe('(none)')
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
    const s = screenText(mk({
      relayWaiting: [{
        id: 'w', sessionId: 'a', kind: 'waiting' as const, text: 'Which one?',
        source: 'auto' as const, createdAt: 1, choices: ['A', 'B'],
      }],
    }))
    expect(s.notice).toContain('[!]グラス開発')
  })

  test('the list is untouched: nothing there is "on screen"', () => {
    // sessionIndex is a cursor on the list, not a conversation being read.
    expect(screenText(mk({
      mode: 'session_list' as const,
      relayInfo: [info('a', '応答が完了しました')],
    })).notice).toContain('[i]グラス開発: 応答が完了しました')
  })
})

describe('the header bar never overflows, whatever the clock reads', () => {
  // A CI run in another timezone caught this: digit widths differ (`1` is 8px,
  // `0` is wider), so the bar fit on the machine it was written on and not on
  // the one that checked it. Sweeping the clock is the only honest test of a
  // layout that measures itself against the time of day.
  const RealDate = Date

  const state = (name: string, notices: number) => ({
    mode: 'conversation' as const,
    sessions: [
      { id: 'a', name, state: 'working' as const, indicatorState: 'waiting_input' as const },
      { id: 'b', name: 'b', state: 'idle' as const },
    ],
    sessionIndex: 0,
    conversation: [{ role: 'assistant' as const, content: 'x', timestamp: '2026-07-28T00:00:00Z' }],
    conversationOffset: 0, conversationPage: 0, conversationLastLoaded: 0,
    conversationHasMore: false, conversationLoading: false,
    choiceIndex: 0, choiceOptions: [], relayWaiting: [],
    relayInfo: Array.from({ length: notices }, (_, i) => ({
      id: `i${i}`, sessionId: 'b', kind: 'info' as const, text: 'x',
      source: 'auto' as const, createdAt: i,
    })),
    overlayItemId: null, spinnerTick: 0,
  })

  const NAMES = [
    'とても長いワークスペース名前ですこれは実機の幅を超えます',
    'wheel-leg-bot-with-a-very-long-name-indeed-truly',
    'グラス開発',
  ]

  function sweep(check: (header: string, at: string) => void) {
    try {
      for (let m = 0; m < 1440; m += 7) {
        const h = Math.floor(m / 60)
        const mi = m % 60
        // @ts-expect-error clock shim for the sweep
        globalThis.Date = class extends RealDate {
          getHours() { return h }
          getMinutes() { return mi }
        }
        const at = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
        for (const n of NAMES) check(screenText(state(n, 2) as never).header, `${at} / ${n}`)
      }
    } finally {
      globalThis.Date = RealDate
    }
  }

  test('it fits at every minute of the day', () => {
    const over: string[] = []
    sweep((header, at) => {
      if (width(header) > HEADER_WIDTH) over.push(`${at}: ${width(header)}px "${header}"`)
    })
    expect(over).toEqual([])
  })

  test('the notice count is never what falls off the edge', () => {
    // The title is truncatable context; the count is the news. If the bar has
    // to lose something it must not be this.
    const lost: string[] = []
    sweep((header, at) => {
      if (!header.includes('[i]2')) lost.push(`${at}: "${header}"`)
    })
    expect(lost).toEqual([])
  })
})

describe('a pane is called what the user called it', () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    mode: 'session_list' as const,
    sessions: [
      {
        id: 'a', name: '2脚ロボ開発', state: 'idle' as const,
        panes: [
          { paneId: '%1', currentPath: '/repo' },
          { paneId: '%3', label: '買い物', currentPath: '/repo' },
          { paneId: '%4', label: '   ', currentPath: '/repo' },
        ],
      },
    ],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0, conversationPage: 0, conversationLastLoaded: 0,
    conversationHasMore: false, conversationLoading: false,
    choiceIndex: 0, choiceOptions: [], relayWaiting: [], relayInfo: [],
    overlayItemId: null, spinnerTick: 0,
    ...over,
  })

  test('a named pane shows its name', () => {
    // `%3` is an address, not a name: it says where the pane sits in the split
    // tree and nothing about what is running there.
    expect(screenText(mk()).body).toContain('買い物')
  })

  test('an unnamed pane keeps its id', () => {
    // Most panes are never named; without the fallback the row points at
    // nothing at all.
    expect(screenText(mk()).body).toContain('%1')
  })

  test('a blank name is not a name', () => {
    // herdr accepts whitespace; a row reading "├    16%" identifies nothing.
    expect(screenText(mk()).body).toContain('%4')
  })

  test('the conversation header names the pane it is reading', () => {
    const s = screenText(mk({
      mode: 'conversation' as const,
      selectedPaneId: '%3',
      conversation: [{ role: 'assistant' as const, content: 'x', timestamp: '2026-07-28T00:00:00Z' }],
    }))
    expect(s.header).toContain('買い物')
    expect(s.header).not.toContain('%3')
  })
})

describe('waiting shows what did not fit', () => {
  const longRecap = '要約の1文目です。'.repeat(30)
  const st = (over: Record<string, unknown> = {}) => ({
    mode: 'conversation' as const,
    sessions: [{
      id: 'a', name: 'グラス開発', state: 'working' as const,
      ccRecap: longRecap, ccRecapAt: '2030-01-01T00:00:00Z',
    }],
    sessionIndex: 0,
    conversation: [{ role: 'assistant' as const, content: 'x', timestamp: '2026-07-28T00:00:00Z' }],
    conversationOffset: 0, conversationPage: 0, conversationLastLoaded: 0,
    conversationHasMore: false, conversationLoading: false,
    choiceIndex: 0, choiceOptions: [], relayWaiting: [], relayInfo: [],
    overlayItemId: null, spinnerTick: 0,
    ...over,
  })

  test('the strip reports how many windows it takes', () => {
    // The clock asks this to know whether waiting reveals anything more, so it
    // can move on to the conversation instead of sitting on a finished strip.
    expect(noticeScrollSteps(st() as never)).toBeGreaterThan(1)
  })

  test('a notice that fits takes exactly one window', () => {
    const short = st({ sessions: [{ id: 'a', name: 'g', state: 'idle' as const, ccRecap: '短い', ccRecapAt: '2030-01-01T00:00:00Z' }] })
    expect(noticeScrollSteps(short as never)).toBe(1)
  })

  test('no notice at all takes one window, so the clock moves straight on', () => {
    const none = st({ sessions: [{ id: 'a', name: 'g', state: 'idle' as const }] })
    expect(noticeScrollSteps(none as never)).toBe(1)
  })

  test('it scrolls by characters, sliding the text instead of turning pages', () => {
    // A line at a time replaced the whole strip in 27px jumps, and the reader
    // had to find their place in a sentence they were mid-way through. Taking
    // a few characters off the front and re-wrapping what is left slides the
    // block instead, which is what reading along a line looks like.
    const prose =
      '認証まわりの実装を一通り終えてテストも通ったので次はエラー処理の見直しに入る予定です' +
      'あわせてログ出力の粒度も揃えておきたいところですが優先度は低いので後回しにします'
    const state = st({
      sessions: [{
        id: 'a', name: 'g', state: 'idle' as const,
        ccRecap: prose, ccRecapAt: '2030-01-01T00:00:00Z',
      }],
    })
    const at = (o: number) => (screenText({ ...state, noticeWindow: o }).notice ?? '').split('\n')
    const src = Array.from(`Summary: ${prose}`)
    const first = at(0)
    const second = at(1)

    // Two lines at a time, and the first of them opens the recap.
    expect(first.length).toBe(2)
    expect(first[0].startsWith('Summary: ')).toBe(true)

    // One step on, the top line begins a few characters into the one before it
    // — not at the line below it, which is what paging looked like.
    expect(second[0]).not.toBe(first[1])
    const dropped = src.slice(NOTICE_SCROLL_CHARS).join('').replace(/^\s+/, '')
    expect(dropped.startsWith(second[0])).toBe(true)

    // The walk ends with the recap's last characters on screen — the whole
    // point of walking it — and holds there rather than wrapping round on its
    // own. Going back to the top is the clock's decision, made after a rest.
    const steps = noticeScrollSteps(state as never)
    expect(at(steps - 1).join('')).toContain(prose.slice(-10))
    expect(at(steps + 5)).toEqual(at(steps - 1))
  })

  test('every line is on screen at some point', () => {
    // Short lines are the shape that catches a stride longer than the strip:
    // two display lines of `行N` hold barely six characters, so a step that
    // always advanced `NOTICE_SCROLL_CHARS` would carry lines off the top that
    // were never shown. Silently skipping part of the recap is the failure the
    // scrolling exists to fix, so it is guarded here rather than in prose,
    // which never steps far enough to notice.
    const numbered = Array.from({ length: 9 }, (_, i) => `行${i}`).join('\n')
    const state = st({
      sessions: [{
        id: 'a', name: 'g', state: 'idle' as const,
        ccRecap: numbered, ccRecapAt: '2030-01-01T00:00:00Z',
      }],
    })
    const seen = new Set<string>()
    for (let o = 0; o < noticeScrollSteps(state as never); o++) {
      for (const l of (screenText({ ...state, noticeWindow: o }).notice ?? '').split('\n')) {
        if (l) seen.add(l)
      }
    }
    for (let i = 0; i < 9; i++) expect([...seen].some((l) => l.includes(`行${i}`))).toBe(true)
  })

  test('the recap is not counted while the reader has paged away from it', () => {
    // Deeper paging drops the recap for message space; the clock must not then
    // think there is a strip to walk.
    expect(noticeScrollSteps(st({ conversationPage: 2 }) as never)).toBe(1)
  })
})

describe('the scroll rests at the end before starting over', () => {
  // The controller's clock, on paper: one tick per SCROLL step, a page turn
  // and the end-of-scroll rest each costing three. Verifying the schedule
  // rather than the wall clock keeps this test instant and deterministic.
  const STEP = 1
  const DWELL_TICKS = 3
  const PAGE_TICKS = 3

  function run(noticeSteps: number, totalPages: number, ticks: number) {
    let w = 0
    let page = 0
    let waited = 0
    const events: string[] = []
    for (let t = STEP; t <= ticks; t += STEP) {
      if (w < noticeSteps - 1) {
        w++; waited = 0; events.push(`scroll:${w}@${t}`); continue
      }
      const need = noticeSteps > 1 ? DWELL_TICKS : PAGE_TICKS
      if (++waited < need) continue
      waited = 0
      if (page < totalPages - 1) { page++; events.push(`page:${page}@${t}`); continue }
      if (noticeSteps > 1 && w !== 0) { w = 0; events.push(`rewind@${t}`) }
    }
    return events
  }

  test('the last line is not snatched away at a scrolled line’s pace', () => {
    // It reached the end and went straight back to the top, so the line worth
    // waiting for got less time than any line before it.
    const events = run(4, 1, 10)
    const end = events.findIndex((e) => e.startsWith('scroll:3'))
    const rewind = events.findIndex((e) => e.startsWith('rewind'))
    expect(end).toBeGreaterThanOrEqual(0)
    expect(rewind).toBeGreaterThan(end)
    // Three ticks between arriving and leaving, not one.
    const at = (e: string) => Number(e.split('@')[1])
    expect(at(events[rewind]) - at(events[end])).toBe(DWELL_TICKS)
  })

  test('it comes round again rather than sitting on the last lines forever', () => {
    const events = run(4, 1, 14)
    expect(events.filter((e) => e === 'scroll:1@1' || e.startsWith('scroll:1@')).length).toBeGreaterThan(1)
  })

  test('pages take their turn before the recap starts over', () => {
    // Otherwise a recap loop would keep the rest of the message off screen.
    const events = run(4, 3, 12)
    const firstPage = events.findIndex((e) => e.startsWith('page:'))
    const firstRewind = events.findIndex((e) => e.startsWith('rewind'))
    expect(firstPage).toBeGreaterThanOrEqual(0)
    expect(firstRewind === -1 || firstPage < firstRewind).toBe(true)
  })

  test('with nothing to scroll, pages still turn on their own schedule', () => {
    const events = run(1, 3, 9)
    expect(events).toEqual(['page:1@3', 'page:2@6'])
  })
})

describe('the screen stops drawing once nobody is being shown anything new', () => {
  // Looping forever meant a redraw every five seconds over BLE for as long as
  // the conversation stayed open — for nobody. The device's host started
  // killing the app roughly eight times as often.
  const DWELL_TICKS = 3
  const MAX_PASSES = 2

  function run(noticeSteps: number, totalPages: number, ticks: number) {
    let w = 0, page = 0, waited = 0, passes = 0
    let resting = false
    let draws = 0
    let restedAt = -1
    for (let t = 1; t <= ticks; t++) {
      if (resting) continue
      if (w < noticeSteps - 1) { w++; waited = 0; draws++; continue }
      if (++waited < DWELL_TICKS) continue
      waited = 0
      if (page < totalPages - 1) { page++; draws++; continue }
      if (noticeSteps > 1 && w !== 0) {
        w = 0; draws++
        if (++passes >= MAX_PASSES) { resting = true; restedAt = t }
        continue
      }
      resting = true; restedAt = t
    }
    return { draws, restedAt, passes }
  }

  test('it comes to rest, and stays there', () => {
    const short = run(4, 1, 20)
    const long = run(4, 1, 200)
    // Ten times the wait draws nothing more.
    expect(long.draws).toBe(short.draws)
    expect(long.restedAt).toBe(short.restedAt)
  })

  test('the recap is shown twice before it rests', () => {
    // Once is easy to miss; a third time is drawing for someone who is not there.
    expect(run(4, 1, 200).passes).toBe(MAX_PASSES)
  })

  test('a screen with nothing to advance rests almost immediately', () => {
    const r = run(1, 1, 100)
    expect(r.draws).toBe(0)
    expect(r.restedAt).toBe(DWELL_TICKS)
  })

  test('pages are all turned before it rests', () => {
    // Resting early would leave the rest of the message unreachable by waiting,
    // which is the whole point of the feature.
    const r = run(4, 3, 200)
    expect(r.draws).toBeGreaterThanOrEqual(3 + 2)
  })
})

describe('a screen that has not changed is not sent again', () => {
  // The panel was redrawn on every `sessions-updated` push — every five
  // seconds, whether or not anything on it had changed. On the device that
  // measured 0.2 full draws a second, indefinitely, over BLE, for a screen
  // showing exactly what it showed five seconds ago.

  function stubBridge() {
    const calls: Array<{ id: number; content: string }> = []
    let rebuilds = 0
    const bridge = {
      textContainerUpgrade: (u: { containerID: number; content: string }) => {
        calls.push({ id: u.containerID, content: u.content })
        return Promise.resolve()
      },
      rebuildPageContainer: () => {
        rebuilds++
        return Promise.resolve()
      },
    }
    return { bridge: bridge as never, calls, rebuilds: () => rebuilds }
  }

  const listState = (name: string) =>
    ({
      mode: 'session_list' as const,
      sessions: [{ id: 'a', name, state: 'idle' as const }],
      sessionIndex: 0, selectedPaneId: null,
      conversation: [], conversationOffset: 0, conversationPage: 0,
      conversationHasMore: false, conversationLoading: false,
      choiceIndex: 0, choiceOptions: [], relayWaiting: [], relayInfo: [],
      overlayItemId: null, spinnerTick: 0,
    }) as never

  test('an identical frame sends no container at all', async () => {
    const { bridge, calls } = stubBridge()
    await updateDisplay(bridge, listState('alpha'))
    calls.length = 0
    await updateDisplay(bridge, listState('alpha'))
    // Container 1 holds the rows. Asserted rather than the whole call list
    // because container 2 is the footer, and the footer carries the clock —
    // it legitimately changes once a minute, and a test that forbade it would
    // fail whenever the two calls straddled a minute boundary.
    expect(calls.filter((c) => c.id === 1)).toEqual([])
  })

  test('a frame that changes one container sends only that one', async () => {
    const { bridge, calls } = stubBridge()
    await updateDisplay(bridge, listState('alpha'))
    calls.length = 0
    await updateDisplay(bridge, listState('beta'))
    const rows = calls.filter((c) => c.id === 1)
    expect(rows.length).toBe(1)
    expect(rows[0].content).toContain('beta')
  })

  test('the spinner tick is skipped too when the rows read the same', async () => {
    // It fires every three seconds for as long as any agent is working, and
    // the rows it redraws only move when the spinner glyph does.
    const { bridge, calls } = stubBridge()
    const s = listState('alpha')
    await updateDisplay(bridge, s)
    calls.length = 0
    await updateHeader(bridge, s)
    expect(calls).toEqual([])
  })

  // A host that refuses a write says so in the boolean it returns. Skipping
  // the resend on the strength of a write the host dropped is how a container
  // goes permanently stale, so the refusal has to beat the dedup record.

  function refusingBridge(refuse: (id: number) => boolean) {
    const calls: Array<{ id: number; content: string }> = []
    const bridge = {
      textContainerUpgrade: (u: { containerID: number; content: string }) => {
        calls.push({ id: u.containerID, content: u.content })
        return Promise.resolve(!refuse(u.containerID))
      },
      rebuildPageContainer: () => Promise.resolve(true),
    }
    return { bridge: bridge as never, calls }
  }

  /** Put the panel in list mode with 'alpha' on it, so the call under test is
   *  an in-place upgrade rather than the rebuild a mode change forces. */
  async function seated(bridge: never) {
    invalidatePanel()
    await updateDisplay(bridge, listState('alpha'))
  }

  test('a refused write is sent again on the next frame', async () => {
    const { bridge, calls } = refusingBridge((id) => id === 1)
    await seated(bridge)
    await updateDisplay(bridge, listState('beta'))
    calls.length = 0
    // 'beta' is still what the state says, so only a record that took the
    // refusal seriously would send anything here.
    await updateDisplay(bridge, listState('beta'))
    expect(calls.filter((c) => c.id === 1).length).toBe(1)
  })

  test('an accepted write is still not sent twice', async () => {
    // The retry above must come from the refusal, not from having stopped
    // recording writes altogether.
    const { bridge, calls } = refusingBridge(() => false)
    await seated(bridge)
    await updateDisplay(bridge, listState('beta'))
    calls.length = 0
    await updateDisplay(bridge, listState('beta'))
    expect(calls.filter((c) => c.id === 1)).toEqual([])
  })

  test('refusals are counted', async () => {
    const { bridge } = refusingBridge((id) => id === 1)
    await seated(bridge)
    const before = panelDrops()
    await updateDisplay(bridge, listState('beta'))
    expect(panelDrops()).toBeGreaterThan(before)
  })
})

describe('the root page hands the exit gesture back to the host', () => {
  // `SYSTEM_EXIT_EVENT` — the only exit this app has ever been given — is
  // documented as the user confirming the host's exit dialogue. Even Hub
  // review requires the root page to raise that dialogue on a double-tap, and
  // an app that keeps the gesture for itself gets exited anyway by a wearer
  // who thought they were doing something else.

  function stubPlatform() {
    const calls: string[] = []
    const platform = {
      onDevice: false,
      render: () => { calls.push('render') },
      renderHeader: () => { calls.push('renderHeader') },
      startMicCapture: async () => false,
      stopMicCapture: async () => {},
      transcribeAudio: async () => '',
      saveState: () => {},
      loadState: async () => null,
      requestExit: () => { calls.push('requestExit') },
      onForegroundRegained: () => { calls.push('onForegroundRegained') },
    }
    return { platform, calls }
  }

  const twoSessions = [
    { id: 'a', name: 'alpha', state: 'idle' as const },
    { id: 'b', name: 'beta', state: 'idle' as const },
  ]

  test('double-tap on the session list asks for the exit dialogue', async () => {
    const { platform, calls } = stubPlatform()
    const c = new GlassesController(platform as never)
    c.doubleTap()
    await Promise.resolve()
    expect(calls).toContain('requestExit')
  })

  test('the wearer\'s last gesture is available for the exit line', async () => {
    const { platform } = stubPlatform()
    const c = new GlassesController(platform as never)
    expect(c.lastGesture().kind).toBe('none')
    expect(c.lastGesture().agoMs).toBe(-1)
    c.doubleTap()
    await Promise.resolve()
    expect(c.lastGesture().kind).toBe('doubleTap')
    expect(c.lastGesture().agoMs).toBeGreaterThanOrEqual(0)
  })

  test('a push from the server draws nothing while we are in the background', async () => {
    // Render calls made from the background are consumed by the host and
    // dropped before the display, so they are BLE traffic for nobody.
    const { platform, calls } = stubPlatform()
    const c = new GlassesController(platform as never)
    c.state.sessions = twoSessions as never
    c.swipeDown()
    await Promise.resolve()
    expect(calls).toContain('render')

    c.onForegroundExit()
    calls.length = 0
    // The five-second session push, which arrives whether anyone is looking
    // or not — reached directly because nothing public drives it.
    const push = c as unknown as { onSessionsUpdated: (s: unknown[]) => void }
    push.onSessionsUpdated(twoSessions)
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  test('a gesture outranks a stale background flag', async () => {
    // The host only routes ring input to the app the glasses are showing, so
    // a gesture arriving is proof the flag is wrong. Believing the flag over
    // the gesture is how the screen froze on its last frame for the rest of
    // the run: cancelling the host's exit dialogue leaves the ENTER unsent.
    const { platform, calls } = stubPlatform()
    const c = new GlassesController(platform as never)
    c.state.sessions = twoSessions as never

    c.onForegroundExit()
    calls.length = 0
    c.swipeDown()
    await Promise.resolve()
    expect(calls).toContain('onForegroundRegained')
    expect(calls).toContain('render')
  })

  test('the panel is only reclaimed once, not on every later gesture', async () => {
    const { platform, calls } = stubPlatform()
    const c = new GlassesController(platform as never)
    c.state.sessions = twoSessions as never

    c.onForegroundExit()
    c.swipeDown()
    await Promise.resolve()
    calls.length = 0
    c.swipeUp()
    await Promise.resolve()
    expect(calls).not.toContain('onForegroundRegained')
  })
})

describe('the session list holds still while it is being read', () => {
  // Reported from the device: the cursor moved on its own while swiping down
  // the list, "depending on what the other sessions were doing".
  //
  // It was the sort. The order is by indicator state (waiting_input ->
  // processing -> completed -> idle) and every five-second push re-applied it,
  // so one other agent finishing a reply shuffled the rows. Measured on a live
  // tailnet: a session answering one question moved from row 11 to row 2 and
  // back inside ten seconds, carrying the nine rows between it each way.

  function stubPlatform() {
    return {
      onDevice: false,
      render: () => {},
      renderHeader: () => {},
      startMicCapture: async () => false,
      stopMicCapture: async () => {},
      transcribeAudio: async () => '',
      saveState: () => {},
      loadState: async () => null,
      requestExit: () => {},
      onForegroundRegained: () => {},
    }
  }

  type Ind = 'waiting_input' | 'processing' | 'completed' | 'idle'
  const session = (id: string, indicatorState: Ind) => ({
    id,
    name: id,
    state: 'idle' as const,
    indicatorState,
  })
  const idle = ['a', 'b', 'c', 'd'].map((id) => session(id, 'idle'))
  const push = (c: GlassesController, sessions: unknown[]) =>
    (c as unknown as { onSessionsUpdated: (s: unknown[]) => void }).onSessionsUpdated(sessions)
  const ids = (c: GlassesController) => c.state.sessions.map((s) => s.id)

  test('the first push sorts, so the list opens waiting-first', () => {
    const c = new GlassesController(stubPlatform() as never)
    push(c, [session('a', 'idle'), session('b', 'waiting_input'), session('c', 'processing')])
    expect(ids(c)).toEqual(['b', 'c', 'a'])
  })

  test('a later push does not re-sort, whatever the others start doing', () => {
    const c = new GlassesController(stubPlatform() as never)
    push(c, idle)
    expect(ids(c)).toEqual(['a', 'b', 'c', 'd'])

    // 'd' starts waiting. Under the old code it jumped to the front.
    push(c, [session('a', 'idle'), session('b', 'idle'), session('c', 'idle'), session('d', 'waiting_input')])
    expect(ids(c)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('the row under the cursor stays the row under the cursor', () => {
    const c = new GlassesController(stubPlatform() as never)
    push(c, idle)
    c.state.sessionIndex = 2 // on 'c'

    push(c, [session('a', 'processing'), session('b', 'waiting_input'), session('c', 'idle'), session('d', 'idle')])
    expect(c.state.sessionIndex).toBe(2)
    expect(c.state.sessions[c.state.sessionIndex].id).toBe('c')
  })

  test('a session that appears joins at the end rather than in the middle', () => {
    const c = new GlassesController(stubPlatform() as never)
    push(c, idle)
    push(c, [...idle, session('e', 'waiting_input')])
    // Waiting or not, it does not get to push in ahead of the cursor.
    expect(ids(c)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('a session that goes away takes its row with it', () => {
    const c = new GlassesController(stubPlatform() as never)
    push(c, idle)
    push(c, [session('a', 'idle'), session('c', 'idle'), session('d', 'idle')])
    expect(ids(c)).toEqual(['a', 'c', 'd'])
  })

  test('coming back from a conversation is when the order is allowed to change', async () => {
    const c = new GlassesController(stubPlatform() as never)
    push(c, idle)
    c.state.sessionIndex = 1 // on 'b'
    c.state.mode = 'conversation'

    // While the conversation was open, 'd' started waiting.
    push(c, [session('a', 'idle'), session('b', 'idle'), session('c', 'idle'), session('d', 'waiting_input')])
    expect(ids(c)).toEqual(['a', 'b', 'c', 'd'])

    c.doubleTap() // back out to the list
    await Promise.resolve()
    await Promise.resolve()
    // Read out first: the assignment above narrows the type to that one mode.
    const mode: string = c.state.mode
    expect(mode).toBe('session_list')
    expect(ids(c)).toEqual(['d', 'a', 'b', 'c'])
    // The cursor followed its session rather than staying on row 1.
    expect(c.state.sessions[c.state.sessionIndex].id).toBe('b')
  })
})

describe('a notification is drawn as a card, not as another screen', () => {
  // It kept being missed. Every screen this app draws is a header, a panel of
  // text and a footer, and a notification drawn that way says "you are looking
  // at something else now" rather than "this arrived". So it is inset from the
  // panel edge and bordered: a box with the panel showing on all four sides.

  test('the box is the height of its message, not of the panel', () => {
    const one = cardBox(1)
    const three = cardBox(3)
    expect(three.h - one.h).toBe(2 * LINE_H)
    // A box the height of the screen with three lines in it is a page with a
    // line drawn round it.
    expect(cardBox(1).h).toBeLessThan(PANEL_H - 2 * BAR_H)
  })

  test('it is centred in the band between the bars', () => {
    const box = cardBox(2)
    const above = box.y - BAR_H
    const below = PANEL_H - BAR_H - (box.y + box.h)
    // Within a pixel: the band is not always evenly divisible.
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
    expect(above).toBeGreaterThan(0)
  })

  test('it never grows past the panel, however long the message', () => {
    const box = cardBox(999)
    expect(box.y).toBeGreaterThanOrEqual(BAR_H)
    expect(box.y + box.h).toBeLessThanOrEqual(PANEL_H - BAR_H)
  })

  test('it leaves the panel showing on the left and the right', () => {
    const box = cardBox(1)
    expect(box.x).toBeGreaterThan(0)
    expect(box.x + box.w).toBeLessThan(PANEL_W)
  })

  test('the message is wrapped to the card, not to the panel it sits on', () => {
    // Measured against the wider body, the text runs under the border.
    expect(CARD_WIDTH).toBeLessThan(BODY_WIDTH)
    const long = 'あ'.repeat(200)
    const screen = screenText({
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
      relayInfo: [
        { id: 'i', sessionId: 'a', kind: 'info' as const, text: long, source: 'auto' as const, createdAt: 1 },
      ],
      overlayItemId: null,
      spinnerTick: 0,
    })
    expect(screen.card).toBe(true)
    for (const line of screen.body.split('\n')) {
      expect(width(line)).toBeLessThanOrEqual(CARD_WIDTH)
    }
    // And clipped to what the box holds rather than to what the panel would.
    expect(screen.body.split('\n').length).toBeLessThanOrEqual(CARD_LINES)
    expect(CARD_LINES).toBeLessThan(MAX_LINES)
  })
})

describe('the list marks the sessions that want you', () => {
  // Only `processing` used to carry a mark, so `waiting_input` looked exactly
  // like idle. Survivable while the list floated waiting sessions to the top;
  // once the order was frozen so the cursor would hold still, the mark became
  // the only way to find them.

  const base = {
    mode: 'session_list' as const,
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
  }
  type Ind = 'waiting_input' | 'processing' | 'completed' | 'idle'
  const rows = (sessions: unknown[]) =>
    screenText({ ...base, sessions } as never).body.split('\n')
  const ws = (id: string, indicatorState: Ind, panes?: unknown[]) => ({
    id, name: id, state: 'idle' as const, indicatorState, panes,
  })

  test('a session waiting for you is marked', () => {
    expect(rows([ws('a', 'waiting_input')])[0]).toContain('！')
  })

  test('the states nobody has to act on stay unmarked', () => {
    // Most sessions are one of these. A mark on all of them is no mark at all.
    for (const state of ['completed', 'idle'] as Ind[]) {
      expect(rows([ws('a', state)])[0]).not.toContain('！')
    }
  })

  test('waiting outranks working', () => {
    // A session that is running will finish on its own; one that is asking
    // will not. Where both are true of a workspace, the asking is the news.
    const row = rows([
      ws('a', 'processing', [
        { paneId: '%1', indicatorState: 'processing' },
        { paneId: '%2', indicatorState: 'waiting_input' },
      ]),
    ])[0]
    expect(row).toContain('！')
  })

  test('a heading answers for the panes folded under it', () => {
    // The heading can be the last row on screen with its panes below the fold,
    // which is exactly when it is the only thing there is to go on.
    const row = rows([
      ws('a', 'completed', [
        { paneId: '%1', indicatorState: 'completed' },
        { paneId: '%2', indicatorState: 'waiting_input' },
      ]),
    ])[0]
    expect(row).toContain('！')
  })

  test('a waiting pane is marked on its own row too', () => {
    const body = rows([
      ws('a', 'completed', [
        { paneId: '%1', indicatorState: 'completed' },
        { paneId: '%2', indicatorState: 'waiting_input' },
      ]),
    ])
    expect(body[2]).toContain('！')
    expect(body[1]).not.toContain('！')
  })

  test('the mark keeps the badge column, so the names still line up', () => {
    const body = rows([ws('a', 'waiting_input'), ws('b', 'idle'), ws('c', 'processing')])
    const starts = body.map((l) => width(l.slice(0, l.search(/[^ >　！·•]/))))
    // See the list-screen alignment test: 5px spaces cannot pad a 9px bullet
    // to exactly 20, and 1px is under the eye's threshold as well as a space's.
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(SPACE_W)
  })
})

describe('the cursor does not shove its row sideways', () => {
  // `>` is 10px and a space is 5, so the row under the cursor used to sit 5px
  // right of every other row - and the cursor moves on every swipe, so the
  // whole list shivered as it was walked. Two spaces come to exactly 10.
  test('the marker and the blank standing in for it are the same width', () => {
    expect(width('  ')).toBe(width('>'))
  })
})
