export const HOST_NAME = 'com.host_terminal.host';
export const PROTOCOL_VERSION = 1;
export const UI_PORT_NAME = 'host-terminal-ui-v1';
export const MAX_INPUT_BYTES = 64 * 1024;

export interface ShellInfo { name: string; path: string; args: string[] }
export interface HostInfo {
  protocol: number;
  version: string;
  os: string;
  arch: string;
  home: string;
  defaultShell: string;
  shells: ShellInfo[];
  limits: { maxSessions: number; maxInputBytes: number; outputWindowBytes: number };
}
export interface SessionInfo {
  id: string;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  pid: number | null;
  createdAt: number;
  exited: boolean;
  exitCode?: number | null;
}
export interface OutputEvent { type: 'output'; sessionId: string; data: string; seq: number }
export interface ExitEvent { type: 'exit'; sessionId: string; exitCode: number }
export interface DisconnectEvent { type: 'disconnected'; message: string }
export interface BridgeStatus { enabled: boolean; port?: number; descriptorPath?: string }
export interface SessionsChangedEvent { type: 'sessionsChanged' }
export interface BridgeStatusEvent { type: 'bridgeStatusChanged'; status: BridgeStatus }
export type HostEvent = OutputEvent | ExitEvent | DisconnectEvent | SessionsChangedEvent | BridgeStatusEvent;
export interface ReplayChunk { data: string; seq: number }
export interface AttachResult { session: SessionInfo; replay: ReplayChunk[]; truncated: boolean }
export interface ProtocolError { code: string; message: string }
export type Result = { type: 'result'; id: string; ok: true; value: unknown } |
  { type: 'result'; id: string; ok: false; error: ProtocolError };
export interface Request { type: string; id?: string; [key: string]: unknown }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The host enforces the same boundary; this avoids oversized extension IPC first. */
export function validateRequest(value: unknown): Request {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('Invalid request');
  if (value.id !== undefined && (typeof value.id !== 'string' || value.id.length > 128)) {
    throw new Error('Invalid request ID');
  }
  const types = new Set(['connect', 'hello', 'list', 'create', 'input', 'resize', 'rename', 'close', 'attach', 'detach', 'ack', 'shutdown', 'bridgeEnable', 'bridgeDisable', 'bridgeStatus']);
  if (!types.has(value.type)) throw new Error('Unsupported request');
  if (['input', 'resize', 'rename', 'close', 'attach', 'detach', 'ack'].includes(value.type) &&
      (typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 128)) {
    throw new Error('Invalid session ID');
  }
  if (value.type === 'input' && (typeof value.data !== 'string' || value.data.length > 4 * Math.ceil(MAX_INPUT_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data) || base64ByteLength(value.data) > MAX_INPUT_BYTES)) {
    throw new Error('Input must be base64, at most 64 KiB');
  }
  if (value.type === 'resize' || value.type === 'create') {
    for (const field of ['cols', 'rows']) {
      if (!Number.isInteger(value[field]) || (value[field] as number) < 2 || (value[field] as number) > 1000) {
        throw new Error('Terminal dimensions must be integers from 2 to 1000');
      }
    }
  }
  if (value.type === 'ack' && (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0)) {
    throw new Error('Invalid acknowledgement');
  }
  if (value.type === 'rename' && (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 128)) {
    throw new Error('Title must contain 1 to 128 characters');
  }
  if (value.type === 'create') {
    for (const field of ['shell', 'cwd', 'title']) {
      if (value[field] !== undefined && (typeof value[field] !== 'string' || (value[field] as string).length > 8192 || (value[field] as string).includes('\0'))) {
        throw new Error(`Invalid ${field}`);
      }
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 128 || value.args.some(a => typeof a !== 'string' || a.length > 8192 || a.includes('\0')))) {
      throw new Error('Invalid shell arguments');
    }
    if (value.env !== undefined && (!isRecord(value.env) || Object.keys(value.env).length > 128 || Object.entries(value.env).some(([k, v]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > 32768 || v.includes('\0')))) {
      throw new Error('Invalid environment');
    }
    if (JSON.stringify(value).length > 256 * 1024) throw new Error('Request too large');
  }
  return value as Request;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}

export function base64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), char => char.charCodeAt(0));
}

export function base64ByteLength(data: string): number {
  return data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}
