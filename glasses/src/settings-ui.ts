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

/** Languages offered. `auto` sends none and lets Whisper detect it. */
const LANGS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' },
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
      <h2 style="${S.h2}">Voice input</h2>
      <p style="${S.sub}">Transcription runs on the server through Groq. The key never leaves that host.</p>

      <label style="${S.label}" for="stt-key">Groq API key</label>
      <input id="stt-key" type="password" autocomplete="off" placeholder="gsk_..." style="${S.input}" />
      <div style="${S.row}">
        <button type="button" id="stt-key-save" style="${S.btn}">Save key</button>
        <button type="button" id="stt-key-clear" style="${S.btnGhost}">Clear</button>
      </div>
      <div id="stt-key-status" style="${S.status}"></div>

      <label style="${S.label}" for="stt-lang">Language</label>
      <select id="stt-lang" style="${S.input}">
        ${LANGS.map((l) => `<option value="${l.value}">${l.label}</option>`).join('')}
      </select>
      <div id="stt-lang-status" style="${S.status}"></div>

      <label style="${S.label}" for="stt-prompt">Vocabulary prompt</label>
      <textarea id="stt-prompt" rows="4" style="${S.input};font-family:inherit;resize:vertical;"></textarea>
      <div style="${S.row}">
        <button type="button" id="stt-prompt-save" style="${S.btn}">Save prompt</button>
        <button type="button" id="stt-prompt-reset" style="${S.btnGhost}">Reset</button>
      </div>
      <div id="stt-prompt-status" style="${S.status}"></div>
    </div>
  `
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function describeKey(v: GlassesSettingsView): string {
  if (!v.hasApiKey) return 'No key set - transcription will fail with 503.'
  return v.apiKeySource === 'env'
    ? 'A key is set from the server environment (GROQ_API_KEY). Saving one here overrides it.'
    : 'A key is saved here.'
}

function describePrompt(v: GlassesSettingsView): string {
  if (v.sttPromptSource === 'setting') return 'Using the prompt saved here.'
  if (v.sttPromptSource === 'env') return 'Using HRDLE_STT_PROMPT from the server environment.'
  return 'Using the prompt composed from your workspace names and the glossary.'
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
    key.placeholder = v.hasApiKey ? 'A key is set - type a new one to replace it' : 'gsk_...'
    if (keyStatus) keyStatus.textContent = describeKey(v)

    lang.value = LANGS.some((l) => l.value === v.sttLang) ? v.sttLang : 'auto'
    if (langStatus) {
      langStatus.textContent =
        v.sttLangSource === 'setting'
          ? 'Saved here.'
          : `Server default (${v.sttLang}). Pick one to change it.`
    }

    prompt.value = v.sttPrompt
    // The composed prompt as the placeholder: an empty box means "compose one",
    // and this is what that produces right now.
    prompt.placeholder = v.effectivePrompt || 'off'
    if (promptStatus) promptStatus.textContent = describePrompt(v)
  }

  const fail = (node: HTMLElement | null, err: unknown) => {
    if (node) node.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`
  }

  try {
    render(await getGlassesSettings())
  } catch (err) {
    fail(keyStatus, err)
    return
  }

  el('stt-key-save')?.addEventListener('click', async () => {
    if (!key.value.trim()) {
      if (keyStatus) keyStatus.textContent = 'Nothing to save - the field is empty.'
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
