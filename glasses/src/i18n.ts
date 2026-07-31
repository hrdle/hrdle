// English and Japanese for the phone screens.
//
// `glasses/src` had no i18n at all, which is why every string in the setup
// wizard was written in English and stayed there: the repository rule is that
// prose we write is English *unless* it goes through a translation table, and
// there was no table to put it in. This is the table.
//
// Deliberately not react-i18next, which the web UI uses — nothing here is React,
// and the ehpk pays for every kilobyte it carries. What a wizard needs is a
// lookup, a language, and a way to change it.
//
// Only the phone screens. What the G2 itself draws stays English for now:
// Japanese is full-width, so `metrics.ts` line widths and the seven-line clamp
// would all have to be re-reckoned, and that is its own piece of work rather
// than a translation.

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
  'brand.for': 'for EVEN G2',
  'nav.start': 'Start setup',
  'nav.next': 'Done — next',
  'nav.back': 'Back',
  'nav.skip': 'Already running',
  'nav.step': 'Step {n} of {total} · {label}',
  'nav.onMachine': 'On that machine',
  'nav.onPhone': 'On this phone',
  'cmd.copy': 'copy',
  'cmd.copied': 'copied',
  'cmd.copyFailed': 'failed',

  'step.intro': 'What this is',
  'step.machine': 'A machine',
  'step.agent': 'Coding agent',
  'step.tailscale': 'Tailscale',
  'step.install': 'Install',
  'step.connect': 'Connect',
  'step.done': 'Glasses',

  'intro.title': 'What {product} is',
  'intro.lead':
    '{product} runs coding agents — Claude Code, Codex, Grok, Kimi — on a machine of yours, and puts them on this phone and on the G2.',
  'intro.net.machine': 'A machine · awake 24/7',
  'intro.net.machineDesc':
    'Claude Code, herdr and the {product} server. A desktop at home or a VPS you rent — the agents actually run here, and they keep working while you are not watching, so it must not sleep.',
  'intro.net.tailscale':
    '<b>Tailscale</b> — a VPN across your own devices. This leg crosses the open internet, so the phone reaches that machine from anywhere; the traffic is encrypted end to end and no port is opened for anyone else to find.',
  'intro.net.phone': 'This phone',
  'intro.net.phoneDesc': 'this app, wherever you are',
  'intro.net.bluetooth': '<b>Bluetooth</b> — the phone drives the glasses directly.',
  'intro.net.glasses': 'The G2',
  'intro.net.glassesDesc': 'read what an agent is asking, answer it with the ring',
  'intro.guideTitle': 'Reading this on a phone?',
  'intro.guide':
    'The next four screens are commands typed on that machine. The same guide is a web page, so you can open it there and copy them straight out of it.',
  'intro.guideButton': 'Open the guide on that machine',
  'intro.getTitle': 'What you get',
  'intro.get1': 'Run several agent sessions at once and switch between them',
  'intro.get2': 'Watch what each one is doing, live',
  'intro.get3': 'Approve or reject a prompt from the glasses, with the ring',
  'intro.get4': 'Read back the conversation',
  'intro.time':
    "Six short steps: a few commands on that machine, then point this phone's camera at a code it prints. About ten minutes.",

  'machine.title': 'A machine to run it on',
  'machine.lead':
    'Pick the machine the agents will run on. It does not have to be a computer you own.',
  'machine.supported': 'Supported today',
  'machine.linux': 'Linux',
  'machine.linuxArch': 'x86_64',
  'machine.macos': 'macOS',
  'machine.macosArch': 'Apple silicon',
  'machine.awakeTitle': 'It must not sleep',
  'machine.awake1':
    'An agent keeps working while you are away, and nothing reaches you from a sleeping machine — a session started in the morning is only there in the afternoon if the machine stayed awake the whole time.',
  'machine.awake2':
    'A laptop works while it is open and plugged in. Something that runs around the clock is what this is for. Turn sleep and hibernation off before you go on.',
  'machine.vpsTitle': 'No machine to spare? Rent one',
  'machine.vps1':
    'A small VPS does this job well. It is already awake around the clock, it is already somewhere with a fixed home, and Tailscale installs on it exactly as it would on a desktop.',
  'machine.vps2':
    'One or two cores and 2 GB of memory is enough for several agent sessions. Your agent accounts sign in from there rather than from your desk, which is worth knowing but is not usually a problem.',

  'agent.title': 'Install a coding agent',
  'agent.lead':
    '{product} drives agents; it is not one itself. Install at least one on that machine and sign in.',
  'agent.claudeTitle': 'Claude Code',
  'agent.claudeNote': 'Then run <code>claude</code> once and sign in.',
  'agent.signInTitle': 'Sign in now, not later',
  'agent.signIn':
    'An agent that has never been signed in shows a login screen when it starts — and a login screen is not something you want to meet through the glasses.',
  'agent.others':
    'Codex, Grok Build and Kimi Code work too, and you can add them later. One is enough to finish this setup.',

  'tailscale.title': 'Put that machine on Tailscale',
  'tailscale.lead':
    'Tailscale is how this phone reaches that machine, and where its HTTPS certificate comes from. No ports are opened to the internet.',
  'tailscale.linux': 'Linux',
  'tailscale.macos': 'macOS',
  'tailscale.brewNote':
    'Install it with brew rather than the App Store — the App Store build ships no command line tool, and setup needs one.',
  'tailscale.certTitle': 'Then allow certificates, once',
  'tailscale.certNote':
    'Without this {binary} cannot issue its HTTPS certificate and will refuse to start.',
  'tailscale.downloads':
    '{link} — sign in with any account you like; you will use the same one on this phone later.',
  'tailscale.downloadsLabel': 'Tailscale downloads',

  'install.title': 'Install {product}',
  'install.lead':
    'One command. Leave that window open when it finishes — it ends by drawing a QR code, and the next screen reads it.',
  'install.whatTitle': 'What it does',
  'install.what':
    'Installs {binary} into <code>~/bin</code> and {herdr} if it is missing, registers the service so it survives a reboot, and prints the address as a QR code.',
  'install.sudoNote':
    'If it says a sudo command is still needed, run that line and then <code>{binary} setup</code>.',
  'install.passwordTitle': 'Want a password on it?',
  'install.password':
    'As installed, anything signed in to your tailnet can open it — usually your own devices, and nothing is exposed to the internet either way. To be asked for a password in the browser instead, run:',

  'connect.title': 'Connect to {product}',
  'connect.lead':
    'Two things on this phone: join the tailnet, then point the camera at the code on that machine.',
  'connect.tailscaleTitle': '1 · Tailscale on this phone',
  'connect.tailscaleNote':
    'Sign in with the same account you used on that machine, or the two cannot see each other. If neither link opens from here, copy this into a browser:',
  'connect.scanTitle': '2 · Scan the code',
  'connect.scanNote':
    'The installer printed one when it finished. To bring it back, run this on that machine:',
  'connect.scanButton': 'Scan the QR code',
  'connect.connectButton': 'Connect',
  'connect.orType': 'or type the address',
  'connect.troubleTitle': 'If it will not connect',
  'connect.trouble':
    'Check that Tailscale says connected on this phone, that <code>{binary} status</code> on that machine says it is running, and that the host name matches exactly — the certificate is issued for that name.',
  'connect.opening': 'Opening the camera...',
  'connect.addressRead': 'Address read',
  'connect.enterFirst': 'Enter the URL first',
  'connect.connecting': 'Connecting...',
  'connect.connected': 'Connected',
  'connect.failed': 'Could not connect: {error}',

  'done.title': 'Ready',
  'done.connected': 'Connected',
  'done.server': 'Server',
  'done.version': 'Version',
  'done.sessions': 'Sessions',
  'done.usage': 'API usage',
  'done.launchTitle': 'Launch it on the glasses',
  'done.launch':
    'Open {product} from the G2 app menu. Swipe to move between sessions, tap to select, double tap to go back.',
  'done.disconnect': 'Disconnect',

  'scan.cameraFailed': 'The camera could not be opened: {error}',
  'scan.readFailed': 'Could not read that photo: {error}',
  'scan.noCode': 'No QR code in that photo. Fill more of the frame with it and try again.',
  'scan.notAnAddress': 'That code is not a web address. Scan the one printed by `{binary} qr`.',
  'scan.imageUnreadable': 'that image could not be read',
  'scan.imageEmpty': 'that image was empty',
  'scan.cannotProcess': 'this device cannot process the photo',

  'settings.title': 'Voice input',
  'settings.subtitle':
    'Transcription runs on the server through Groq. The key never leaves that host.',
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
  'settings.prompt': 'Vocabulary prompt',
  'settings.promptSave': 'Save prompt',
  'settings.promptReset': 'Reset',
  'settings.promptSetting': 'Using the prompt saved here.',
  'settings.promptEnv': 'Using HRDLE_STT_PROMPT from the server environment.',
  'settings.promptComposed':
    'Using the prompt composed from your workspace names and the glossary.',
  'settings.failed': 'Failed: {error}',
}

