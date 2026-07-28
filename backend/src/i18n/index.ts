// Simple i18n for CLI/backend messages
// Detects language from LANG/LC_ALL environment variables
// Translations are embedded for single binary support

import { IDENTITY, SERVICE } from '../../../shared/identity';

type TranslationKey = string;
type Translations = Record<string, unknown>;

// Embedded translations for single binary support
const translations: Record<string, Translations> = {
  en: {
    cli: {
      usage: "Usage:",
      serverStart: "{{bin}} [options]           Start server",
      options: "Options:",
      optionPort: "-p, --port <number>    Port number (default: {{port}})",
      optionHost: "-H, --host <address>   Bind address (default: 0.0.0.0)",
      optionPassword: "-P, --password <pass>  Authentication password",
      optionHelp: "-h, --help             Show help",
      optionVersion: "-v, --version          Show version",
      commands: "Commands:",
      cmdSetup: "setup [-P <password>]  Register systemd service",
      cmdStatus: "status                 Show service status",
      cmdUpdate: "update                 Update from GitHub",
      examples: "Examples:",
      exampleStart: "{{bin}}                      Start server (default: {{port}})",
      exampleWithPort: "{{bin}} -p 8080 -P secret    Start on port 8080 with password",
      errorInvalidPort: "Error: Invalid port number",
      errorNoHost: "Error: Host not specified",
      errorNoPassword: "Error: Password not specified",
      errorUnknownOption: "Error: Unknown option: {{option}}",
      errorUnknownCommand: "Error: Unknown command: {{command}}"
    },
    server: {
      tailscaleNotFound: "Error: tailscale command not found",
      tailscaleNotRunning: "Error: Cannot get Tailscale status",
      tailscaleCheckRunning: "Check if Tailscale is running",
      tailscaleParseError: "Error: Cannot parse Tailscale status",
      tailscaleCertError: "Error: Failed to generate Tailscale certificate",
      herdrNotFound: "Error: herdr command not found",
      herdrInstallHint: "Install: curl -fsSL https://herdr.dev/install.sh | sh (or brew install herdr)",
      herdrStartFailed: "Error: failed to start herdr server",
      passwordEnabled: "Password auth: Enabled",
      passwordNotSet: "Password not set: Use -P option to set",
      serverStarting: "Server starting on {{url}}"
    },
    setup: {
      herdrTitle: "🐑 herdr backend setup",
      herdrNotFound: "⚠️  herdr was not found. Install it first:",
      herdrInstallHint: "curl -fsSL https://herdr.dev/install.sh | sh (or brew install herdr)",
      herdrConfigCreated: "✅ Created herdr config: {{path}}",
      herdrConfigMissingResume: "⚠️  Existing herdr config.toml has no resume_agents_on_restore.",
      herdrConfigResumeHint: "   Add [session] resume_agents_on_restore = true",
      herdrServiceFile: "✅ herdr service file: {{path}}",
      herdrAlreadyRunning: "⚠️  herdr server is already running outside launchd. Switch manually:",
      herdrSystemdOutside: "⚠️  herdr server is running outside systemd. Switch manually:",
      herdrStartedLaunchd: "✅ Started herdr server with launchd",
      herdrEnabledSystemd: "✅ Enabled herdr service with systemd",
      herdrStartFailed: "⚠️  Failed to start herdr service",
      herdrIntegrationConfigured: "✅ Configured herdr {{agent}} integration",
      herdrIntegrationFailed: "⚠️  Failed to install herdr {{agent}} integration:",
      agentsNotInitialized: "⚠️  {{agents}} are installed, but their configuration is not initialized.",
      agentsNotFound: "⚠️  Claude Code / Codex were not found.",
      agentInitHint: "   Start an agent once, then run {{bin}} setup again",
      codexHooksMigrated: "✅ Merged Codex hooks into ~/.codex/hooks.json",
      codexHooksMigrationFailed: "⚠️  Failed to merge Codex hooks into hooks.json:",
      macTitle: "🔧 {{product}} setup (macOS)",
      keychainSaved: "🔐 Saved password to Keychain (service: {{keychain}})",
      keychainFailed: "⚠️  Failed to save password to Keychain",
      serviceFile: "✅ Service file: {{path}}",
      updateServiceFile: "✅ Update service file: {{path}}",
      serviceStarted: "✅ Service started",
      serviceStartFailed: "⚠️  Failed to start service",
      autoUpdateEnabled: "✅ Automatic updates enabled (daily at 4:00)",
      managementCommands: "📋 Management commands:",
      herdrManualSwitch: "   (Agent conversations resume automatically when resume_agents_on_restore is enabled)",
      setupTitle: "🔧 {{product}} setup",
      envFile: "✅ Environment file: {{path}}",
      updateTimerFile: "✅ Update timer file: {{path}}",
      autoUpdateTimerEnabled: "✅ Automatic update timer enabled",
      serviceEnableFailed: "⚠️  Failed to enable service",
      serviceEnabled: "Service enabled and started",
      commands: "Commands:",
      cmdRestart: "systemctl --user restart {{service}}   # Restart",
      cmdStop: "systemctl --user stop {{service}}      # Stop",
      cmdLogs: "journalctl --user -u {{service}} -f    # View logs",
      enablingAutostart: "Enabling autostart on boot...",
      autostartEnabled: "Autostart on boot enabled",
      autostartFailed: "Failed to enable autostart. Run manually:",
      autostartCommand: "loginctl enable-linger $USER",
      passwordNotSetEnv: "Password not set: Edit ~/.config/{{configDir}}/env"
    },
    uninstall: {
      title: "{{product}} Uninstall",
      removedService: "Removed service",
      removedUpdate: "Removed update service",
      removedTimer: "Removed update timer",
      notFound: "Not found (skipped)",
      done: "Service uninstalled successfully",
      logsHint: "To remove logs and data",
      configHint: "To remove config"
    },
    status: {
      startCommand: "To start: systemctl --user start {{service}}",
      tailscaleConnected: "Tailscale: Connected",
      tailscaleDisconnected: "Tailscale: Disconnected"
    },
    update: {
      githubConnectionFailed: "Failed to connect to GitHub API",
      serviceRestarted: "Service restarted",
      manualRestartRequired: "Manual restart required: systemctl --user restart {{service}}",
      authUsing: "Using GitHub token from {{source}}",
      rateLimitedAnon: "GitHub API rate limit exceeded (60/hr for unauthenticated requests)",
      rateLimitedAuth: "GitHub API rate limit exceeded",
      rateLimitHintAnon: "Hint: Authenticate to raise the limit to 5000/hr",
      rateLimitResetAt: "Resets at: {{time}}"
    },
    usage: {
      limitReached: "Limit reached",
      willHitLimit: "Will hit limit in {{time}} at this pace"
    }
  },
  ja: {
    cli: {
      usage: "使い方:",
      serverStart: "{{bin}} [オプション]           サーバー起動",
      options: "オプション:",
      optionPort: "-p, --port <number>    ポート番号 (デフォルト: {{port}})",
      optionHost: "-H, --host <address>   バインドアドレス (デフォルト: 0.0.0.0)",
      optionPassword: "-P, --password <pass>  認証パスワード",
      optionHelp: "-h, --help             ヘルプを表示",
      optionVersion: "-v, --version          バージョンを表示",
      commands: "コマンド:",
      cmdSetup: "setup [-P <password>]  systemdサービスを登録",
      cmdStatus: "status                 サービス状態を表示",
      cmdUpdate: "update                 GitHubから更新",
      examples: "例:",
      exampleStart: "{{bin}}                      サーバー起動（本番: {{port}}）",
      exampleWithPort: "{{bin}} -p 8080 -P secret    ポート8080、パスワード付きで起動",
      errorInvalidPort: "エラー: 無効なポート番号",
      errorNoHost: "エラー: ホストが指定されていません",
      errorNoPassword: "エラー: パスワードが指定されていません",
      errorUnknownOption: "エラー: 不明なオプション: {{option}}",
      errorUnknownCommand: "エラー: 不明なコマンド: {{command}}"
    },
    server: {
      tailscaleNotFound: "エラー: tailscale コマンドが見つかりません",
      tailscaleNotRunning: "エラー: Tailscale の状態を取得できません",
      tailscaleCheckRunning: "Tailscale が起動しているか確認してください",
      tailscaleParseError: "エラー: Tailscale のステータスを解析できません",
      tailscaleCertError: "エラー: Tailscale 証明書の生成に失敗しました",
      herdrNotFound: "エラー: herdr コマンドが見つかりません",
      herdrInstallHint: "インストール: curl -fsSL https://herdr.dev/install.sh | sh (または brew install herdr)",
      herdrStartFailed: "エラー: herdr サーバの起動に失敗しました",
      passwordEnabled: "パスワード認証: 有効",
      passwordNotSet: "パスワード未設定: -P オプションで設定を推奨",
      serverStarting: "サーバー起動: {{url}}"
    },
    setup: {
      herdrTitle: "🐑 herdr バックエンドのセットアップ",
      herdrNotFound: "⚠️  herdr が見つかりません。先にインストールしてください:",
      herdrInstallHint: "curl -fsSL https://herdr.dev/install.sh | sh (または brew install herdr)",
      herdrConfigCreated: "✅ herdr 設定を作成: {{path}}",
      herdrConfigMissingResume: "⚠️  既存の herdr config.toml に resume_agents_on_restore がありません。",
      herdrConfigResumeHint: "   [session] resume_agents_on_restore = true を追加してください",
      herdrServiceFile: "✅ herdr サービスファイル: {{path}}",
      herdrAlreadyRunning: "⚠️  herdr サーバが launchd 管理外です。切替は手動で行ってください:",
      herdrSystemdOutside: "⚠️  herdr サーバが systemd 管理外で稼働中です。切替は手動で:",
      herdrStartedLaunchd: "✅ herdr サーバを launchd で起動しました",
      herdrEnabledSystemd: "✅ herdr サーバを systemd で常駐化しました",
      herdrStartFailed: "⚠️  herdr サービスの起動に失敗しました",
      herdrIntegrationConfigured: "✅ herdr {{agent}} integration を設定しました",
      herdrIntegrationFailed: "⚠️  herdr {{agent}} integration の設定に失敗しました:",
      agentsNotInitialized: "⚠️  {{agents}} はインストールされていますが、設定が初期化されていません。",
      agentsNotFound: "⚠️  Claude Code / Codex が見つかりません。",
      agentInitHint: "   エージェントを一度起動してから {{bin}} setup を再実行してください",
      codexHooksMigrated: "✅ Codex hook を ~/.codex/hooks.json に統合しました",
      codexHooksMigrationFailed: "⚠️  Codex hook の hooks.json 統合に失敗しました:",
      macTitle: "🔧 {{product}} セットアップ (macOS)",
      keychainSaved: "🔐 パスワードを Keychain に保存しました (service: {{keychain}})",
      keychainFailed: "⚠️  Keychain への保存に失敗しました",
      serviceFile: "✅ サービスファイル: {{path}}",
      updateServiceFile: "✅ 更新サービスファイル: {{path}}",
      serviceStarted: "✅ サービスを起動しました",
      serviceStartFailed: "⚠️  サービスの起動に失敗しました",
      autoUpdateEnabled: "✅ 自動更新を有効化しました（毎日4:00）",
      managementCommands: "📋 管理コマンド:",
      herdrManualSwitch: "   (resume_agents_on_restore 有効ならエージェント会話は自動復元されます)",
      setupTitle: "🔧 {{product}} セットアップ",
      envFile: "✅ 環境変数ファイル: {{path}}",
      updateTimerFile: "✅ 更新タイマーファイル: {{path}}",
      autoUpdateTimerEnabled: "✅ 自動更新タイマーを有効化しました",
      serviceEnableFailed: "⚠️  サービスの有効化に失敗しました",
      serviceEnabled: "サービスを有効化・起動しました",
      commands: "コマンド:",
      cmdRestart: "systemctl --user restart {{service}}   # 再起動",
      cmdStop: "systemctl --user stop {{service}}      # 停止",
      cmdLogs: "journalctl --user -u {{service}} -f    # ログ表示",
      enablingAutostart: "PC起動時の自動起動を有効化中...",
      autostartEnabled: "PC起動時の自動起動を有効化しました",
      autostartFailed: "自動起動の有効化に失敗しました。手動で実行してください:",
      autostartCommand: "loginctl enable-linger $USER",
      passwordNotSetEnv: "パスワード未設定: ~/.config/{{configDir}}/env を編集してください"
    },
    uninstall: {
      title: "{{product}} アンインストール",
      removedService: "サービスを削除しました",
      removedUpdate: "更新サービスを削除しました",
      removedTimer: "更新タイマーを削除しました",
      notFound: "見つかりません（スキップ）",
      done: "サービスのアンインストールが完了しました",
      logsHint: "ログとデータを削除するには",
      configHint: "設定を削除するには"
    },
    status: {
      startCommand: "起動するには: systemctl --user start {{service}}",
      tailscaleConnected: "Tailscale: 接続中",
      tailscaleDisconnected: "Tailscale: 未接続"
    },
    update: {
      githubConnectionFailed: "GitHub APIへの接続に失敗しました",
      serviceRestarted: "サービスを再起動しました",
      manualRestartRequired: "手動で再起動してください: systemctl --user restart {{service}}",
      authUsing: "GitHub token を使用中 (取得元: {{source}})",
      rateLimitedAnon: "GitHub API のレート制限に到達しました (未認証時は 60/時)",
      rateLimitedAuth: "GitHub API のレート制限に到達しました",
      rateLimitHintAnon: "ヒント: 認証すると上限が 5000/時 に拡大されます",
      rateLimitResetAt: "リセット時刻: {{time}}"
    },
    usage: {
      limitReached: "リミット到達中",
      willHitLimit: "このペースで{{time}}後にリミット到達"
    }
  }
};

