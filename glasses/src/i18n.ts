// English and Japanese for what is left on the phone side.
//
// The setup wizard's screens moved to hrdle/hrdle-setup and took most of this
// table with them. What stays is the two things that could not go: the
// voice-input settings panel, which the browser simulator also renders, and the
// errors from reading a QR code, which happens here because the camera does.
//
// Deliberately not react-i18next, which the web UI uses — nothing here is React,
// and the ehpk pays for every kilobyte it carries. What a wizard needs is a
// lookup, a language, and a way to change it.
//
// Mostly the phone screens. The exception is the demo (`demo.*`), which the G2
// draws itself: it is the first thing a new wearer reads, and a tutorial in a
// language you do not have is not a tutorial. The panel measures real glyph
// advances and already wraps Japanese - it does it every day for what the
// agents send back - so this costs no re-reckoning of `metrics.ts`. What it
// costs is room: full-width is about half the characters per line, so the two
// tables are the same lesson written twice, each to its own budget.

import { readStoredSync, writeStoredSync } from './storage.ts'

export type Lang = 'en' | 'ja'

const LANG_SUFFIX = 'lang'

/** Table of every string the phone screens can show. */
type Table = Record<string, string>

/**
 * Values are HTML, and are inserted with `innerHTML`.
 *
 * Every one of them is written here, in this file, by us — there is no path
 * from user input into this table, which is what makes the markup safe. Keep it
 * that way: interpolate through `t()`'s `vars`, never by building a key.
 */