const JA: Table = {
  'brand.for': 'for EVEN G2',
  'nav.start': 'セットアップを始める',
  'nav.next': 'できた — 次へ',
  'nav.back': '戻る',
  'nav.skip': 'もう動いている',
  'nav.step': 'ステップ {n}/{total} · {label}',
  'nav.onMachine': 'サーバー側の作業',
  'nav.onPhone': 'このスマホでの作業',
  'cmd.copy': 'コピー',
  'cmd.copied': 'コピーしました',
  'cmd.copyFailed': '失敗',

  'step.intro': 'これは何か',
  'step.machine': 'マシン',
  'step.agent': 'エージェント',
  'step.tailscale': 'Tailscale',
  'step.install': 'インストール',
  'step.connect': '接続',
  'step.done': 'グラス',

  'intro.title': '{product} とは',
  'intro.lead':
    '{product} は Claude Code、Codex、Grok、Kimi といったコーディングエージェントをあなたのマシンで動かし、それをこのスマホと G2 に映します。',
  'intro.net.machine': 'マシン · 24時間起動',
  'intro.net.machineDesc':
    'Claude Code、herdr、そして {product} サーバー。自宅のデスクトップでも、借りた VPS でも構いません。エージェントが実際に動くのはここで、あなたが見ていない間も動き続けるため、スリープさせてはいけません。',
  'intro.net.tailscale':
    '<b>Tailscale</b> — 自分のデバイス同士をつなぐ VPN です。この区間はインターネットを通るので、どこからでもそのマシンに届きます。通信は端から端まで暗号化され、他人に見つかるポートは開きません。',
  'intro.net.phone': 'このスマホ',
  'intro.net.phoneDesc': 'このアプリ。どこにいても',
  'intro.net.bluetooth': '<b>Bluetooth</b> — スマホがグラスを直接動かします。',
  'intro.net.glasses': 'G2 グラス',
  'intro.net.glassesDesc': 'エージェントの問いを読み、リングで答える',
  'intro.guideTitle': 'スマホで読んでいますか?',
  'intro.guide':
    'この先の4画面は、マシン側で打つコマンドです。同じ手順はウェブページにもあるので、マシンで開けばコマンドをそのままコピーできます。',
  'intro.guideButton': 'マシンで手順を開く',
  'intro.getTitle': 'できること',
  'intro.get1': '複数のエージェントセッションを同時に動かし、切り替える',
  'intro.get2': 'それぞれが何をしているかをリアルタイムで見る',
  'intro.get3': 'グラスから、リングだけで承認・却下する',
  'intro.get4': '会話を読み返す',
  'intro.time':
    '全6ステップ。マシン側でいくつかコマンドを打ち、最後にこのスマホのカメラでコードを読み取ります。10分ほどです。',

  'machine.title': 'エージェントを動かすマシン',
  'machine.lead':
    'エージェントを動かすマシンを決めます。自分が所有するコンピュータである必要はありません。',
  'machine.supported': '対応環境',
  'machine.linux': 'Linux',
  'machine.linuxArch': 'x86_64',
  'machine.macos': 'macOS',
  'machine.macosArch': 'Apple シリコン',
  'machine.awakeTitle': 'スリープさせないこと',
  'machine.awake1':
    'エージェントはあなたが離れている間も動き続けます。スリープしたマシンからは何も届きません。朝に始めたセッションが午後もそこにあるのは、マシンがずっと起きていた場合だけです。',
  'machine.awake2':
    'ノートPCでも、開いて電源につないでいる間は使えます。とはいえ24時間動き続けるものが本来の想定です。先に進む前にスリープと休止状態を切っておいてください。',
  'machine.vpsTitle': '空いているマシンがない場合は借りる',
  'machine.vps1':
    '小さな VPS で十分にこなせます。もともと24時間起動していて、住所も固定されており、Tailscale もデスクトップと同じように入ります。',
  'machine.vps2':
    '1〜2コアとメモリ 2GB あれば複数のエージェントセッションを動かせます。エージェントのアカウントは手元ではなくその VPS からサインインすることになる点は知っておくとよいですが、通常は問題になりません。',

  'agent.title': 'コーディングエージェントを入れる',
  'agent.lead':
    '{product} はエージェントを動かす側であって、エージェントそのものではありません。マシンに少なくとも1つ入れて、サインインまで済ませてください。',
  'agent.claudeTitle': 'Claude Code',
  'agent.claudeNote': 'インストール後、一度 <code>claude</code> を実行してサインインします。',
  'agent.signInTitle': 'サインインは後回しにしない',
  'agent.signIn':
    '一度もサインインしていないエージェントは、起動するとログイン画面を出します。ログイン画面はグラス越しに出会いたいものではありません。',
  'agent.others':
    'Codex、Grok Build、Kimi Code にも対応しています。後から追加できるので、このセットアップを終えるには1つあれば足ります。',

  'tailscale.title': 'マシンを Tailscale につなぐ',
  'tailscale.lead':
    'このスマホがマシンに届くのも、HTTPS 証明書が出るのも Tailscale 経由です。インターネットに向けてポートを開くことはありません。',
  'tailscale.linux': 'Linux',
  'tailscale.macos': 'macOS',
  'tailscale.brewNote':
    'App Store 版ではなく brew で入れてください。App Store 版にはコマンドラインツールが含まれず、セットアップにはそれが必要です。',
  'tailscale.certTitle': '証明書の発行を一度だけ許可する',
  'tailscale.certNote':
    'これがないと {binary} は HTTPS 証明書を発行できず、起動を拒否します。',
  'tailscale.downloads':
    '{link} — アカウントは何でも構いませんが、後でこのスマホでも同じものを使います。',
  'tailscale.downloadsLabel': 'Tailscale のダウンロード',

  'install.title': '{product} を入れる',
  'install.lead':
    'コマンド1つです。終わってもそのウィンドウは開いたままにしてください。最後に QR コードを描き、次の画面でそれを読み取ります。',
  'install.whatTitle': 'このコマンドがすること',
  'install.what':
    '{binary} を <code>~/bin</code> に入れ、{herdr} が無ければそれも入れ、再起動後も動くようサービス登録し、最後にアドレスを QR コードで表示します。',
  'install.sudoNote':
    'sudo のコマンドがまだ必要だと表示されたら、その行を実行してから <code>{binary} setup</code> を実行してください。',
  'install.passwordTitle': 'パスワードを付けたい場合',
  'install.password':
    'そのままの状態では、あなたの tailnet にサインインしているものなら開けます。たいていは自分のデバイスだけですし、どちらにせよインターネットには公開されません。ブラウザでパスワードを求めるようにするには、次を実行します:',

  'connect.title': '{product} につなぐ',
  'connect.lead':
    'このスマホですることは2つ。tailnet に参加し、マシンに表示されたコードにカメラを向けます。',
  'connect.tailscaleTitle': '1 · このスマホに Tailscale',
  'connect.tailscaleNote':
    'マシンで使ったのと同じアカウントでサインインしてください。違うと互いに見えません。どちらのリンクもここから開かない場合は、これをブラウザに貼り付けてください:',
  'connect.scanTitle': '2 · コードを読み取る',
  'connect.scanNote':
    'インストーラが終了時に表示しています。もう一度出すには、マシンで次を実行します:',
  'connect.scanButton': 'QR コードを読み取る',
  'connect.connectButton': '接続する',
  'connect.orType': 'または手で入力する',
  'connect.troubleTitle': 'つながらないとき',
  'connect.trouble':
    'このスマホの Tailscale が接続済みか、マシンで <code>{binary} status</code> が動作中と表示するか、ホスト名が完全に一致しているかを確認してください。証明書はそのホスト名に対して発行されています。',
  'connect.opening': 'カメラを起動しています...',
  'connect.addressRead': 'アドレスを読み取りました',
  'connect.enterFirst': 'URL を入力してください',
  'connect.connecting': '接続しています...',
  'connect.connected': '接続しました',
  'connect.failed': '接続できませんでした: {error}',

  'done.title': '準備完了',
  'done.connected': '接続済み',
  'done.server': 'サーバー',
  'done.version': 'バージョン',
  'done.sessions': 'セッション',
  'done.usage': 'API 使用量',
  'done.launchTitle': 'グラスで起動する',
  'done.launch':
    'G2 のアプリメニューから {product} を開きます。スワイプでセッションを移動、タップで選択、ダブルタップで戻ります。',
  'done.disconnect': '接続を解除',

  'scan.cameraFailed': 'カメラを開けませんでした: {error}',
  'scan.readFailed': 'その写真を読み取れませんでした: {error}',
  'scan.noCode':
    'その写真に QR コードが見つかりません。コードが画面いっぱいに写るようにして、もう一度試してください。',
  'scan.notAnAddress':
    'そのコードはウェブアドレスではありません。`{binary} qr` が表示するコードを読み取ってください。',
  'scan.imageUnreadable': '画像を読み込めませんでした',
  'scan.imageEmpty': '画像が空でした',
  'scan.cannotProcess': 'この端末では写真を処理できません',

  'settings.title': '音声入力',
  'settings.subtitle':
    '音声認識はサーバー側で Groq を通して実行されます。キーがそのホストから出ることはありません。',
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
  'settings.prompt': '語彙プロンプト',
  'settings.promptSave': 'プロンプトを保存',
  'settings.promptReset': '既定に戻す',
  'settings.promptSetting': 'ここに保存されたプロンプトを使っています。',
  'settings.promptEnv': 'サーバー環境変数の HRDLE_STT_PROMPT を使っています。',
  'settings.promptComposed': 'ワークスペース名と用語集から組み立てたプロンプトを使っています。',
  'settings.failed': '失敗しました: {error}',
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