// Detect language from environment
function detectLanguage(): string {
  const langEnv = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';

  // Check for Japanese locale (ja_JP, ja_JP.UTF-8, etc.)
  if (langEnv.startsWith('ja')) {
    return 'ja';
  }

  // Default to English
  return 'en';
}

const currentLanguage = detectLanguage();

// Get nested value from object using dot notation
function getNestedValue(obj: Translations, key: string): string | undefined {
  const parts = key.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return typeof current === 'string' ? current : undefined;
}

// Translation function with interpolation support
/**
 * Always available to every message, so the catalog can name the product
 * without hard-coding it (#459) and no call site has to remember to pass it.
 *
 * Note for a rename: the CLI help aligns its columns with literal spaces, so a
 * name of a different length needs those adjusted. `cchub` and `hrdle` are both
 * five characters, which is luck rather than design.
 */
const IDENTITY_PARAMS: Record<string, string | number> = {
  product: IDENTITY.productName,
  bin: IDENTITY.binaryName,
  port: IDENTITY.defaultPort,
  service: SERVICE.systemctl,
  configDir: IDENTITY.configDirName,
  keychain: IDENTITY.keychainService,
};

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const translation = getNestedValue(translations[currentLanguage], key)
    || getNestedValue(translations.en, key)
    || key;

  // Caller-supplied values win, so a message can override one of these if it
  // ever needs to talk about something other than the running build.
  const values = params ? { ...IDENTITY_PARAMS, ...params } : IDENTITY_PARAMS;

  // Replace {{param}} with values
  return translation.replace(/\{\{(\w+)\}\}/g, (_, paramKey) => {
    return values[paramKey]?.toString() ?? `{{${paramKey}}}`;
  });
}
