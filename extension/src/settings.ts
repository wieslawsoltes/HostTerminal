export type ThemeName = 'midnight' | 'graphite' | 'paper';
export type Layout = 'single' | 'columns' | 'rows' | 'grid';

export interface ShellProfile {
  id: string;
  name: string;
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface Preferences {
  theme: ThemeName;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  gpuAcceleration: boolean;
  screenReaderMode: boolean;
  confirmMultilinePaste: boolean;
  defaultProfileId: string;
  profiles: ShellProfile[];
}

export const DEFAULT_PROFILE: ShellProfile = {
  id: 'default', name: 'Default shell', shell: '', args: [], cwd: '', env: {},
};

export const DEFAULTS: Preferences = {
  theme: 'midnight',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  lineHeight: 1.18,
  scrollback: 10000,
  cursorStyle: 'bar',
  cursorBlink: true,
  gpuAcceleration: true,
  screenReaderMode: false,
  confirmMultilinePaste: true,
  defaultProfileId: 'default',
  profiles: [DEFAULT_PROFILE],
};

const STORAGE_KEY = 'host-terminal.preferences.v1';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Validate persisted settings, including data imported from another installation. */
export function normalizePreferences(raw: unknown): Preferences {
  const record = isRecord(raw) ? raw : {};
  const profiles: ShellProfile[] = [];
  const ids = new Set<string>();
  if (Array.isArray(record.profiles)) {
    for (const value of record.profiles.slice(0, 50)) {
      if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(value.id) || ids.has(value.id)) continue;
      if (typeof value.name !== 'string' || !value.name.trim() || typeof value.shell !== 'string') continue;
      if (!Array.isArray(value.args) || value.args.length > 128 || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)) continue;
      if (typeof value.cwd !== 'string' || value.cwd.includes('\0') || value.shell.includes('\0') || value.cwd.length > 8192 || value.shell.length > 8192) continue;
      const env: Record<string, string> = Object.create(null);
      if (isRecord(value.env)) {
        for (const [key, data] of Object.entries(value.env).slice(0, 128)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof data === 'string' && !data.includes('\0') && data.length <= 32768) env[key] = data;
        }
      }
      profiles.push({ id: value.id, name: value.name.trim().slice(0, 100), shell: value.shell, args: value.args as string[], cwd: value.cwd, env });
      ids.add(value.id);
    }
  }
  if (profiles.length === 0) profiles.push(structuredClone(DEFAULT_PROFILE));
  const theme = ['midnight', 'graphite', 'paper'].includes(String(record.theme)) ? record.theme as ThemeName : DEFAULTS.theme;
  const cursorStyle = ['block', 'underline', 'bar'].includes(String(record.cursorStyle)) ? record.cursorStyle as Preferences['cursorStyle'] : DEFAULTS.cursorStyle;
  return {
    theme, cursorStyle,
    fontFamily: typeof record.fontFamily === 'string' && record.fontFamily.trim() ? record.fontFamily.slice(0, 500) : DEFAULTS.fontFamily,
    fontSize: Math.round(finite(record.fontSize, DEFAULTS.fontSize, 9, 32)),
    lineHeight: finite(record.lineHeight, DEFAULTS.lineHeight, 1, 2),
    scrollback: Math.round(finite(record.scrollback, DEFAULTS.scrollback, 100, 100000)),
    cursorBlink: typeof record.cursorBlink === 'boolean' ? record.cursorBlink : DEFAULTS.cursorBlink,
    gpuAcceleration: typeof record.gpuAcceleration === 'boolean' ? record.gpuAcceleration : DEFAULTS.gpuAcceleration,
    screenReaderMode: typeof record.screenReaderMode === 'boolean' ? record.screenReaderMode : DEFAULTS.screenReaderMode,
    confirmMultilinePaste: typeof record.confirmMultilinePaste === 'boolean' ? record.confirmMultilinePaste : DEFAULTS.confirmMultilinePaste,
    defaultProfileId: typeof record.defaultProfileId === 'string' && profiles.some(profile => profile.id === record.defaultProfileId) ? record.defaultProfileId : profiles[0]!.id,
    profiles,
  };
}

export async function loadPreferences(): Promise<Preferences> {
  const values = await chrome.storage.local.get(STORAGE_KEY);
  return normalizePreferences(values[STORAGE_KEY]);
}

export async function savePreferences(value: Preferences): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: normalizePreferences(value) });
}

/** Only preferences/profiles are exported. Terminal output is never put into storage. */
export function exportPreferences(value: Preferences): string {
  return JSON.stringify({ format: 'host-terminal-settings', version: 1, preferences: value }, null, 2);
}

export function importPreferences(text: string): Preferences {
  if (text.length > 256 * 1024) throw new Error('Settings file exceeds 256 KiB.');
  const input: unknown = JSON.parse(text);
  if (!isRecord(input) || input.format !== 'host-terminal-settings' || input.version !== 1 || !isRecord(input.preferences)) {
    throw new Error('Choose a Host Terminal settings file (version 1).');
  }
  return normalizePreferences(input.preferences);
}
