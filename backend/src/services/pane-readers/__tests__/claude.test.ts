// Reading claude's picker off the pane, and refusing everything else.
//
// The reader this replaces looked for a shape - a run of lines beginning `1.`,
// `2.`, `3.` - and every agent's *output* has that shape too. Both fixtures
// below were captured from live panes on 2026-08-12, one of each kind, within
// an hour of each other. The second one reached a wearer's face.

import { describe, expect, test } from 'bun:test';
import { readClaudePicker } from '../claude';

/**
 * A question on screen. Captured from `/home/m0a/linux`'s pane: a preview panel
 * shares rows with the options, an unanswerable row sits below the closing
 * rule, and the question ends in a full-width mark.
 */
const PICKER = [
  '  Ran 1 shell command ',
  '● 保存済みの認証情報はありません。パスワードの渡し方を選んでください。',
  '────────────────────────────────────────────────────────────────',
  ' ☐ 認証情報 ',
  '',
  'ルータ管理画面（admin）のパスワードをどう渡しますか？',
  '',
  ' 1. vaultに自分で保存（推奨）    ┌─────────────────────────┐',
  ' 2. チャットで直接教える         │ No preview available    │',
  '❯ 3. ルータ操作は中止             └─────────────────────────┘',
  '',
  '                                  Notes: press n to add notes',
  '',
  '────────────────────────────────────────────────────────────────',
  '  Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
];

/**
 * No question on screen. The same pane twenty minutes later: the agent has
 * written its options out in prose, which is a thing agents do constantly, and
 * the shape-matching reader served four of them as a menu.
 */
const PROSE = [
  '  - スマホ: ロック中のまま。300秒のタイムアウトで待機終了',
  '  - vault は空のまま、認証情報はどこにも保存されていません',
  '',
  '  どうしますか',
  '',
  '  1. スマホでもう一度 — 再度待機します。今度は手元にあるタイミングで',
  '  2. vault方式 — ご自身の別ターミナルで実行（チャットに残りません）',
  '  3. チャットで直接 — 手軽。後でルータのパスワードを変える前提なら',
  '  4. 保留にして補足報告を先に書く —',
  '',
  '✻ Worked for 45s',
  '',
  '────────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
];

/** A `grep` scrolling past. Offered to a wearer on 2026-08-12 as a two-row
 *  picker reading `71` / `const INFO_TTL_MS = 5 * 60_000;`. */
const LISTING = [
  '  35:const MAX_TEXT_WIDTH = 120;',
  '  36:const MAX_CHOICES = 9;',
  '',
  '  71. const INFO_TTL_MS = 5 * 60_000;',
  '  72. const HOOK_INFO_TTL_MS = 90_000;',
  '',
];

describe('a question on screen', () => {
  const picker = readClaudePicker(PICKER);

  test('the options are the rows, without the panel beside them', () => {
    expect(picker?.options.map((o) => o.label)).toEqual([
      'vaultに自分で保存（推奨）',
      'チャットで直接教える',
      'ルータ操作は中止',
    ]);
  });

  test('the question needs no question mark to be found', () => {
    // Everything between the chip and the first option is the question - the
    // frame said so. Searching for a mark instead is what made a full-width
    // `？` read as no question at all.
    expect(picker?.question).toBe('ルータ管理画面（admin）のパスワードをどう渡しますか？');
  });

  test('an unnumbered row below the rule is not an option', () => {
    // This pane draws `Chat about this` with no number of its own, and a row
    // with no key is not one a digit can reach. Claude numbers it on other
    // questions, and there it is offered - see the text-entry row below.
    expect(picker?.options.map((o) => o.label)).not.toContain('Chat about this');
  });

  test('`Notes: press n to add notes` is not a description', () => {
    expect(picker?.options.every((o) => !o.detail.includes('Notes'))).toBe(true);
  });
});

describe('no question on screen', () => {
  test("the agent's own prose is not a menu", () => {
    expect(readClaudePicker(PROSE)).toBeUndefined();
  });

  test('a listing is not a menu', () => {
    expect(readClaudePicker(LISTING)).toBeUndefined();
  });

  test('the footer alone is not enough', () => {
    // Neither half of the frame stands on its own: this is the footer with no
    // chip above it, which is what a pane looks like a moment after a question
    // has been answered and scrolled.
    expect(readClaudePicker([...PROSE, 'Enter to select · ↑/↓ to navigate'])).toBeUndefined();
  });

  test('a chip alone is not enough', () => {
    expect(readClaudePicker([' ☐ 移行範囲 ', ' 1. A', ' 2. B'])).toBeUndefined();
  });
});

