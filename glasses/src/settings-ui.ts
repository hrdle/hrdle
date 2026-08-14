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
  // A provider's own box, nested inside the voice-input section: the border
  // is what says "these fields belong to the choice above".
  subsection:
    'background:#0c0c0c;border:1px solid #2a2a2a;border-radius:10px;padding:12px;margin-top:14px;',
  h3: 'font-size:13px;color:#ddd;margin:0 0 8px;font-weight:600;',
  // The line as it goes out: read-only, wrapping, and monospaced so a term cut
  // by the budget is visible as a term rather than as prose.
  preview:
    'margin-top:8px;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#bbb;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;white-space:pre-wrap;word-break:break-word;',
}

/**
 * Two sections: the glasses screen, and voice input. Inside voice input the
 * two transcribers are their own nested boxes under a provider choice -
 * language and vocabulary sit above them because they travel with the speech
 * to whichever box is chosen.
 */
export function settingsPanelHtml(): string {
  return `
    <div id="glasses-screen-settings" style="${S.section}">
      <h2 style="${S.h2}">${t('settings.glassesTitle')}</h2>
      <label style="${S.label}" for="screen-off-seconds">${t('settings.screenOff')}</label>
      <p style="${S.sub}">${t('settings.screenOffHint')}</p>
      <input id="screen-off-seconds" type="number" inputmode="numeric" min="0" max="3600" step="1" style="${S.input}" />
      <div style="${S.row}">
        <button type="button" id="screen-off-save" style="${S.btn}">${t('settings.screenOffSave')}</button>
      </div>
      <div id="screen-off-status" style="${S.status}"></div>
    </div>

    <div id="stt-settings" style="${S.section}">
      <h2 style="${S.h2}">${t('settings.title')}</h2>
      <p style="${S.sub}">${t('settings.subtitle')}</p>

      <label style="${S.label}" for="stt-provider">${t('settings.provider')}</label>
      <select id="stt-provider" style="${S.input}">
        <option value="groq">${t('settings.providerGroq')}</option>
        <option value="custom">${t('settings.providerCustom')}</option>
      </select>
      <label style="${S.toggle}">
        <input type="checkbox" id="stt-fallback" />
        <span>${t('settings.fallbackToggle')}</span>
      </label>
      <!-- Where speech goes right now - the one line that joins the choice
           above to the two boxes below. -->
      <div id="stt-destination" style="${S.status}"></div>

      <label style="${S.label}" for="stt-lang">${t('settings.lang')}</label>
      <select id="stt-lang" style="${S.input}">
        ${LANGS.map((l) => `<option value="${l.value}">${t(l.labelKey)}</option>`).join('')}
      </select>
      <div id="stt-lang-status" style="${S.status}"></div>

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

      <div id="stt-groq-settings" style="${S.subsection}">
        <h3 style="${S.h3}">${t('settings.groqTitle')}</h3>
        <p style="${S.sub}">${t('settings.groqSubtitle')}</p>

        <label style="${S.label}" for="stt-key">${t('settings.key')}</label>
        <input id="stt-key" type="password" autocomplete="off" placeholder="gsk_..." style="${S.input}" />
        <div style="${S.row}">
          <button type="button" id="stt-key-save" style="${S.btn}">${t('settings.keySave')}</button>
          <button type="button" id="stt-key-clear" style="${S.btnGhost}">${t('settings.keyClear')}</button>
        </div>
        <div id="stt-key-status" style="${S.status}"></div>

        <label style="${S.label}" for="stt-model">${t('settings.model')}</label>
        <!-- Options come from the server's own list, so this app cannot offer a
             model the server would reject. Filled in by wireSettingsPanel(). -->
        <select id="stt-model" style="${S.input}"></select>
        <div id="stt-model-status" style="${S.status}"></div>
      </div>

      <div id="stt-custom-settings" style="${S.subsection}">
        <h3 style="${S.h3}">${t('settings.endpoint')}</h3>
        <p style="${S.sub}">${t('settings.endpointHint')}</p>
        <label style="${S.label}" for="stt-endpoint-url">${t('settings.endpointUrl')}</label>
        <input id="stt-endpoint-url" type="url" autocomplete="off" placeholder="https://..." style="${S.input}" />
        <label style="${S.label}" for="stt-endpoint-model">${t('settings.endpointModel')}</label>
        <input id="stt-endpoint-model" type="text" autocomplete="off" placeholder="whisper-1" style="${S.input}" />
        <div style="${S.row}">
          <button type="button" id="stt-endpoint-save" style="${S.btn}">${t('settings.endpointSave')}</button>
          <button type="button" id="stt-endpoint-clear" style="${S.btnGhost}">${t('settings.endpointClear')}</button>
        </div>
        <div id="stt-endpoint-status" style="${S.status}"></div>
        <details style="margin-top:8px;">
          <summary style="${S.sub.replace('margin:0 0 12px;', 'cursor:pointer;')}">${t('settings.endpointSpecTitle')}</summary>
          <div style="${S.sub.replace('margin:0 0 12px;', 'margin:8px 0 0;')}">${t('settings.endpointSpec')}</div>
        </details>
      </div>
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
  const screenOffSeconds = el<HTMLInputElement>('screen-off-seconds')
  const provider = el<HTMLSelectElement>('stt-provider')
  const fallback = el<HTMLInputElement>('stt-fallback')
  const endpointUrl = el<HTMLInputElement>('stt-endpoint-url')
  const endpointModel = el<HTMLInputElement>('stt-endpoint-model')
  if (!key || !lang || !model || !bias || !screenOffSeconds || !provider || !fallback || !endpointUrl || !endpointModel) return

  const keyStatus = el('stt-key-status')
  const langStatus = el('stt-lang-status')
  const modelStatus = el('stt-model-status')
  const screenOffStatus = el('screen-off-status')
  const endpointStatus = el('stt-endpoint-status')
  const destination = el('stt-destination')
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

    screenOffSeconds.value = String(v.screenOffSeconds)
    if (screenOffStatus) {
      // What is set, not what just happened - `render` is the initial paint as
      // well as the one after a save, and the save's own line is written by the
      // handler that performed it.
      screenOffStatus.textContent =
        v.screenOffSecondsSource !== 'setting'
          ? t('settings.screenOffDefault')
          : v.screenOffSeconds > 0
            ? t('settings.screenOffOn', { seconds: String(v.screenOffSeconds) })
            : t('settings.screenOffNever')
    }

    provider.value = v.sttEndpoint.provider
    fallback.checked = v.sttEndpoint.fallback
    if (destination) {
      destination.textContent = t('settings.destinationLine', {
        destination: v.sttEndpoint.destination,
      })
    }

    endpointUrl.value = v.sttEndpoint.url ?? ''
    endpointModel.value = v.sttEndpoint.model ?? ''
    // The env var can only be replaced by saving a value here, not edited, so
    // the fields still fill in - what the status line says is where today's
    // answer came from and where speech is going right now.
    if (endpointStatus) {
      endpointStatus.textContent =
        v.sttEndpoint.source === 'none'
          ? t('settings.endpointNone')
          : t(v.sttEndpoint.source === 'env' ? 'settings.endpointEnv' : 'settings.endpointSaved', {
              destination: v.sttEndpoint.destination,
            })
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

  el('screen-off-save')?.addEventListener('click', async () => {
    // Validated here as well as at the server, because the server's answer to
    // a bad number is a 400 whose message is for a machine. Emptiness first:
    // Number('') is 0, which would silently save "never turn off".
    const raw = screenOffSeconds.value.trim()
    const seconds = Number(raw)
    if (raw === '' || !Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      if (screenOffStatus) screenOffStatus.textContent = t('settings.screenOffInvalid')
      return
    }
    try {
      render(await putGlassesSettings({ screenOffSeconds: seconds }))
      if (screenOffStatus) screenOffStatus.textContent = t('settings.screenOffSaved')
    } catch (err) {
      fail(screenOffStatus, err)
    }
  })

  provider.addEventListener('change', async () => {
    try {
      render(await putGlassesSettings({ sttProvider: provider.value as 'groq' | 'custom' }))
      await renderPreview()
    } catch (err) {
      fail(destination, err)
    }
  })

  fallback.addEventListener('change', async () => {
    try {
      render(await putGlassesSettings({ sttFallback: fallback.checked ? 'on' : 'off' }))
    } catch (err) {
      fail(destination, err)
    }
  })

  el('stt-endpoint-save')?.addEventListener('click', async () => {
    const url = endpointUrl.value.trim()
    // URL and model travel together: the model belongs to the URL it was
    // written for.
    try {
      render(
        await putGlassesSettings({
          sttEndpointUrl: url || null,
          sttEndpointModel: endpointModel.value.trim() || null,
        }),
      )
      await renderPreview()
    } catch (err) {
      fail(endpointStatus, err)
    }
  })

  el('stt-endpoint-clear')?.addEventListener('click', async () => {
    try {
      render(
        await putGlassesSettings({
          sttEndpointUrl: null,
          sttEndpointModel: null,
        }),
      )
      await renderPreview()
    } catch (err) {
      fail(endpointStatus, err)
    }
  })
}
