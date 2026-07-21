import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveUiPluginFigure } from '@shared/ui-plugin'
import { useUiPluginStore } from '../../store/ui-plugin-store'
import {
  AnimatedWorkLogo,
  KUN_CELEBRATION_DURATIONS_MS,
  KUN_CELEBRATION_VARIANTS,
  KunCelebration,
  KunStateFigure,
  SidebarMascot,
  UI_PLUGIN_CELEBRATION_SLOTS,
  UI_PLUGIN_STATE_SLOTS,
  WORK_LOGO_SWIM_MODES,
  WORK_LOGO_SWIM_MODE_LABEL_KEYS,
  pickKunCelebration
} from './AnimatedWorkLogo'
import { WorkMetaRow } from './message-timeline-cards'

describe('AnimatedWorkLogo', () => {
  it('ships the Kun bird asset used as the default work mark', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const birdFigure = await readFile(new URL('../../../../asset/img/kun_bird.png', import.meta.url))

    expect(pngDimensions(birdFigure)).toEqual({ width: 751, height: 512 })
  })

  it('renders layered logo markup for swim animation', () => {
    const html = renderToStaticMarkup(
      createElement(AnimatedWorkLogo, { active: true, className: 'extra-class', size: 'md' })
    )

    expect(html).toContain('ds-work-logo')
    expect(html).toContain('ds-work-logo-md')
    expect(html).toContain('ds-work-logo-phase-lead')
    expect(html).toContain('is-active')
    expect(html).toContain('extra-class')
    expect(html).toContain('ds-work-logo-gust')
    expect(html).toContain('ds-work-logo-current')
    expect(html).toContain('ds-work-logo-swell')
    expect(html).toContain('ds-work-logo-wave-back')
    expect(html).toContain('ds-work-logo-ripple')
    expect(html).toContain('ds-work-logo-wave-front')
    expect(html).toContain('ds-work-logo-breaker')
    expect(html).toContain('ds-work-logo-wake')
    expect(html).toContain('ds-work-logo-foam')
    expect(html).toContain('ds-work-logo-crest')
    expect(html).toContain('ds-work-logo-splash')
    expect(html).toContain('ds-work-logo-spray')
    expect(html).toContain('ds-work-logo-bubbles')
    expect(html).toContain('ds-work-logo-echo')
    expect(html).toContain('ds-work-logo-track')
    expect(html).toContain('ds-work-logo-body')
    expect(html).toContain('ds-work-logo-image')
    expect(html).toMatch(/ds-work-logo-mode-(propel|sprint|dive|surf)/)
  })

  it('renders the state figures with their kind classes', () => {
    for (const kind of ['greet', 'sleep', 'sit'] as const) {
      const html = renderToStaticMarkup(createElement(KunStateFigure, { kind }))
      expect(html).toContain(`ds-kun-state-${kind}`)
      expect(html).toContain('ds-kun-state-figure')
    }
  })

  describe('UI plugin slot fallback chains', () => {
    const figures = {
      swim: 'data:image/png;base64,SWIM',
      greet: 'data:image/png;base64,GREET'
    }

    it('every surface chain ends at swim so partial skins always resolve', () => {
      const chains = [
        ...Object.values(UI_PLUGIN_STATE_SLOTS),
        ...Object.values(UI_PLUGIN_CELEBRATION_SLOTS)
      ]
      for (const chain of chains) {
        expect(chain[chain.length - 1]).toBe('swim')
      }
    })

    it('resolves missing slots through the chains', () => {
      expect(resolveUiPluginFigure(figures, UI_PLUGIN_STATE_SLOTS.greet)).toBe(figures.greet)
      // sleep 槽位缺失 → 回退链最终落到 swim
      expect(resolveUiPluginFigure(figures, UI_PLUGIN_STATE_SLOTS.sleep)).toBe(figures.swim)
      expect(resolveUiPluginFigure(figures, UI_PLUGIN_CELEBRATION_SLOTS.cheer)).toBe(figures.greet)
      expect(resolveUiPluginFigure(null, UI_PLUGIN_STATE_SLOTS.greet)).toBeNull()
    })

    it('keeps default art when no plugin is active', () => {
      expect(useUiPluginStore.getState().activeRuntime).toBeNull()
      const html = renderToStaticMarkup(createElement(KunStateFigure, { kind: 'greet' }))
      expect(html).not.toContain('data:image')
      expect(html).toContain('ds-kun-state-figure')
    })
  })

  it('pins the swim mode when one is provided', () => {
    const html = renderToStaticMarkup(
      createElement(AnimatedWorkLogo, { active: true, mode: 'dive' })
    )

    expect(html).toContain('ds-work-logo-mode-dive')
  })

  it('renders the sidebar mascot with a state figure', () => {
    const html = renderToStaticMarkup(createElement(SidebarMascot))

    expect(html).toContain('ds-sidebar-mascot')
    expect(html).toMatch(/ds-kun-state-(sit|greet|sleep)/)
  })

  it('renders every celebration variant with a single figure and confetti', () => {
    for (const variant of KUN_CELEBRATION_VARIANTS) {
      const html = renderToStaticMarkup(createElement(KunCelebration, { variant }))
      expect(html).toContain(`ds-kun-celebration-${variant}`)
      expect(html).toContain('is-kun')
      expect(html).toContain('ds-kun-confetti')
      expect(html.match(/<i><\/i>/g)?.length).toBe(10)
      expect(KUN_CELEBRATION_DURATIONS_MS[variant]).toBeGreaterThan(0)
    }
  })

  it('picks valid celebration variants with increasing ids', () => {
    const first = pickKunCelebration()
    const second = pickKunCelebration()

    expect(KUN_CELEBRATION_VARIANTS).toContain(first.variant)
    expect(second.id).toBeGreaterThan(first.id)
  })

  it('maps every swim mode to a status label key in both locales', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const zh = JSON.parse(await readFile(new URL('../../locales/zh/common.json', import.meta.url), 'utf8'))
    const en = JSON.parse(await readFile(new URL('../../locales/en/common.json', import.meta.url), 'utf8'))

    for (const swimMode of WORK_LOGO_SWIM_MODES) {
      const labelKey = WORK_LOGO_SWIM_MODE_LABEL_KEYS[swimMode]
      expect(labelKey).toBeTruthy()
      expect(zh[labelKey]).toBeTruthy()
      expect(en[labelKey]).toBeTruthy()
    }
  })

  it('defaults to a static logo unless active', () => {
    const html = renderToStaticMarkup(createElement(AnimatedWorkLogo))

    expect(html).toContain('ds-work-logo')
    expect(html).toContain('ds-work-logo-phase-lead')
    expect(html).not.toContain('is-active')
  })

  it('keeps wave and splash layers mounted in static state to avoid layout churn', () => {
    const html = renderToStaticMarkup(createElement(AnimatedWorkLogo, { size: 'sm' }))

    expect(html).toContain('ds-work-logo-sm')
    expect(html).toContain('ds-work-logo-gust')
    expect(html).toContain('ds-work-logo-swell')
    expect(html).toContain('ds-work-logo-wave-back')
    expect(html).toContain('ds-work-logo-wave-front')
    expect(html).toContain('ds-work-logo-breaker')
    expect(html).toContain('ds-work-logo-foam')
    expect(html).toContain('ds-work-logo-crest')
    expect(html).toContain('ds-work-logo-splash')
    expect(html).toContain('ds-work-logo-spray')
    expect(html).not.toContain('is-active')
  })

  it('can render a desynchronized trailing phase', () => {
    const html = renderToStaticMarkup(createElement(AnimatedWorkLogo, { active: true, phase: 'trail' }))

    expect(html).toContain('is-active')
    expect(html).toContain('ds-work-logo-phase-trail')
  })

  it('keeps the processing work row as text-only status', () => {
    const html = renderToStaticMarkup(
      createElement(WorkMetaRow, {
        processing: true,
        stepCount: 3,
        expanded: true,
        onToggle: () => undefined
      })
    )

    expect(html).toContain('ds-shiny-text')
    expect(html).not.toContain('ds-work-logo-slot')
  })

  it('keeps the swim animation layers wired in CSS', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const baseShellCss = await readFile(new URL('../../styles/base-shell.css', import.meta.url), 'utf8')

    for (const layer of [
      'gust',
      'swell',
      'wave-front',
      'breaker',
      'wake',
      'foam',
      'waterline',
      'crest',
      'splash',
      'spray',
      'bubbles'
    ]) {
      expect(baseShellCss).toContain(`ds-work-logo-${layer}`)
    }

    expect(baseShellCss).toContain('.ds-work-logo.is-active .ds-work-logo-body::after')
    expect(baseShellCss).toContain('@keyframes ds-work-logo-waterline')
    expect(baseShellCss).not.toContain('ds-work-logo-tail')
    expect(baseShellCss).not.toContain('transform: translateZ(0) scaleX(-1)')
    expect(baseShellCss).toContain('.ds-work-logo.ds-work-logo-mode-sprint')
    expect(baseShellCss).toContain('.ds-work-logo.ds-work-logo-mode-dive')
    expect(baseShellCss).toContain('.ds-work-logo.ds-work-logo-mode-surf')
    expect(baseShellCss).toContain('@keyframes ds-work-logo-sprint-path')
    expect(baseShellCss).toContain('@keyframes ds-work-logo-dive-path')
    expect(baseShellCss).toContain('@keyframes ds-work-logo-dive-figure')
    expect(baseShellCss).toContain('@keyframes ds-work-logo-surf-path')
    expect(baseShellCss).toContain('@keyframes ds-kun-greet-wave')
    expect(baseShellCss).toContain('@keyframes ds-kun-sleep-breathe')
    expect(baseShellCss).toContain('@keyframes ds-kun-sit-sway')
    expect(baseShellCss).toContain('.ds-work-logo:hover')
    expect(baseShellCss).toContain('.ds-kun-state:hover')
    // 确认 ikun 相关 CSS 已彻底移除
    expect(baseShellCss).not.toContain("[data-ikun-mode='on']")
    expect(baseShellCss).not.toContain('ds-ikun-logo')
    expect(baseShellCss).not.toContain('ds-ikun-figure')
    expect(baseShellCss).not.toContain('ds-ikun-state-figure')
    expect(baseShellCss).not.toContain('ds-ikun-cameo')
    expect(baseShellCss).not.toContain('@keyframes ds-ikun')
    expect(baseShellCss).toContain('.ds-kun-celebration-layer')
    expect(baseShellCss).toContain('@keyframes ds-kun-celebrate-cheer')
    expect(baseShellCss).toContain('@keyframes ds-kun-celebrate-lap')
    expect(baseShellCss).toContain('@keyframes ds-kun-celebrate-toast')
    expect(baseShellCss).toContain('@keyframes ds-kun-confetti-burst')
    expect(baseShellCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(baseShellCss).toContain("[data-focus-mode='on'] .ds-kun-celebration-layer")
    expect(baseShellCss).toContain("[data-focus-mode='on'] .ds-kun-state")
    expect(baseShellCss).toContain("[data-focus-mode='on'] .ds-work-logo")
    expect(baseShellCss).toContain("[data-focus-mode='on'] .ds-work-logo-slot:has(.ds-work-logo)")
    expect(baseShellCss).toContain('display: none !important;')
    expect(baseShellCss).not.toContain("[data-focus-mode='on'] .ds-shiny-text")
    expect(baseShellCss).not.toContain("[data-focus-mode='on'] .ds-runtime-wake-shell::before")
  })

  it('keeps generated Kun PNG icon dimensions stable for packaging', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const appIcon = await readFile(new URL('../../../../asset/img/kun.png', import.meta.url))
    const macIcon = await readFile(new URL('../../../../asset/img/kun_mac.png', import.meta.url))
    const trayIcon = await readFile(new URL('../../../../asset/img/kun_tray.png', import.meta.url))

    expect(pngDimensions(appIcon)).toEqual({ width: 1254, height: 1254 })
    expect(pngDimensions(macIcon)).toEqual({ width: 1024, height: 1024 })
    expect(pngDimensions(trayIcon)).toEqual({ width: 954, height: 994 })
  })

  it('ships the Kun state figure assets', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const expected: Record<string, { width: number; height: number }> = {
      kun_greet: { width: 512, height: 460 },
      kun_sleep: { width: 512, height: 390 },
      kun_surf: { width: 512, height: 479 },
      kun_sit: { width: 512, height: 493 }
    }

    for (const [name, dimensions] of Object.entries(expected)) {
      const figure = await readFile(new URL(`../../../../asset/img/${name}.png`, import.meta.url))
      expect(pngDimensions(figure)).toEqual(dimensions)
    }
  })
})

function pngDimensions(buffer: Uint8Array): { width: number; height: number } {
  const signature = [...buffer.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  expect(signature).toBe('89504e470d0a1a0a')
  return {
    width: readUint32BE(buffer, 16),
    height: readUint32BE(buffer, 20)
  }
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0
}