const EN: Table = {

  'intro.get1': 'Run several agent sessions at once and switch between them',
  'intro.get2': 'Watch what each one is doing, live',
  'intro.get3': 'Approve or reject a prompt from the glasses, with the ring',
  'intro.get4': 'Read back the conversation',

  'machine.awake1':
    'An agent keeps working while you are away, and nothing reaches you from a sleeping machine — a session started in the morning is only there in the afternoon if the machine stayed awake the whole time.',
  'machine.awake2':
    'A laptop works while it is open and plugged in. Something that runs around the clock is what this is for. Turn sleep and hibernation off before you go on.',
  'machine.vps1':
    'A small VPS does this job well. It is already awake around the clock, it is already somewhere with a fixed home, and Tailscale installs on it exactly as it would on a desktop.',
  'machine.vps2':
    'One or two cores and 2 GB of memory is enough for several agent sessions. Your agent accounts sign in from there rather than from your desk, which is worth knowing but is not usually a problem.',

  'resolve.empty': 'Type the address first.',
  'resolve.notThere':
    'Something answered at {host}, but it was not a {product} server. Check the address.',
  'resolve.badAnswer': '{host} answered, but not with an address. Is that the right machine?',
  'resolve.unreachable': 'Could not reach {host}: {error}',
  'resolve.timedOut': 'no answer. Is the machine awake, and is Tailscale connected on this phone?',

  'settings.title': 'Voice input',
  'settings.subtitle':
    'Language and vocabulary travel with the speech, whichever server transcribes it.',
  'settings.groqSubtitle':
    'The default transcriber. The key is stored on the server and never leaves that host.',
  'settings.key': 'Groq API key',
  'settings.keySave': 'Save key',
  'settings.keyClear': 'Clear',
  'settings.keyNone': 'No key set - transcription will fail with 503.',
  'settings.keyEnv':
    'A key is set from the server environment (GROQ_API_KEY). Saving one here overrides it.',
  'settings.keySaved': 'A key is saved here.',
  'settings.keyPlaceholderSet': 'A key is set - type a new one to replace it',
  'settings.keyEmpty': 'Nothing to save - the field is empty.',
  'settings.lang': 'Language',
  'settings.langAuto': 'Auto-detect',
  'settings.langJa': 'Japanese',
  'settings.langEn': 'English',
  'settings.langSaved': 'Saved here.',
  'settings.langDefault': 'Server default ({lang}). Pick one to change it.',
  'settings.model': 'Transcription model',
  'settings.modelSaved': 'Saved here.',
  'settings.modelDefault': 'Server default ({model}). Pick one to change it.',
  'settings.bias': 'Vocabulary',
  'settings.biasToggle': 'Tell Whisper which words to expect',
  'settings.biasNone': '(nothing is sent)',
  'settings.biasOff': 'Off. Speech is transcribed with no vocabulary to go on.',
  'settings.biasEnvOff':
    'Switched off by HRDLE_STT_PROMPT=off in the server environment. That is not something this screen can switch back on.',
  'settings.biasEnv': 'Replaced by HRDLE_STT_PROMPT in the server environment.',
  'settings.biasComposed':
    'Sent with every transcription. A session speaking adds its own words in front of these - set those with `hrdle stt-prompt` in it, or from its settings.',
  'settings.glassesTitle': 'Glasses screen',
  'settings.screenOff': 'Auto screen-off (seconds)',
  'settings.screenOffHint':
    '0 = never. After this long with no ring input the panel goes dark; a double-tap wakes it.',
  'settings.screenOffSave': 'Save',
  'settings.screenOffSaved': 'Saved. Running glasses pick it up within a couple of minutes.',
  'settings.screenOffDefault': 'Off by default - the screen stays on. Type seconds and save to enable.',
  'settings.screenOffInvalid': 'Whole seconds between 0 and 3600.',
  'settings.groqTitle': 'Groq',
  'settings.destinationLine': 'Transcription currently goes to {destination}.',
  'settings.provider': 'Transcription provider',
  'settings.providerGroq': 'Groq',
  'settings.providerCustom': 'Custom server',
  'settings.fallbackToggle': 'Switch to the other one when it fails',
  'settings.endpoint': 'Custom transcription server',
  'settings.endpointHint':
    'An OpenAI-shaped endpoint (a local Whisper, for example), used when the provider above says so. Audio goes wherever this points.',
  'settings.endpointUrl': 'Endpoint URL',
  'settings.endpointModel': 'Model name the endpoint expects',
  'settings.endpointFallback': 'Fall back to Groq when it is unreachable',
  'settings.endpointSave': 'Save endpoint',
  'settings.endpointClear': 'Clear',
  'settings.endpointNone': 'Not set - transcription goes to Groq.',
  'settings.endpointEnv':
    'Set by the server environment (currently sending to {destination}). Saving here overrides it.',
  'settings.endpointSaved': 'Saved here. Currently sending to {destination}.',
  'settings.endpointSpecTitle': 'Running your own server? What it has to accept',
  'settings.endpointSpec':
    '<ul style="margin:0;padding-left:18px;display:grid;gap:6px;">' +
    '<li>OpenAI-style <code>POST /v1/audio/transcriptions</code> (multipart: <code>file</code> as WAV, <code>model</code>, optional <code>language</code> and <code>prompt</code>), answered with JSON <code>{"text": ...}</code>.</li>' +
    '<li>Treat an unknown <code>model</code> name as your default rather than an error.</li>' +
    '<li>The request comes from the Hrdle server, not from this phone - the endpoint must be reachable from that machine (a Tailscale address works; with plain http the audio crosses the network unencrypted).</li>' +
    "<li>A vocabulary <code>prompt</code> may be attached. whisper.cpp's server has been seen answering empty text when one is present - if speech stops coming back, switch the vocabulary bias off.</li>" +
    '<li>On 5xx or no answer, Hrdle retries against Groq while the switch above is on. A 4xx is treated as a configuration error and fails as is.</li>' +
    '<li>Whisper-family models invent text for silence and very short clips - expect hallucinated sentences from noise.</li>' +
    '</ul>',
  'settings.failed': 'Failed: {error}',

  // The demo, which is a tutorial: every string is a caption for the thing it
  // sits in. Unlike the rest of this table these are drawn by the G2 itself,
  // so a line's length is a pixel budget rather than a paragraph - see the
  // note above about what the panel holds.
  'demo.open.name': 'Waiting for your answer',
  'demo.open.recap': 'The agent\'s last line. It is waiting for an answer.',
  'demo.working.name': 'Working right now',
  'demo.working.recap': 'Working now. The bar after a name is context left.',
  'demo.panes.name': 'Two panes under one workspace',
  'demo.panes.pane1': 'each pane runs its own agent',
  'demo.panes.pane2': 'and carries its own mark',
  'demo.done.name': 'Done, nothing to answer',
  'demo.done.recap': 'It finished and said so. Nothing is waiting here.',
  'demo.back.name': 'Double-tap here closes the app',
  'demo.back.recap': 'From the list it offers to close. Inside a workspace it steps back.',
  'demo.conv.ask': 'What am I looking at?',
  'demo.conv.paging': 'Newest last - swipe up for older, double-tap for the list.',
  'demo.conv.tool': 'A line in brackets is what the agent did, not said.',
  'demo.conv.answer': 'A tap answers: options open the picker, otherwise the microphone. Try it - tap now.',
  'demo.choice1': 'A tap checks a box',
  'demo.choice2': 'Check as many as you like',
  'demo.choice3': 'Swipe down to the Send row',
  'demo.transcript': 'Spoken words land here, ready to send.',
  'demo.reply': 'That is your answer, in the conversation - {text}\n\nOn a real workspace it reaches the agent from here, and the reply comes back to this screen. That is the whole loop: read, answer, carry on.',
  'demo.recap.processing': 'Working on what you just sent.',
  'demo.recap.completed': 'Answered. Double-tap goes back to the list.',
}