describe('descriptions', () => {
  const described = readClaudePicker([
    '────────────────────────────',
    ' ☐ 移行範囲 ',
    '',
    '種モデル（起動時に共通設定を取り込んで以降はワークスペ',
    'ース所有）に移行するとして、既存の14ワークスペースはど',
    'うしますか?',
    '',
    '❯ 1. 新規ワークスペースから適用（推奨）',
    '     既存は今の共有グロサリー + ',
    '     辞退可能のまま',
    '  2. 全ワークスペースに今書き込む',
    '     14ワークスペースに116文字ずつコピーする',
    '  3. Type something.',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]);

  test('the lines under a row belong to it, rejoined', () => {
    expect(described?.options[0].detail).toBe('既存は今の共有グロサリー + 辞退可能のまま');
  });

  test('a wrap inside CJK is rejoined without a space', () => {
    expect(described?.question).toBe(
      '種モデル（起動時に共通設定を取り込んで以降はワークスペース所有）に移行するとして、既存の14ワークスペースはどうしますか?',
    );
  });

  test('each row keeps its own', () => {
    expect(described?.options.map((o) => o.detail)).toEqual([
      '既存は今の共有グロサリー + 辞退可能のまま',
      '14ワークスペースに116文字ずつコピーする',
      '',
    ]);
  });

  test('the text-entry row comes last and is marked', () => {
    expect(described?.options.at(-1)).toMatchObject({ label: 'Type something.', freeText: true });
  });
});

describe('a call carrying several questions', () => {
  // The pane draws a chip each and moves between them with rows of its own.
  // Those rows were what a wearer answered two questions of three with; the
  // front tab's options keep their own numbers once they are gone.
  const tabbed = readClaudePicker([
    '────────────────────────────',
    ' ☑ 移行範囲   ☐ 適用時期 ',
    '',
    'いつ適用しますか?',
    '',
    '❯ 1. すぐ',
    '  2. 次のリリースで',
    '  3. Next',
    '  4. Submit answers',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]);

  test('the tab rows are not options', () => {
    expect(tabbed?.options.map((o) => o.label)).toEqual(['すぐ', '次のリリースで']);
  });
});

describe('a multi-select', () => {
  const multi = readClaudePicker([
    '────────────────────────────',
    ' ☐ 対象 ',
    '',
    'どれを含めますか?',
    '',
    '❯ 1. [ ] りんご',
    '  2. [ ] みかん',
    '  3. [x] ぶどう',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]);

  test('the box travels on the row', () => {
    // It is what `looksMultiSelect` reads on the other side; without it the
    // picker opens a multi-select as a single pick and closes after one digit.
    expect(multi?.options.map((o) => o.label)).toEqual(['[ ] りんご', '[ ] みかん', '[x] ぶどう']);
    expect(multi?.multiSelect).toBe(true);
  });
});

/**
 * A multi-select as Claude Code 2.1.228 actually draws one, captured live on
 * 2026-08-12. The fixture above was written by hand and passed throughout,
 * which is why this went unnoticed: a multi-select adds a `✔ Submit` tab, and a
 * strip with two tabs carries the keys that move between them. Every
 * multi-select there has ever been read as "not this screen", so nothing
 * reached the glasses - not the options, not even the question.
 */
const MULTI_LIVE = [
  '❯ AskUserQuestion ツールで、multiSelect: true の質問を1つ出してください。選択肢は4つ',
  '────────────────────────────────────────────────────────',
  '←  ☐ 機能選択  ✔ Submit  →',
  '',
  '有効にする機能をすべて選んでください',
  '',
  '❯ 1. [ ] 認証機能',
  '  メールとパスワードによるログインとセッション管理を実装します。',
  '  2. [ ] 通知',
  '  メールとアプリ内通知の両方に対応します。',
  '  3. [ ] ダークモード',
  '  OSの設定に追従する配色切り替えを追加します。',
  '  4. [ ] 多言語対応',
  '  日本語と英語の切り替えに対応します。',
  '  5. [ ] Type something',
  '     Submit',
  '────────────────────────────────────────────────────────',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
];

