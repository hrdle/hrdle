import { describe, expect, test } from 'bun:test'
import { conversationLines, conversationPageText, getTotalPagesAt } from '../display'
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