const JA: Table = {

  'intro.get1': '複数のエージェントセッションを同時に動かし、切り替える',
  'intro.get2': 'それぞれが何をしているかをリアルタイムで見る',
  'intro.get3': 'グラスから、リングだけで承認・却下する',
  'intro.get4': '会話を読み返す',

  'machine.awake1':
    'エージェントはあなたが離れている間も動き続けます。スリープしたマシンからは何も届きません。朝に始めたセッションが午後もそこにあるのは、マシンがずっと起きていた場合だけです。',
  'machine.awake2':
    'ノートPCでも、開いて電源につないでいる間は使えます。とはいえ24時間動き続けるものが本来の想定です。先に進む前にスリープと休止状態を切っておいてください。',
  'machine.vps1':
    '小さな VPS で十分にこなせます。もともと24時間起動していて、住所も固定されており、Tailscale もデスクトップと同じように入ります。',
  'machine.vps2':
    '1〜2コアとメモリ 2GB あれば複数のエージェントセッションを動かせます。エージェントのアカウントは手元ではなくその VPS からサインインすることになる点は知っておくとよいですが、通常は問題になりません。',

  'resolve.empty': '先にアドレスを入力してください。',
  'resolve.notThere':
    '{host} から応答がありましたが、{product} サーバーではありませんでした。アドレスを確認してください。',
  'resolve.badAnswer': '{host} は応答しましたが、アドレスを返しませんでした。マシンは合っていますか。',
  'resolve.unreachable': '{host} に接続できませんでした: {error}',
  'resolve.timedOut':
    '応答がありません。マシンは起動していますか。この端末で Tailscale は接続されていますか。',

  'settings.title': '音声入力',
  'settings.subtitle':
    '言語と語彙の設定は、どの送り先で文字起こしする場合も共通です。',
  'settings.groqSubtitle':
    '既定の文字起こし先です。キーはサーバーに保存され、そのホストから出ません。',
  'settings.key': 'Groq API キー',
  'settings.keySave': 'キーを保存',
  'settings.keyClear': '消去',
  'settings.keyNone': 'キーが未設定です。音声認識は 503 で失敗します。',
  'settings.keyEnv':
    'サーバーの環境変数 (GROQ_API_KEY) からキーが設定されています。ここで保存するとそちらより優先されます。',
  'settings.keySaved': 'キーはここに保存されています。',
  'settings.keyPlaceholderSet': 'キーは設定済みです。置き換えるには新しいものを入力してください',
  'settings.keyEmpty': '保存するものがありません。入力欄が空です。',
  'settings.lang': '言語',
  'settings.langAuto': '自動判定',
  'settings.langJa': '日本語',
  'settings.langEn': '英語',
  'settings.langSaved': 'ここに保存されています。',
  'settings.langDefault': 'サーバーの既定値 ({lang})。変更するには選んでください。',
  'settings.model': '文字起こしモデル',
  'settings.modelSaved': 'ここに保存されています。',
  'settings.modelDefault': 'サーバーの既定値 ({model})。変更するには選んでください。',
  'settings.bias': '語彙',
  'settings.biasToggle': '出てくる語を音声認識に伝える',
  'settings.biasNone': '（何も送られません）',
  'settings.biasOff': 'オフ。語彙の手がかりなしで文字起こしします。',
  'settings.biasEnvOff':
    'サーバー環境変数の HRDLE_STT_PROMPT=off でオフになっています。この画面から戻すことはできません。',
  'settings.biasEnv': 'サーバー環境変数の HRDLE_STT_PROMPT で置き換えられています。',
  'settings.biasComposed':
    '毎回の文字起こしに送られます。話しかけるセッション自身の語はこの前に付きます（そのセッションで `hrdle stt-prompt`、または設定から）。',
  'settings.glassesTitle': 'グラス画面',
  'settings.screenOff': '自動消灯 (秒)',
  'settings.screenOffHint':
    '0 で消灯しない。リング無操作がこの秒数続くと画面が消え、ダブルタップで戻ります。',
  'settings.screenOffSave': '保存',
  'settings.screenOffSaved': '保存しました。稼働中のグラスにも 2 分以内に反映されます。',
  'settings.screenOffDefault': '既定では消灯しません。秒数を入れて保存すると有効になります。',
  'settings.screenOffInvalid': '0〜3600 の整数で入力してください。',
  'settings.groqTitle': 'Groq',
  'settings.destinationLine': '現在の文字起こしの送り先: {destination}',
  'settings.provider': '文字起こしの送り先',
  'settings.providerGroq': 'Groq',
  'settings.providerCustom': 'カスタムサーバー',
  'settings.fallbackToggle': '選んだ先がダメな時はもう一方に切り替える',
  'settings.endpoint': 'カスタム文字起こしサーバー',
  'settings.endpointHint':
    'OpenAI 互換のエンドポイント (ローカルの Whisper 等)。上の「文字起こしの送り先」でこちらを選んだ時に使われます。音声はここで指定した先に送られます。',
  'settings.endpointUrl': 'エンドポイント URL',
  'settings.endpointModel': '送り先が要求するモデル名',
  'settings.endpointFallback': '届かない時は Groq に切り替える',
  'settings.endpointSave': '送り先を保存',
  'settings.endpointClear': '消去',
  'settings.endpointNone': '未設定 — 文字起こしは Groq に送られます。',
  'settings.endpointEnv':
    'サーバーの環境変数で設定されています (現在の送り先: {destination})。ここで保存すると上書きします。',
  'settings.endpointSaved': 'ここに保存されています。現在の送り先: {destination}。',
  'settings.endpointSpecTitle': '自分でサーバーを立てる場合の要件',
  'settings.endpointSpec':
    '<ul style="margin:0;padding-left:18px;display:grid;gap:6px;">' +
    '<li>OpenAI 互換の <code>POST /v1/audio/transcriptions</code> (multipart: <code>file</code> は WAV、<code>model</code>、任意で <code>language</code> と <code>prompt</code>) を受け、JSON <code>{"text": ...}</code> で答えること。</li>' +
    '<li>未知の <code>model</code> 名はエラーにせず、自分の既定モデルとして扱うこと。</li>' +
    '<li>リクエストはこのスマホではなく Hrdle サーバーから届く — その機械から到達できるアドレスであること (Tailscale のアドレスで可。素の http では音声が暗号化されずに流れる)。</li>' +
    '<li>語彙ヒントの <code>prompt</code> が付くことがある。whisper.cpp の server は prompt 付きで空文字を返す実測がある — 音声が返らなくなったら語彙バイアスを切ること。</li>' +
    '<li>5xx か無応答なら、上のスイッチが有効な間は Groq へ切り替えて再試行する。4xx は設定間違いとしてそのまま失敗する。</li>' +
    '<li>Whisper 系のモデルは無音・ごく短い音声に文をでっち上げる — 雑音から幻聴の文が返る前提でいること。</li>' +
    '</ul>',
  'settings.failed': '失敗しました: {error}',

  // The demo. Japanese is full-width, so each of these has half the room the
  // English does - the panel fits about 30 of these characters to a line.
  'demo.open.name': '返答を待っています',
  'demo.open.recap': 'エージェントの最後の一言。返答を待っています。',
  'demo.working.name': '作業中',
  'demo.working.recap': '作業中。名前の後のバーは残りコンテキスト。',
  'demo.panes.name': 'ペインを 2 つ持つワークスペース',
  'demo.panes.pane1': 'ペインごとに別のエージェント',
  'demo.panes.pane2': '印もペインごとに付きます',
  'demo.done.name': '完了。返答は不要',
  'demo.done.recap': '終わって、そう言った状態。待っているものはない。',
  'demo.back.name': 'ダブルタップで終了',
  'demo.back.recap': '一覧では終了の確認、ワークスペースの中では一段戻る。',
  'demo.conv.ask': 'これは何の画面?',
  'demo.conv.paging': '新しいものが下。上で過去、ダブルタップで一覧へ。',
  'demo.conv.tool': '角括弧の行は、言ったことではなくやったこと。',
  'demo.conv.answer': 'タップで返答。選択肢があれば一覧、なければマイク。試しにタップ。',
  'demo.choice1': 'タップでチェック',
  'demo.choice2': 'いくつ選んでもいい',
  'demo.choice3': '下へスワイプで Send 行',
  'demo.transcript': '話した言葉はここに入ります。',
  'demo.reply': 'これがあなたの返答です - {text}\n\n実際のワークスペースでは、ここからエージェントに届き、返事がこの画面に戻ります。読んで、答えて、進む。それだけです。',
  'demo.recap.processing': '送った内容を処理中。',
  'demo.recap.completed': '返答済み。ダブルタップで一覧へ。',
}

