// The voice-input settings panel, shared by the phone companion UI and the
// browser simulator.
//
// These three values used to live only in the server's environment, which meant
// changing the language or trying a different vocabulary prompt required editing
// a systemd EnvironmentFile and restarting. They are per-use settings, so they
// belong on a screen. The key is here too because a fresh install otherwise has
// no way to supply one without shell access.
//
// The panel talks to /api/glasses/settings, which returns everything except the
// key itself; what it can say about the key is whether one is set and where it
// came from.

import { getGlassesSettings, putGlassesSettings, type GlassesSettingsView } from './api.ts'
import { t } from './i18n.ts'

/** Languages offered. `auto` sends none and lets Whisper detect it. */
const LANGS: Array<{ value: string; labelKey: string }> = [
  { value: 'auto', labelKey: 'settings.langAuto' },
  { value: 'ja', labelKey: 'settings.langJa' },
  { value: 'en', labelKey: 'settings.langEn' },
]

// The accent is a variable because this panel has two homes with different
// palettes: the phone wizard, which is red like the app icon, and the browser
// simulator, which is green because that is the colour the G2 actually draws in.
// The fallback is the simulator's, so it needs no declaration of its own.
const S = {
  section: 'background:#111;border:1px solid #222;border-radius:12px;padding:16px;margin-bottom:16px;',
  h2: 'font-size:15px;color:var(--panel-accent,#0f0);margin:0 0 4px;font-weight:600;',
  sub: 'font-size:12px;color:#888;margin:0 0 12px;',
  label: 'display:block;font-size:12px;color:#bbb;margin:12px 0 4px;',
  input:
    'width:100%;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee;font-size:14px;box-sizing:border-box;',
  row: 'display:flex;gap:8px;margin-top:8px;',
  btn: 'padding:10px 14px;border-radius:8px;border:none;background:var(--panel-accent-strong,#0a0);color:#fff;font-size:13px;font-weight:600;cursor:pointer;',
  btnGhost:
    'padding:10px 14px;border-radius:8px;border:1px solid #444;background:transparent;color:#aaa;font-size:13px;cursor:pointer;',
  status: 'font-size:12px;color:#888;margin-top:8px;min-height:16px;',
}

/** Markup for the panel. Mount it wherever, then call `wireSettingsPanel()`. */
export function settingsPanelHtml(): string {
  return `
    <div id="stt-settings" style="${S.section}">
      <h2 style="${S.h2}">${t('settings.title')}</h2>
      <p style="${S.sub}">${t('settings.subtitle')}</p>

      <label style="${S.label}" for="stt-key">${t('settings.key')}</label>
      <input id="stt-key" type="password" autocomplete="off" placeholder="gsk_..." style="${S.input}" />
      <div style="${S.row}">
        <button type="button" id="stt-key-save" style="${S.btn}">${t('settings.keySave')}</button>
        <button type="button" id="stt-key-clear" style="${S.btnGhost}">${t('settings.keyClear')}</button>
      </div>
      <div id="stt-key-status" style="${S.status}"></div>

      <label style="${S.label}" for="stt-lang">${t('settings.lang')}</label>
      <select id="stt-lang" style="${S.input}">
        ${LANGS.map((l) => `<option value="${l.value}">${t(l.labelKey)}</option>`).join('')}
      </select>
      <div id="stt-lang-status" style="${S.status}"></div>

      <label style="${S.label}" for="stt-prompt">${t('settings.prompt')}</label>
      <textarea id="stt-prompt" rows="4" style="${S.input};font-family:inherit;resize:vertical;"></textarea>
      <div style="${S.row}">
        <button type="button" id="stt-prompt-save" style="${S.btn}">${t('settings.promptSave')}</button>
        <button type="button" id="stt-prompt-reset" style="${S.btnGhost}">${t('settings.promptReset')}</button>
      </div>
      <div id="stt-prompt-status" style="${S.status}"></div>
    </div>
  `
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function describeKey(v: GlassesSettingsView): string {
  if (!v.hasApiKey) return t('settings.keyNone')
  return v.apiKeySource === 'env' ? t('settings.keyEnv') : t('settings.keySaved')
}

function describePrompt(v: GlassesSettingsView): string {
  if (v.sttPromptSource === 'off') return t('settings.promptOff')
  if (v.sttPromptSource === 'env') return t('settings.promptEnv')
  return t('settings.promptComposed')
}

/**
 * Wire the panel up. Loads the current settings, then saves on demand.
 *
 * Every save round-trips the server's own view back into the fields, so what
 * the panel shows is what the next transcription will use rather than what was
 * typed.
 */
export async function wireSettingsPanel(): Promise<void> {
  const key = el<HTMLInputElement>('stt-key')
  const lang = el<HTMLSelectElement>('stt-lang')
  const prompt = el<HTMLTextAreaElement>('stt-prompt')
  if (!key || !lang || !prompt) return

  const keyStatus = el('stt-key-status')
  const langStatus = el('stt-lang-status')
  const promptStatus = el('stt-prompt-status')

  const render = (v: GlassesSettingsView) => {
    key.value = ''
    key.placeholder = v.hasApiKey ? t('settings.keyPlaceholderSet') : 'gsk_...'
    if (keyStatus) keyStatus.textContent = describeKey(v)

    lang.value = LANGS.some((l) => l.value === v.sttLang) ? v.sttLang : 'auto'
    if (langStatus) {
      langStatus.textContent =
        v.sttLangSource === 'setting'
          ? t('settings.langSaved')
          : t('settings.langDefault', { lang: v.sttLang })
    }

    prompt.value = v.sttPrompt
    // The whole line as the placeholder: an empty box is not an empty prompt,
    // and this is what would go out right now with these words folded in.
    prompt.placeholder = v.effectivePrompt || 'off'
    if (promptStatus) promptStatus.textContent = describePrompt(v)
  }

  const fail = (node: HTMLElement | null, err: unknown) => {
    if (node) {
      node.textContent = t('settings.failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    render(await getGlassesSettings())
  } catch (err) {
    fail(keyStatus, err)
    return
  }

  el('stt-key-save')?.addEventListener('click', async () => {
    if (!key.value.trim()) {
      if (keyStatus) keyStatus.textContent = t('settings.keyEmpty')
      return
    }
    try {
      render(await putGlassesSettings({ groqApiKey: key.value }))
    } catch (err) {
      fail(keyStatus, err)
    }
  })

  el('stt-key-clear')?.addEventListener('click', async () => {
    try {
      render(await putGlassesSettings({ groqApiKey: null }))
    } catch (err) {
      fail(keyStatus, err)
    }
  })

  lang.addEventListener('change', async () => {
    try {
      render(await putGlassesSettings({ sttLang: lang.value }))
    } catch (err) {
      fail(langStatus, err)
    }
  })

  el('stt-prompt-save')?.addEventListener('click', async () => {
    try {
      render(await putGlassesSettings({ sttPrompt: prompt.value }))
    } catch (err) {
      fail(promptStatus, err)
    }
  })

  el('stt-prompt-reset')?.addEventListener('click', async () => {
    try {
      render(await putGlassesSettings({ sttPrompt: null }))
    } catch (err) {
      fail(promptStatus, err)
    }
  })
}
