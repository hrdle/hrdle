import { describe, expect, test } from 'bun:test'
import { sanitizeForG2, formatMessage } from '../types.ts'
import { screenText, wrapForPanel, wrapHeader } from '../display.ts'
import { BODY_WIDTH, HEADER_WIDTH, textWidth as width } from '../metrics.ts'

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
    expect(out).toBe('A> [Bash] テストを流す')
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

/** One space of granularity: the gap is padded with 5px spaces. */
const SPACE_SLACK = 6

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
    for (const mode of ['session_list', 'conversation', 'choice', 'voice', 'overlay'] as const) {
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
      expect(width(header)).toBeGreaterThan(HEADER_WIDTH - SPACE_SLACK)
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
    const starts = screenText(state)
      .body.split('\n')
      .map((l) => l.search(/[^ >[\]!*]/))
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