const TABLES: Record<Lang, Table> = { en: EN, ja: JA }

/**
 * The language to start in.
 *
 * A saved choice wins, because it was made deliberately on this device. Failing
 * that, the browser's own preference: a Japanese phone should not have to be
 * told twice.
 */
function detect(): Lang {
  const saved = readStoredSync(LANG_SUFFIX)
  if (saved === 'en' || saved === 'ja') return saved
  const candidates = [
    ...(typeof navigator !== 'undefined' ? navigator.languages ?? [] : []),
    typeof navigator !== 'undefined' ? navigator.language : '',
  ]
  return candidates.some((l) => l?.toLowerCase().startsWith('ja')) ? 'ja' : 'en'
}

/**
 * Resolved on first use, not on import.
 *
 * Detection reads the store, and the store's key is built from a constant Vite
 * injects at build time — so doing this at module scope throws in a unit test,
 * which imports the file directly with nothing injected. Deferring it also
 * keeps an import from touching `localStorage` as a side effect.
 */
let current: Lang | null = null

function ensure(): Lang {
  if (current === null) {
    try {
      current = detect()
    } catch {
      current = 'en'
    }
  }
  return current
}

export function getLang(): Lang {
  return ensure()
}

/** Switch language and remember it. The caller re-renders. */
export function setLang(lang: Lang): void {
  current = lang
  try {
    writeStoredSync(LANG_SUFFIX, lang)
  } catch {
    // Nothing to persist to; the choice still holds for this run.
  }
}

/**
 * Look up `key`, substituting `{name}` placeholders from `vars`.
 *
 * A missing key falls back to English and then to the key itself. Showing the
 * key is ugly and unmistakable, which is what you want from a string that was
 * never translated — an empty label looks like a layout bug and gets ignored.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = TABLES[ensure()][key] ?? EN[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

/** Every key the tables are expected to carry. Used by the tests. */
export function keysOf(lang: Lang): string[] {
  return Object.keys(TABLES[lang]).sort()
}