describe('a row named after the picker\'s own', () => {
  // `Chat about this` is drawn at the foot of every question, so the wording is
  // claude's - but it is ordinary enough for an agent to write, and one did:
  // a question about this very behaviour listed it third. Tapped, the wearer
  // got the microphone instead of the box ticking.
  const named = readClaudePicker([
    '────────────────────────────',
    ' ☐ 確認項目 ',
    '',
    '確認したい挙動をすべて選んでください',
    '',
    '❯ 1. [ ] 音声入力',
    '  2. [ ] Chat about this',
    '  3. [ ] Type something',
    '────────────────────────────',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]);

  test('it answers like any other option where an agent wrote it', () => {
    expect(named?.options[1]).toMatchObject({ label: '[ ] Chat about this' });
    expect(named?.options[1].freeText).toBeUndefined();
  });

  test('the picker\'s own, at the foot of the list, still opens the microphone', () => {
    expect(named?.options.at(-1)).toMatchObject({ label: 'Chat about this', freeText: true });
  });

  test('a row that means it wherever it is drawn keeps meaning it', () => {
    expect(named?.options[2]).toMatchObject({ label: '[ ] Type something', freeText: true });
  });
});

/**
 * The screen Send opens on a multi-select, captured live on 2026-08-12 right
 * after a wearer pressed it. The pane moved here and the glasses kept showing
 * the list from before, so Send looked like it had done nothing at all.
 */
const REVIEW_PANE = [
  '──────────────────────────────────────────────────────────',
  '←  ☒ 次の作業  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  ' ● 次に進めたい作業をすべて選んでください',
  '   → コード修正, テスト追加,',
  '   私のメッセージ適当に書き込んでいるのでよろしくお願いします',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
  '',
];

