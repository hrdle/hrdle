// Phone settings UI — shown when launched from Even Hub app (appMenu)

import type { Bridge } from './display.ts'
import { setBaseUrl, getDashboard, getSessions } from './api.ts'

const LS_KEY = 'cchub-url'

export async function startPhoneUI(bridge: Bridge | null): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app')!

  // Load saved URL
  let savedUrl = ''
  if (bridge) {
    savedUrl = await bridge.getLocalStorage(LS_KEY) || ''
  }

  const isConnected = !!savedUrl

  app.innerHTML = `
    <div style="font-family: -apple-system, 'Helvetica Neue', sans-serif; background: #0a0a0a; color: #eee; min-height: 100vh;">

      <!-- Hero -->
      <div style="background: linear-gradient(135deg, #0a1a0a 0%, #0a0a1a 100%); padding: 32px 20px 24px; border-bottom: 1px solid #1a3a1a;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <div style="width: 44px; height: 44px; background: #0f0; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px;">⌘</div>
          <div>
            <h1 style="font-size: 22px; margin: 0; font-weight: 700;">CC Hub Glasses</h1>
            <p style="color: #888; font-size: 12px; margin: 2px 0 0;">for EVEN G2</p>
          </div>
        </div>
        <p style="color: #aaa; font-size: 14px; line-height: 1.5; margin: 0;">
          AIコーディングアシスタント Claude Code のセッションをスマートグラスからリアルタイムで確認・操作
        </p>
      </div>

      <div style="padding: 16px 20px;">

        <!-- What is CC Hub (shown when not connected) -->
        <div id="about-section" style="display: ${isConnected ? 'none' : 'block'};">
          <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
            <h2 style="font-size: 15px; color: #0f0; margin: 0 0 12px; font-weight: 600;">CC Hub とは？</h2>
            <p style="font-size: 13px; color: #bbb; line-height: 1.7; margin: 0 0 12px;">
              <a href="https://github.com/m0a/cc-hub" style="color: #4a9; text-decoration: none;">CC Hub</a> は、
              Claude Code セッションをWebブラウザからリモート管理するターミナルマネージャーです。
              複数のClaude Codeセッションの同時実行・監視・操作ができます。
            </p>
            <div style="font-size: 13px; color: #999; line-height: 1.6;">
              <div style="display: flex; gap: 8px; align-items: start; margin-bottom: 8px;">
                <span style="color: #0f0; font-size: 16px;">◆</span>
                <span>複数セッションの一括管理と切り替え</span>
              </div>
              <div style="display: flex; gap: 8px; align-items: start; margin-bottom: 8px;">
                <span style="color: #0f0; font-size: 16px;">◆</span>
                <span>処理状況のリアルタイム監視</span>
              </div>
              <div style="display: flex; gap: 8px; align-items: start; margin-bottom: 8px;">
                <span style="color: #0f0; font-size: 16px;">◆</span>
                <span>承認・拒否操作をリモートで実行</span>
              </div>
              <div style="display: flex; gap: 8px; align-items: start;">
                <span style="color: #0f0; font-size: 16px;">◆</span>
                <span>会話履歴の閲覧</span>
              </div>
            </div>
          </div>

          <!-- Glasses features -->
          <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
            <h2 style="font-size: 15px; color: #0f0; margin: 0 0 12px; font-weight: 600;">メガネでできること</h2>
            <div style="font-size: 13px; color: #bbb; line-height: 1.7;">
              <p style="margin: 0 0 8px;">リングの操作だけでClaude Codeを監視・操作:</p>
              <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #222;">
                  <td style="padding: 6px 0; color: #0f0; width: 100px;">スワイプ上下</td>
                  <td style="padding: 6px 0; color: #ccc;">セッション切替 / スクロール</td>
                </tr>
                <tr style="border-bottom: 1px solid #222;">
                  <td style="padding: 6px 0; color: #0f0;">タップ</td>
                  <td style="padding: 6px 0; color: #ccc;">選択 / 承認確定</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #0f0;">ダブルタップ</td>
                  <td style="padding: 6px 0; color: #ccc;">戻る / 次のwaiting</td>
                </tr>
              </table>
            </div>
          </div>

          <!-- Setup steps -->
          <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
            <h2 style="font-size: 15px; color: #0f0; margin: 0 0 12px; font-weight: 600;">セットアップ手順</h2>
            <div style="font-size: 13px; color: #ccc; line-height: 1.8;">
              <div style="display: flex; gap: 10px; margin-bottom: 12px;">
                <div style="background: #0f0; color: #000; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">1</div>
                <div>
                  <div style="font-weight: 600; margin-bottom: 2px;">CC Hub をインストール</div>
                  <div style="position: relative;">
                    <code id="install-cmd" style="background: #1a1a1a; padding: 8px; border-radius: 4px; font-size: 11px; color: #0f0; display: block; word-break: break-all; line-height: 1.5;">curl -fsSL https://raw.githubusercontent.com/m0a/cc-hub/main/install.sh | bash</code>
                    <button id="btn-copy-install" style="position: absolute; top: 4px; right: 4px; background: #333; border: none; color: #aaa; font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer;">copy</button>
                  </div>
                </div>
              </div>
              <div style="display: flex; gap: 10px; margin-bottom: 12px;">
                <div style="background: #0f0; color: #000; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">2</div>
                <div>
                  <div style="font-weight: 600; margin-bottom: 2px;">CC Hub を起動</div>
                  <code style="background: #1a1a1a; padding: 4px 8px; border-radius: 4px; font-size: 11px; color: #0f0;">cchub</code>
                  <span style="color: #888; font-size: 12px; margin-left: 8px;">（デフォルトポート: ${__DEFAULT_PORT__}）</span>
                </div>
              </div>
              <div style="display: flex; gap: 10px; margin-bottom: 12px;">
                <div style="background: #0f0; color: #000; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">3</div>
                <div>
                  <div style="font-weight: 600; margin-bottom: 2px;">Tailscale で接続</div>
                  <div style="color: #999; font-size: 12px;">PCとスマホに<a href="https://tailscale.com" style="color: #4a9; text-decoration: none;">Tailscale</a>をインストールし、同じネットワークに参加</div>
                </div>
              </div>
              <div style="display: flex; gap: 10px;">
                <div style="background: #0f0; color: #000; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">4</div>
                <div>
                  <div style="font-weight: 600;">下のURLを入力して接続</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Connection -->
        <div style="background: #111; border: 1px solid ${isConnected ? '#1a3a1a' : '#222'}; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
          <h2 style="font-size: 15px; color: #0f0; margin: 0 0 12px; font-weight: 600;">CC Hub 接続設定</h2>
          <div style="font-size: 12px; color: #888; margin-bottom: 8px;">CC Hub サーバーの Tailscale URL を入力してください</div>
          <input id="url-input" type="url" value="${savedUrl}"
            placeholder="https://hostname.tail*****.ts.net:${__DEFAULT_PORT__}"
            style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #333; background: #1a1a1a; color: #eee; font-size: 14px; margin-bottom: 10px; box-sizing: border-box; font-family: monospace;"
          />
          <div style="display: flex; gap: 8px;">
            <button id="btn-connect" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: #0a0; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;">
              接続
            </button>
            <button id="btn-disconnect" style="padding: 12px 16px; border-radius: 8px; border: 1px solid #444; background: transparent; color: #888; font-size: 14px; cursor: pointer; display: ${isConnected ? 'block' : 'none'};">
              切断
            </button>
          </div>
          <div id="connect-status" style="margin-top: 8px; font-size: 13px;"></div>
        </div>

        <!-- Connected info -->
        <div id="connected-info" style="display: none; background: #0a1a0a; border: 1px solid #1a3a1a; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
            <div style="width: 10px; height: 10px; background: #0f0; border-radius: 50; animation: pulse 2s infinite;"></div>
            <h2 style="font-size: 15px; color: #0f0; margin: 0; font-weight: 600;">接続中</h2>
          </div>
          <div id="server-info" style="font-size: 13px; color: #ccc; line-height: 1.8;"></div>
          <div id="ws-diag" style="margin-top: 12px; padding: 10px; background: #111; border-radius: 8px; border: 1px solid #333; font-family: monospace; font-size: 11px; color: #888; line-height: 1.6;"></div>
          <div style="margin-top: 16px; padding: 12px; background: #0a2a0a; border-radius: 8px; border: 1px solid #1a3a1a;">
            <p style="font-size: 14px; color: #0f0; margin: 0 0 4px; font-weight: 600;">✓ メガネから操作できます</p>
            <p style="font-size: 12px; color: #888; margin: 0;">G2のメガネメニューからこのアプリを起動してください</p>
          </div>
        </div>

        <!-- Help -->
        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 16px; margin-bottom: 32px;">
          <h2 style="font-size: 15px; color: #888; margin: 0 0 8px; font-weight: 600;">リンク</h2>
          <div style="font-size: 13px; line-height: 2;">
            <a href="https://github.com/m0a/cc-hub" style="color: #4a9; text-decoration: none;">CC Hub GitHub →</a><br>
            <a href="https://github.com/m0a/cc-hub#installation" style="color: #4a9; text-decoration: none;">インストール手順 →</a><br>
            <a href="https://tailscale.com/download" style="color: #4a9; text-decoration: none;">Tailscale ダウンロード →</a>
          </div>
        </div>

      </div>
    </div>
    <style>
      @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    </style>
  `

  const urlInput = document.getElementById('url-input') as HTMLInputElement
  const btnConnect = document.getElementById('btn-connect')!
  const btnDisconnect = document.getElementById('btn-disconnect')!
  const connectStatus = document.getElementById('connect-status')!
  const connectedInfo = document.getElementById('connected-info')!
  const aboutSection = document.getElementById('about-section')!
  const serverInfo = document.getElementById('server-info')!

  // Copy button
  document.getElementById('btn-copy-install')?.addEventListener('click', () => {
    const cmd = document.getElementById('install-cmd')?.textContent || ''
    navigator.clipboard.writeText(cmd).then(() => {
      const btn = document.getElementById('btn-copy-install')
      if (btn) { btn.textContent = 'copied!'; setTimeout(() => { btn.textContent = 'copy' }, 1500) }
    }).catch(() => {})
  })

  // If already saved, auto-connect
  if (savedUrl) {
    await tryConnect(savedUrl)
  }

  function normalizeUrl(input: string): string {
    let url = input.trim().replace(/\/+$/, '')
    if (!url) return ''
    // Add https:// if no protocol
    if (!url.match(/^https?:\/\//)) {
      url = `https://${url}`
    }
    // Add the default port if none was typed
    if (!url.match(/:\d+$/)) {
      url = `${url}:${__DEFAULT_PORT__}`
    }
    return url
  }

  // Auto-normalize on blur
  urlInput.addEventListener('blur', () => {
    const normalized = normalizeUrl(urlInput.value)
    if (normalized) urlInput.value = normalized
  })

  btnConnect.addEventListener('click', async () => {
    const url = normalizeUrl(urlInput.value)
    if (!url) {
      connectStatus.innerHTML = '<span style="color: #f44;">URLを入力してください</span>'
      return
    }
    urlInput.value = url
    await tryConnect(url)
  })

  btnDisconnect.addEventListener('click', async () => {
    if (bridge) {
      await bridge.setLocalStorage(LS_KEY, '')
    }
    connectedInfo.style.display = 'none'
    btnDisconnect.style.display = 'none'
    aboutSection.style.display = 'block'
    connectStatus.innerHTML = '<span style="color: #888;">切断しました</span>'
  })

  // biome-ignore lint: dynamic import to avoid initialization order issues
  let diagClient: any = null

  async function startWsDiag(sessions: Array<{ id: string; indicatorState?: string; panes?: Array<{ paneId: string }> }>) {
    const { CcHubWsClient } = await import('./ws-client.ts')
    const diagEl = document.getElementById('ws-diag')
    if (!diagEl) return

    diagClient?.close()
    const firstSession = sessions[0]

    diagClient = new CcHubWsClient({
      onSessionsUpdated() {},
      onTerminalOutput() {},
      onReady() {
        if (firstSession) diagClient!.subscribe(firstSession.id)
      },
      onError(msg: string) {
        diagEl.innerHTML = `<span style="color:#f44;">WS Error: ${msg}</span>`
      },
    })
    diagClient.connect()

    setInterval(() => {
      if (!diagClient || !diagEl) return
      const wsState = diagClient.getState()
      const sub = diagClient.getSubscribed()
      const bufText = sub ? diagClient.getTerminalText(sub) : ''
      const choices = sub ? diagClient.getChoices(sub) : []
      const bufPreview = bufText.slice(-80).replace(/\n/g, '↵')
      diagEl.innerHTML = [
        `<b>WS診断</b>`,
        `WS: <span style="color:${wsState === 'OPEN' ? '#0f0' : '#f44'}">${wsState}</span>`,
        `Sub: ${sub || 'none'}`,
        `Buf: ${bufText.length}ch`,
        `Choices: [${choices.join(', ')}]`,
        bufText ? `末尾: <span style="color:#aaa;">${bufPreview}</span>` : '',
      ].filter(Boolean).join('<br>')
    }, 1000)
  }

  async function tryConnect(url: string) {
    connectStatus.innerHTML = '<span style="color: #ff0;">接続中...</span>'
    btnConnect.setAttribute('disabled', '')
    try {
      setBaseUrl(url)
      const [dashRes, sessionsRes] = await Promise.all([
        getDashboard(),
        getSessions(),
      ])

      // Save URL
      if (bridge) {
        await bridge.setLocalStorage(LS_KEY, url)
      }
      urlInput.value = url

      // Show connected info
      const version = dashRes.version || '?'
      const sessionCount = sessionsRes.sessions?.length || 0
      const usage = dashRes.usageLimits
        ? `${dashRes.usageLimits.fiveHour.utilization}%`
        : '-'

      serverInfo.innerHTML = `
        <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px;">
          <span style="color: #888;">サーバー</span><span style="font-family: monospace; font-size: 12px;">${url}</span>
          <span style="color: #888;">バージョン</span><span>v${version}</span>
          <span style="color: #888;">セッション</span><span>${sessionCount} 個</span>
          <span style="color: #888;">API使用率</span><span>${usage}</span>
        </div>
      `

      connectStatus.innerHTML = '<span style="color: #0f0;">✓ 接続成功</span>'
      connectedInfo.style.display = 'block'
      btnDisconnect.style.display = 'block'
      aboutSection.style.display = 'none'

      // Start WS diagnostic
      startWsDiag(sessionsRes.sessions || [])
    } catch (e) {
      connectStatus.innerHTML = `<span style="color: #f44;">接続失敗: ${(e as Error).message}</span>`
      connectedInfo.style.display = 'none'
    } finally {
      btnConnect.removeAttribute('disabled')
    }
  }
}
