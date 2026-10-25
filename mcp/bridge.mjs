import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { homedir, endianness } from 'node:os';
import { dirname, posix, resolve, win32 } from 'node:path';
import { createConnection } from 'node:net';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 65_536;
const LITTLE_ENDIAN = endianness() === 'LE';
const READ_ONLY = new Set(['hello', 'list', 'read']);

export class BridgeError extends Error {
  constructor(code, message, { uncertainState = false, details } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.uncertainState = uncertainState;
    this.details = details;
  }
}

export function defaultBridgeFile({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.HOST_TERMINAL_BRIDGE_FILE) return resolve(env.HOST_TERMINAL_BRIDGE_FILE);
  const path = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new BridgeError('configuration', 'LOCALAPPDATA is missing; set HOST_TERMINAL_BRIDGE_FILE.');
    return path.join(env.LOCALAPPDATA, 'HostTerminal', 'agent-bridge.json');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Host Terminal', 'agent-bridge.json');
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(data, 'host-terminal', 'agent-bridge.json');
}

/** Read credentials without following a final symlink or accepting shared Unix files. */
export async function readPrivateFile(path, maxBytes = 4096) {
  let handle;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new BridgeError('insecure_credentials', 'Credential path must be a regular file, not a symbolic link.');
    const parent = await lstat(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new BridgeError('insecure_credentials', 'Credential directory must be a regular directory.');
    if (process.platform !== 'win32') {
      const uid = process.getuid();
      if (entry.uid !== uid || (entry.mode & 0o077) !== 0 || parent.uid !== uid || (parent.mode & 0o022) !== 0) {
        throw new BridgeError('insecure_credentials', 'Credential file must be owned by this user with mode 0600, in a directory other users cannot modify.');
      }
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== entry.ino || current.dev !== entry.dev || current.size > maxBytes) {
      throw new BridgeError('invalid_credentials', 'Credential file changed while opening or is too large.');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new BridgeError('invalid_credentials', 'Credential file is too large.');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle?.close();
  }
}

export async function readDescriptor(path) {
  let source;
  try { source = await readPrivateFile(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new BridgeError('bridge_disabled', 'Open Host Terminal in Chrome, connect the native host, and enable ChatGPT access. The local bridge is currently unavailable.');
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('bridge_unavailable', `Cannot read the local bridge descriptor (${error.code ?? 'I/O error'}).`);
  }
  let descriptor;
  try { descriptor = JSON.parse(source); }
  catch { throw new BridgeError('invalid_descriptor', 'Local bridge descriptor is not valid JSON. Re-enable ChatGPT access in Chrome.'); }
  if (descriptor?.protocol !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65_535 ||
      !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || typeof descriptor.token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(descriptor.token)) {
    throw new BridgeError('invalid_descriptor', 'Local bridge descriptor has an unsupported or invalid format.');
  }
  return descriptor;
}

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw new BridgeError('request_too_large', 'Bridge request exceeds one MiB.');
  const prefix = Buffer.alloc(4);
  if (LITTLE_ENDIAN) prefix.writeUInt32LE(body.length); else prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

export function decodeFrameLength(prefix) {
  return LITTLE_ENDIAN ? prefix.readUInt32LE(0) : prefix.readUInt32BE(0);
}

/** A fresh authenticated connection per request. Mutations are never retried. */
export class BridgeClient {
  constructor({ descriptorPath, timeoutMs = 5000 } = {}) {
    this.descriptorPath = descriptorPath ?? defaultBridgeFile();
    this.timeoutMs = timeoutMs;
  }

  async request(request, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) throw new BridgeError('cancelled', 'Operation was cancelled before dispatch.');
    const descriptor = await readDescriptor(this.descriptorPath);
    const frame = encodeFrame({ token: descriptor.token, request });
    if (signal?.aborted) throw new BridgeError('cancelled', 'Operation was cancelled before dispatch.');
    return new Promise((resolvePromise, rejectPromise) => {
      let sent = false;
      let settled = false;
      let buffer = Buffer.alloc(0);
      let expected;
      const socket = createConnection({ host: '127.0.0.1', port: descriptor.port });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) rejectPromise(error); else resolvePromise(value);
      };
      const failure = (code, message) => new BridgeError(code, message, { uncertainState: sent && !READ_ONLY.has(request.type) });
      const abort = () => finish(failure('cancelled', 'Operation cancelled. A dispatched mutation may already have taken effect; inspect sessions before retrying.'));
      const deadline = setTimeout(() => finish(failure('bridge_timeout', 'Native bridge did not reply before the deadline. A dispatched mutation may already have taken effect; inspect sessions before retrying.')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => {
        sent = true;
        socket.write(frame);
      });
      socket.on('data', (chunk) => {
        if (buffer.length + chunk.length > MAX_FRAME_BYTES + 4) {
          finish(failure('invalid_response', 'Native bridge response exceeds one MiB.'));
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        if (expected === undefined && buffer.length >= 4) {
          expected = decodeFrameLength(buffer);
          if (expected === 0 || expected > MAX_FRAME_BYTES) {
            finish(failure('invalid_response', 'Native bridge sent an invalid frame length.'));
            return;
          }
        }
        if (expected === undefined || buffer.length < expected + 4) return;
        if (buffer.length !== expected + 4) {
          finish(failure('invalid_response', 'Native bridge sent more than one response frame.'));
          return;
        }
        let result;
        try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4))); }
        catch { finish(failure('invalid_response', 'Native bridge response is not valid UTF-8 JSON.')); return; }
        if (result?.ok === true && Object.hasOwn(result, 'value')) finish(null, result.value);
        else if (result?.ok === false && typeof result.error?.code === 'string' && typeof result.error?.message === 'string') {
          // A timeout can occur after dispatch; an operation error can follow a
          // partial PTY write. Only explicit pre-dispatch rejections are certain.
          const rejected = new Set(['unauthorized', 'invalid_request', 'forbidden', 'unavailable', 'busy']);
          finish(new BridgeError(result.error.code, result.error.message, { uncertainState: sent && !READ_ONLY.has(request.type) && !rejected.has(result.error.code) }));
        } else finish(failure('invalid_response', 'Native bridge sent an invalid result envelope.'));
      });
      socket.once('error', (error) => finish(failure('bridge_unavailable', `Cannot communicate with the native bridge (${error.code ?? 'socket error'}). Reopen Host Terminal and check ChatGPT access.`)));
      socket.once('end', () => finish(failure('bridge_disconnected', 'Native bridge closed before replying. A dispatched mutation may already have taken effect.')));
      socket.once('close', () => finish(failure('bridge_disconnected', 'Native bridge disconnected before replying. A dispatched mutation may already have taken effect.')));
    });
  }
}