describe('the screen Send opens', () => {
  const review = readClaudePicker(REVIEW_PANE);

  test('it is read though the picker draws no footer on it', () => {
    expect(review?.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
  });

  test('rows that are furniture everywhere else are the answer here', () => {
    // Filtered as furniture, both rows go and the reader returns nothing - and
    // a read that returns nothing leaves the list from before the Send on the
    // glasses. Hence a screen of its own rather than a relaxed filter.
    expect(review?.options.length).toBe(2);
  });

  test('the row the pane is sitting on travels with it', () => {
    expect(review?.choiceCursor).toBe(0);
  });

  test('what was picked is not read back onto the panel', () => {
    // Eight lines, and the two rows that finish the answer have to fit on them.
    expect(review?.question).toBe('Ready to submit your answers?');
  });
});

describe('a list the pane draws no Submit button under', () => {
  test('nothing is named, and the app keeps its own Tab', () => {
    // A single pick is finished by picking, so there is no button to walk to.
    // Naming a walk anyway would be naming one measured from nothing.
    const single = readClaudePicker([
      '────────────────────────────',
      ' \u2610 移行範囲 ',
      '',
      'どちらにしますか?',
      '',
      '❯ 1. すぐ',
      '  2. 次のリリースで',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]);
    expect(single?.options).toHaveLength(2);
    expect(single?.choiceSend).toBeUndefined();
  });
});

describe('a multi-select on a real pane', () => {
  const live = readClaudePicker(MULTI_LIVE);

  test('the tab strip is read as the chip it is', () => {
    expect(live).toBeDefined();
    expect(live?.multiSelect).toBe(true);
  });

  test('every row is offered, the text-entry ones marked', () => {
    expect(live?.options.map((o) => o.label)).toEqual([
      '[ ] 認証機能',
      '[ ] 通知',
      '[ ] ダークモード',
      '[ ] 多言語対応',
      '[ ] Type something',
      'Chat about this',
    ]);
    expect(live?.options.filter((o) => o.freeText).length).toBe(2);
  });

  test('the question is what sits between the strip and the rows', () => {
    expect(live?.question).toBe('有効にする機能をすべて選んでください');
  });

  test('every row keeps what it says about itself', () => {
    // A single-pick list indents its descriptions past the label text; this one
    // puts them at the row's own left edge, under the checkbox. Read as
    // "strictly further right than the label", only the first row - the one the
    // cursor sits on, drawn without the indent the others need - kept its own.
    expect(live?.options.slice(0, 4).map((o) => o.detail)).toEqual([
      'メールとパスワードによるログインとセッション管理を実装します。',
      'メールとアプリ内通知の両方に対応します。',
      'OSの設定に追従する配色切り替えを追加します。',
      '日本語と英語の切り替えに対応します。',
    ]);
  });

  test('the chip changes the moment a box is ticked, and is still a chip', () => {
    // `☐` becomes `☒` on the first pick. Missing that glyph, the reader saw
    // this picker until the wearer's first tap and not afterwards - and a
    // re-read that finds nothing leaves the item already on the glasses, which
    // is the one built before anything was ticked. So every box came back
    // empty, every time, and the picker looked like it would not hold a
    // selection at all.
    const ticked = readClaudePicker(
      MULTI_LIVE.map((l) => l.replace('☐ 機能選択', '☒ 機能選択').replace('2. [ ] 通知', '2. [✔] 通知')),
    );
    expect(ticked?.options[1].label).toBe('[✔] 通知');
  });

  test('the button that finishes it is walked to and pressed', () => {
    // The app's Send row used to be a Tab, which from inside the list moves the
    // pane's cursor onto this button and stops - pressing it again changes
    // nothing, while the app treats the send as done and leaves the picker. So
    // Send did nothing at all and the question stayed open.
    //
    // Five rows down from the cursor, then Enter. The button is not an option
    // and is not in the list, but the pane's cursor stops on it, so it counts
    // as a row for the walk and not for the choosing.
    expect(live?.choiceSend).toBe('\x1b[B'.repeat(5) + '\r');
  });

  test('the pane already sitting on the button is a walk of nothing', () => {
    // Which is where the pane is left the moment a Send lands, so it is the
    // state the next read sees. The marker is drawn at the left edge, so the
    // row measures as further left than the ones around it - measured
    // literally, the button was thrown away as furniture and the walk that had
    // just reached it could not be named again.
    const at = readClaudePicker(MULTI_LIVE.map((l) => l.replace('     Submit', '❯    Submit')));
    expect(at?.choiceSend).toBe('\r');
  });

  test('the button the list is finished with is not a description', () => {
    // `Submit` sits under the last row at a description's indent, so it read as
    // one: `Type something — Submit`.
    expect(live?.options[4].detail).toBe('');
  });

  test('the row the pane is sitting on travels', () => {
    // The walk to `Type something` starts here. Measured rather than assumed:
    // digits leave the cursor where it was, so after a wearer has ticked two
    // boxes it is still on the row it opened on - and the app cannot know which
    // that was without being told.
    expect(live?.choiceCursor).toBe(0);
  });
});

/**
 * The same pane after the wearer has walked down to the text row.
 *
 * `Type something` is a field, not a checkbox that opens one: typing while the
 * cursor is on it replaces the label and ticks the box in one go, and the
 * footer gains `ctrl+g to edit in Vim` to say so. Ticking it by its digit and
 * submitting was measured on Claude Code 2.1.228 returning an answer with
 * nothing in it, which is the bug this index exists to fix.
 */
const MULTI_ON_TEXT_ROW = MULTI_LIVE.map((l) =>
  l === '❯ 1. [ ] 認証機能'
    ? '  1. [ ] 認証機能'
    : l === '  5. [ ] Type something'
      ? '❯ 5. [ ] Type something'
      : l,
);

describe('a multi-select with the cursor on its text row', () => {
  const live = readClaudePicker(MULTI_ON_TEXT_ROW);

  test('the cursor is read where the pane drew it', () => {
    expect(live?.choiceCursor).toBe(4);
    expect(live?.options[4].label).toBe('[ ] Type something');
  });
});

describe('a single-pick list', () => {
  test('the cursor counts the rows the glasses will show, not the pane', () => {
    // `Chat about this` is dropped as furniture on this pane, and every row
    // after a dropped one shifts. Nothing is dropped *before* the cursor here,
    // which is the case that would have gone unnoticed.
    const picker = readClaudePicker(PICKER);
    expect(picker?.choiceCursor).toBe(2);
    expect(picker?.options[2].label).toBe('ルータ操作は中止');
  });
});
