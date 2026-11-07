import { storage } from 'wxt/utils/storage';
import { DEFAULT_SETTINGS, type Settings } from './types';

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

/** 翻译缓存：key = `${provider}|${targetLang}|${normalizedText}` */
export const cacheItem = storage.defineItem<Record<string, string>>('local:trcache', {
  fallback: {},
});

export async function loadSettings(): Promise<Settings> {
  const saved = await settingsItem.getValue();
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}
