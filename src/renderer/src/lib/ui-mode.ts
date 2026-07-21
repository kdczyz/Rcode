import { readBrowserStorageItem, writeBrowserStorageItem } from './browser-storage'

/**
 * 形象模式偏好:'default' | 'retroma' | <UI 插件 id>。
 */
export const UI_MODE_STORAGE_KEY = 'kun.uiMode'

export const UI_MODE_DEFAULT = 'default'
/** Retroma 羊皮纸浅色配色模式:纯配色(无吉祥物),仅浅色生效 */
export const UI_MODE_RETROMA = 'retroma'

const UI_MODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/

export function readUiModePreference(): string {
  const stored = readBrowserStorageItem(UI_MODE_STORAGE_KEY)?.trim().toLowerCase()
  if (stored && (stored === UI_MODE_DEFAULT || UI_MODE_PATTERN.test(stored))) {
    return stored
  }
  return UI_MODE_DEFAULT
}

export function writeUiModePreference(mode: string): void {
  writeBrowserStorageItem(UI_MODE_STORAGE_KEY, mode)
}
