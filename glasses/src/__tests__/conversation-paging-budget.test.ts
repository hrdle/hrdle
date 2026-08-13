import { describe, expect, test } from 'bun:test'
;(globalThis as unknown as { __STORAGE_PREFIX__: string }).__STORAGE_PREFIX__ = 'hrdle-'

import { conversationLines, conversationPageBudget, conversationPageText, getTotalPagesAt, screenText } from '../display'
import type { AppState } from '../display'
import type { ConversationMessage } from '../../../shared/types'

/**
 * Paging and drawing have to agree on how many lines there are.
 *
 * A notice takes its share of the panel first, so the conversation draws
 * `conversationLines(notice)` and not the panel's own `MAX_LINES`. Paging by
 * the larger number while drawing the smaller one tore a hole at every
 * boundary: the body clipped its tail, and the next page began past it.
 *
 * Recorded on 2026-08-08 with a waiting banner up. The agent's answer offered
 * three proposals; the wearer got the first, then page 2 resumed inside the
 * third, with the whole of the second proposal and the third one's heading on
 * no page at all - and nothing on screen to say so.
 */

/** The message from that recording, verbatim from the kimi wire. */
const THREE_PROPOSALS = `その軸で3案:

**案1 — 目標をそのまま**
> 目指しているのはひとつです。PC でできることを、PC なしで全部できるようにすること。

**案2 — 仲介者とつなげる**
> PC でできることを、PC なしで全部。そのために、あなたとコンピューターの間の往復を全部仲介します。

**案3 — 中身を一言添える**
> PC の前でやること——指示する、見る、答える——を、PC なしで全部できるようにする仲介者です。

番号か、言い方の続きをどうぞ。`

const msgs: ConversationMessage[] = [{ role: 'assistant', content: THREE_PROPOSALS }]

describe('conversation paging uses the lines the body actually draws', () => {
  test('a notice leaves fewer lines, and the page count grows to match', () => {
    const full = conversationLines(0)
    const withNotice = conversationLines(2)
    expect(withNotice).toBeLessThan(full)

    const pagesFull = getTotalPagesAt(msgs, 0, full)
    const pagesNotice = getTotalPagesAt(msgs, 0, withNotice)
    // Fewer lines per page cannot mean fewer pages.
    expect(pagesNotice).toBeGreaterThanOrEqual(pagesFull)
  })

  test('every line of the message appears on exactly one page', () => {
    for (const lines of [conversationLines(0), conversationLines(1), conversationLines(2), conversationLines(3)]) {
      const pages = getTotalPagesAt(msgs, 0, lines)
      const seen: string[] = []
      for (let p = 0; p < pages; p++) {
        // Read the same way the body does: the page's text, clipped to what
        // fits, which is what the container draws.
        const text = conversationPageText(msgs, 0, p, lines)
        seen.push(...text.split('\n').slice(0, lines))
      }
      // Nothing from the source may be missing. Checked on the words that
      // vanished in the recording, with the wrapping taken back out - a page
      // break inside a sentence is fine, a sentence on no page is not.
      const joined = seen.join('')
      expect(joined).toContain('案2 — 仲介者とつなげる')
      expect(joined).toContain('あなたとコンピューターの間の往復を全部仲介します')
      expect(joined).toContain('案3 — 中身を一言添える')
      expect(joined).toContain('番号か、言い方の続きをどうぞ。')
    }
  })
})

/**
 * The same hole by a second route: the budget differs between one page and the
 * next.
 *
 * The recap heads the newest view and goes on the first swipe, so page 1 draws
 * `conversationLines(2)` and every page after it `conversationLines(0)`. Tiled
 * at whichever number the current page has, page 1 covered lines 0-4 of 8-line
 * pages and page 2 opened at line 8 - lines 5, 6 and 7 on no page.
 *
 * Recorded on 2026-08-14 in `hail 設計`: the footer said `p1/8`, the next swipe
 * said `p2/5`, and the first item of a numbered list could not be reached.
 */
