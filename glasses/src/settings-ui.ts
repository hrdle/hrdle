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

import {
  getGlassesSettings,
  getSttPreview,
  putGlassesSettings,
  type GlassesSettingsView,
  type SttRequestPreview,
} from './api.ts'
import { t } from './i18n.ts'

/** Languages offered. `auto` sends none and lets Whisper detect it. */
const LANGS: Array<{ value: string; labelKey: string }> = [
  { value: 'auto', labelKey: 'settings.langAuto' },
  { value: 'ja', labelKey: 'settings.langJa' },
  { value: 'en', labelKey: 'settings.langEn' },
]

/**
 * Auto screen-off choices, in minutes; `0` never sleeps. A closed set like the
 * models: the server clamps to 0..60 anyway, and a select is one tap where a
 * number field is a keyboard.
 */
const SCREEN_OFF_CHOICES = [0, 1, 3, 5, 10]

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
  toggle:
    'display:flex;align-items:center;gap:8px;font-size:14px;color:#eee;margin-top:4px;cursor:pointer;',
  // The line as it goes out: read-only, wrapping, and monospaced so a term cut
  // by the budget is visible as a term rather than as prose.
  preview:
    'margin-top:8px;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#bbb;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;white-space:pre-wrap;word-break:break-word;',
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

      <label style="${S.label}" for="stt-model">${t('settings.model')}</label>
      <!-- Options come from the server's own list, so this app cannot offer a
           model the server would reject. Filled in by wireSettingsPanel(). -->
      <select id="stt-model" style="${S.input}"></select>
      <div id="stt-model-status" style="${S.status}"></div>

      <span style="${S.label}">${t('settings.bias')}</span>
      <label style="${S.toggle}">
        <input type="checkbox" id="stt-bias" />
        <span>${t('settings.biasToggle')}</span>
      </label>
      <!-- Not an editor: the line comes from the same call the transcription
           makes, so what is shown is what is sent. With no session
           named, that is the glossary every session shares. -->
      <div id="stt-bias-preview" style="${S.preview}"></div>
      <div id="stt-bias-status" style="${S.status}"></div>

      <label style="${S.label}" for="screen-off">${t('settings.screenOff')}</label>
      <select id="screen-off" style="${S.input}">
        ${SCREEN_OFF_CHOICES.map(
          (m) =>
            `<option value="${m}">${m === 0 ? t('settings.screenOffNever') : t('settings.screenOffMinutes', { minutes: String(m) })}</option>`,
        ).join('')}
      </select>
      <div id="screen-off-status" style="${S.status}"></div>
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

/**
 * What the line below the switch is, said from the preview rather than guessed.
 *
 * The three cases are the three the resolver reports, and they are not the same
 * sentence: `off` means nothing is sent, `env` means the server was handed a
 * line to send instead, and `composed` means this is the shared part of one -
 * a session speaking adds its own words in front of it.
 */
function describeBias(p: SttRequestPreview, v: GlassesSettingsView | null): string {
  // Off *and* not by this screen's doing: a disabled switch with no reason
  // beside it is unexplained silence.
  if (p.promptSource === 'off' && v?.sttBiasSource === 'env') return t('settings.biasEnvOff')
  if (p.promptSource === 'off') return t('settings.biasOff')
  if (p.promptSource === 'env') return t('settings.biasEnv')
  return t('settings.biasComposed')
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
  const model = el<HTMLSelectElement>('stt-model')
  const bias = el<HTMLInputElement>('stt-bias')
  const screenOff = el<HTMLSelectElement>('screen-off')
  if (!key || !lang || !model || !bias || !screenOff) return

  const keyStatus = el('stt-key-status')
  const langStatus = el('stt-lang-status')
  const modelStatus = el('stt-model-status')
  const screenOffStatus = el('screen-off-status')
  const biasStatus = el('stt-bias-status')
  const biasPreview = el('stt-bias-preview')

  // The last view, for the one thing the preview cannot say on its own: why it
  // is off. `off` looks the same from down there whoever switched it.
  let current: GlassesSettingsView | null = null

  const render = (v: GlassesSettingsView) => {
    current = v
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

    // The server names the models it accepts; offering any other would be a
    // 400 on every utterance, reported to the wearer as "STT provider error".
    const models = v.sttModels?.length ? v.sttModels : [v.sttModel]
    model.innerHTML = models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join('')
    model.value = v.sttModel
    if (modelStatus) {
      modelStatus.textContent =
        v.sttModelSource === 'setting'
          ? t('settings.modelSaved')
          : t('settings.modelDefault', { model: v.sttModel })
    }

    bias.checked = v.sttBias
    // `HRDLE_STT_PROMPT=off` is a decision made at the process level and this
    // screen cannot undo it, so the switch says so rather than pretending.
    bias.disabled = v.sttBiasSource === 'env'

    // A stored value outside the offered set still has to be shown as itself,
    // or the select would silently claim a timeout the server is not using.
    if (!SCREEN_OFF_CHOICES.includes(v.screenOffMinutes)) {
      screenOff.insertAdjacentHTML(
        'beforeend',
        `<option value="${v.screenOffMinutes}">${t('settings.screenOffMinutes', { minutes: String(v.screenOffMinutes) })}</option>`,
      )
    }
    screenOff.value = String(v.screenOffMinutes)
    if (screenOffStatus) {
      screenOffStatus.textContent =
        v.screenOffMinutesSource === 'setting'
          ? t('settings.screenOffSaved')
          : t('settings.screenOffDefault')
    }
  }

  /**
   * The line itself, asked of the server after every change.
   *
   * A second request rather than a field on the settings response, because it
   * is a different question: this one has an answer per session, and the
   * settings screen is asking the no-session case of it.
   */
  const renderPreview = async () => {
    try {
      const preview = await getSttPreview()
      if (biasPreview) biasPreview.textContent = preview.prompt || t('settings.biasNone')
      if (biasStatus) biasStatus.textContent = describeBias(preview, current)
    } catch (err) {
      fail(biasStatus, err)
    }
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
  await renderPreview()

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

  model.addEventListener('change', async () => {
    try {
      render(await putGlassesSettings({ sttModel: model.value }))
    } catch (err) {
      fail(modelStatus, err)
    }
  })

  bias.addEventListener('change', async () => {
    try {
      render(await putGlassesSettings({ sttBias: bias.checked ? 'on' : 'off' }))
      await renderPreview()
    } catch (err) {
      fail(biasStatus, err)
    }
  })

  screenOff.addEventListener('change', async () => {
    try {
      render(await putGlassesSettings({ screenOffMinutes: Number(screenOff.value) }))
    } catch (err) {
      fail(screenOffStatus, err)
    }
  })
}
