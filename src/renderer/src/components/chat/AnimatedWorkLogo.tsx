import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UiPluginFigureSlot } from '@shared/ui-plugin'
import { useUiPluginFigure } from '../../store/ui-plugin-store'
import kunLogo from '../../../../asset/img/kun_bird.png'
import kunSurfFigure from '../../../../asset/img/kun_surf.png'
import kunGreetFigure from '../../../../asset/img/kun_greet.png'
import kunSleepFigure from '../../../../asset/img/kun_sleep.png'
import kunSitFigure from '../../../../asset/img/kun_sit.png'

/* UI 插件按槽位覆盖默认 Kun 形象时的回退链 */
export const UI_PLUGIN_STATE_SLOTS: Record<KunStateFigureKind, readonly UiPluginFigureSlot[]> = {
  greet: ['greet', 'swim'],
  sleep: ['sleep', 'sit', 'swim'],
  sit: ['sit', 'greet', 'swim']
}

export type WorkLogoSwimMode = 'propel' | 'sprint' | 'dive' | 'surf'

export const WORK_LOGO_SWIM_MODES: readonly WorkLogoSwimMode[] = [
  'propel',
  'sprint',
  'dive',
  'surf'
]

export const WORK_LOGO_SWIM_MODE_LABEL_KEYS: Record<WorkLogoSwimMode, string> = {
  propel: 'working',
  sprint: 'workingSprint',
  dive: 'workingDive',
  surf: 'workingSurf'
}

const WORK_LOGO_SWIM_MODE_INTERVAL_MS = 4200