const HAIL_OVERVIEW = `一枚ものを作りました。

**https://claude.ai/code/artifact/f58368e4-d2d6-4a97-bd7e-6cbe885c1ac2**

## 構成

設計の詳細は全部落として、**「何を解決するか」と「売り」**に絞りました。

1. **何を解決するか** — メールサーバか SendGrid かの二択。図1点で送信経路を比較
2. **売り** — 8項目（POST 1本 / 黙って失敗しない / 失効が効く / スパムが構造的に無い / 名寄せされない / 例外なく E2E / 持ち出せる / エージェントが対等）
3. **メールとの比較**（送る側）
4. **用途の半分は消滅する** — 本人確認・パスワードリセット・2FA は鍵があれば不要
5. **どう届くか** — POST の実物
6. **使う側から見た形** — Slack / メール / hail の情報構造比較
7. **正直な弱点**
8. **作る順** と **土台**`

const hail: ConversationMessage[] = [{ role: 'assistant', content: HAIL_OVERVIEW }]

describe('a recap on the first page only', () => {
  const budget = { first: conversationLines(2), rest: conversationLines(0) }

  test('the pages tile even though the first one is shorter', () => {
    const pages = getTotalPagesAt(hail, 0, budget)
    const seen: string[] = []
    for (let p = 0; p < pages; p++) {
      const lines = p === 0 ? budget.first : budget.rest
      seen.push(...conversationPageText(hail, 0, p, budget).split('\n').slice(0, lines))
    }
    const joined = seen.join('')
    // The three lines that were on no page in the recording.
    expect(joined).toContain('絞りました')
    expect(joined).toContain('何を解決するか')
    expect(joined).toContain('メールサーバか SendGrid かの二択')
    // And the rest of it, so a fix that pages by the smaller number everywhere
    // (which also tiles) does not pass by clipping the tail instead.
    expect(joined).toContain('作る順')
  })

  test('the page count does not change as the reader pages through', () => {
    const pages = getTotalPagesAt(hail, 0, budget)
    // `p1/8` then `p2/5` was the symptom on screen: two tilings, one message.
    expect(getTotalPagesAt(hail, 0, budget.rest)).toBeLessThanOrEqual(pages)
    expect(pages).toBeLessThanOrEqual(getTotalPagesAt(hail, 0, budget.first))
  })
})

/** The state the recording was in: a claude summary up, on the newest message. */
function recapState(): AppState {
  return {
    mode: 'conversation',
    sessions: [{
      id: 'w69',
      name: 'hail 設計',
      state: 'active',
      ccRecap: 'hail の一枚ものを書き、docs に置くか確認待ち',
      ccRecapAt: '2026-08-14T06:55:00.000Z',
      ccRecapKind: 'summary',
    }],
    sessionIndex: 0,
    selectedPaneId: null,
    conversation: hail,
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 20,
    conversationHasMore: false,
    conversationLoading: false,
    choiceOptions: [],
    choiceIndex: 0,
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    spinnerTick: 0,
  } as unknown as AppState
}

describe('reading a long message with the recap up', () => {
  test('the wearer can reach every line by swiping', () => {
    const st = recapState()
    expect(screenText(st).notice).toContain('hail の一枚もの')

    const pages = getTotalPagesAt(st.conversation, 0, conversationPageBudget(st))
    const read: string[] = []
    for (let p = 0; p < pages; p++) {
      st.conversationPage = p
      read.push(screenText(st).body)
    }
    const joined = read.join('')
    expect(joined).toContain('絞りました')
    expect(joined).toContain('メールサーバか SendGrid かの二択')
    expect(joined).toContain('作る順')
  })

  test('the footer promises the same number of pages on every one of them', () => {
    const st = recapState()
    const promised = new Set<string>()
    const pages = getTotalPagesAt(st.conversation, 0, conversationPageBudget(st))
    for (let p = 0; p < pages; p++) {
      st.conversationPage = p
      const footer = screenText(st).footer
      const denominator = footer.match(/p\d+\/(\d+)/)?.[1]
      if (denominator) promised.add(denominator)
    }
    expect(promised.size).toBe(1)
    expect([...promised][0]).toBe(String(pages))
  })
})