export function useWorkLogoSwimMode(active: boolean): WorkLogoSwimMode {
  // 起点随机,避免每次都从「推进中」开始;之后按顺序轮播
  const [modeIndex, setModeIndex] = useState(() =>
    Math.floor(Math.random() * WORK_LOGO_SWIM_MODES.length)
  )

  useEffect(() => {
    if (!active) return
    const interval = window.setInterval(() => {
      setModeIndex((current) => (current + 1) % WORK_LOGO_SWIM_MODES.length)
    }, WORK_LOGO_SWIM_MODE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [active])

  return WORK_LOGO_SWIM_MODES[modeIndex] ?? 'propel'
}

export type KunStateFigureKind = 'greet' | 'sleep' | 'sit'

const KUN_STATE_FIGURES: Record<KunStateFigureKind, string> = {
  greet: kunGreetFigure,
  sleep: kunSleepFigure,
  sit: kunSitFigure
}

/** 静态场景里的 Kun 形象:打招呼(欢迎)、睡觉(运行时待唤醒)、坐着(空状态) */
export function KunStateFigure({
  kind,
  className = ''
}: {
  kind: KunStateFigureKind
  className?: string
}): ReactElement {
  // UI 插件激活时按槽位覆盖默认 Kun 美术
  const kunFigureSrc = useUiPluginFigure(UI_PLUGIN_STATE_SLOTS[kind], KUN_STATE_FIGURES[kind])
  return (
    <span
      className={['ds-kun-state', `ds-kun-state-${kind}`, className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <img
        className="ds-kun-state-figure"
        src={kunFigureSrc}
        alt=""
        draggable={false}
        decoding="async"
      />
    </span>
  )
}

export type KunCelebrationVariant = 'cheer' | 'lap' | 'toast'

export const KUN_CELEBRATION_VARIANTS: readonly KunCelebrationVariant[] = [
  'cheer',
  'lap',
  'toast'
]

/* 与 CSS 里 forwards 动画总时长一致 */
export const KUN_CELEBRATION_DURATIONS_MS: Record<KunCelebrationVariant, number> = {
  cheer: 3200,
  lap: 3600,
  toast: 3400
}

/* 每种庆祝的形象映射 */
const KUN_CELEBRATION_FIGURES: Record<KunCelebrationVariant, string> = {
  cheer: kunGreetFigure,
  lap: kunSurfFigure,
  toast: kunSitFigure
}

/* 回合至少跑这么久才庆祝,避免秒回也放彩带 */
const KUN_CELEBRATION_MIN_TURN_MS = 2000

let kunCelebrationSequence = 0

export function pickKunCelebration(): { id: number; variant: KunCelebrationVariant } {
  const variant =
    KUN_CELEBRATION_VARIANTS[Math.floor(Math.random() * KUN_CELEBRATION_VARIANTS.length)] ??
    'cheer'
  kunCelebrationSequence += 1
  return { id: kunCelebrationSequence, variant }
}

function KunConfettiBurst(): ReactElement {
  return (
    <span className="ds-kun-confetti">
      {Array.from({ length: 10 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  )
}

/* 庆祝戏码的插件槽位回退链 */
export const UI_PLUGIN_CELEBRATION_SLOTS: Record<KunCelebrationVariant, readonly UiPluginFigureSlot[]> = {
  cheer: ['greet', 'swim'],
  lap: ['run', 'surf', 'swim'],
  toast: ['sit', 'greet', 'swim']
}

/** 单场庆祝:跃起欢呼 / 胜利冲浪 / 举杯庆功 */
export function KunCelebration({ variant }: { variant: KunCelebrationVariant }): ReactElement {
  const kunFigureSrc = useUiPluginFigure(UI_PLUGIN_CELEBRATION_SLOTS[variant], KUN_CELEBRATION_FIGURES[variant])
  return (
    <span className={`ds-kun-celebration ds-kun-celebration-${variant}`}>
      <span className="ds-kun-celebration-figure-wrap">
        <img
          className="ds-kun-celebration-figure is-kun"
          src={kunFigureSrc}
          alt=""
          draggable={false}
          decoding="async"
        />
        <KunConfettiBurst />
      </span>
    </span>
  )
}

/** 回合完成庆祝层:active(busy)从 true 落回 false 且跑得够久时,随机放一段 */
export function KunCelebrationLayer({
  active,
  suppressed = false
}: {
  active: boolean
  suppressed?: boolean
}): ReactElement {
  const [celebration, setCelebration] = useState<{
    id: number
    variant: KunCelebrationVariant
  } | null>(null)
  const turnStartRef = useRef<number | null>(null)
  const hideTimerRef = useRef(0)

  useEffect(() => {
    if (active) {
      turnStartRef.current = Date.now()
      return
    }
    if (turnStartRef.current === null) return
    const elapsed = Date.now() - turnStartRef.current
    turnStartRef.current = null
    if (suppressed) return
    if (elapsed < KUN_CELEBRATION_MIN_TURN_MS) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const next = pickKunCelebration()
    setCelebration(next)
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => {
      setCelebration(null)
    }, KUN_CELEBRATION_DURATIONS_MS[next.variant])
  }, [active, suppressed])

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), [])

  return (
    <span className="ds-kun-celebration-layer" aria-hidden="true">
      {celebration ? <KunCelebration key={celebration.id} variant={celebration.variant} /> : null}
    </span>
  )
}

const SIDEBAR_MASCOT_KINDS: readonly KunStateFigureKind[] = ['sit', 'greet', 'sleep']
const SIDEBAR_MASCOT_INTERVAL_MS = 10000

/** 侧边栏角落的吉祥物:循环 坐着→打招呼→睡觉 */
export function SidebarMascot(): ReactElement {
  const [kindIndex, setKindIndex] = useState(() =>
    Math.floor(Math.random() * SIDEBAR_MASCOT_KINDS.length)
  )

  useEffect(() => {
    const interval = window.setInterval(() => {
      setKindIndex((current) => (current + 1) % SIDEBAR_MASCOT_KINDS.length)
    }, SIDEBAR_MASCOT_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [])

  const kind = SIDEBAR_MASCOT_KINDS[kindIndex] ?? 'sit'
  return <KunStateFigure key={kind} kind={kind} className="ds-sidebar-mascot" />
}

export function AnimatedWorkLogo({
  active = false,
  className = '',
  mode,
  phase = 'lead',
  size = 'sm'
}: {
  active?: boolean
  className?: string
  mode?: WorkLogoSwimMode
  phase?: 'lead' | 'trail'
  size?: 'sm' | 'md'
}): ReactElement {
  const rotatedSwimMode = useWorkLogoSwimMode(active && mode === undefined)
  const swimMode = mode ?? rotatedSwimMode
  const figureSrc = useUiPluginFigure(
    swimMode === 'surf' ? ['surf', 'swim'] : ['swim'],
    swimMode === 'surf' ? kunSurfFigure : kunLogo
  )

  return (
    <span
      className={[
        'ds-work-logo',
        `ds-work-logo-${size}`,
        `ds-work-logo-phase-${phase}`,
        `ds-work-logo-mode-${swimMode}`,
        active ? 'is-active' : '',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
    >
      <span className="ds-work-logo-gust" />
      <span className="ds-work-logo-current" />
      <span className="ds-work-logo-swell" />
      <span className="ds-work-logo-wave ds-work-logo-wave-back" />
      <span className="ds-work-logo-ripple" />
      <span className="ds-work-logo-wave ds-work-logo-wave-front" />
      <span className="ds-work-logo-breaker" />
      <span className="ds-work-logo-wake" />
      <span className="ds-work-logo-foam" />
      <span className="ds-work-logo-crest" />
      <span className="ds-work-logo-splash" />
      <span className="ds-work-logo-spray" />
      <span className="ds-work-logo-bubbles" />
      <img className="ds-work-logo-echo" src={figureSrc} alt="" draggable={false} decoding="async" />
      <span className="ds-work-logo-track">
        <span className="ds-work-logo-body">
          <img className="ds-work-logo-image" src={figureSrc} alt="" draggable={false} decoding="async" />
        </span>
      </span>
    </span>
  )
}
