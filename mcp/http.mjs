import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BridgeError, MAX_FRAME_BYTES, readPrivateFile } from './bridge.mjs';
import { createMcpServer } from './tools.mjs';

export function validateToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new BridgeError('invalid_token', 'The HTTP bearer token must be 43–128 base64url characters. Generate a random token with --init-token PATH.');
  }
  return value;
}

export async function initializeToken(path) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const file = await open(absolute, 'wx', 0o600);
  try { await file.writeFile(`${randomBytes(32).toString('base64url')}\n`); }
  finally { await file.close(); }
  if (process.platform !== 'win32') await chmod(absolute, 0o600);
  return absolute;
}

export async function loadHttpToken({ tokenFile, env = process.env } = {}) {
  if (tokenFile) return validateToken((await readPrivateFile(resolve(tokenFile), 256)).trim());
  if (env.HOST_TERMINAL_MCP_TOKEN) return validateToken(env.HOST_TERMINAL_MCP_TOKEN);
  if (env.HOST_TERMINAL_MCP_TOKEN_FILE) return validateToken((await readPrivateFile(resolve(env.HOST_TERMINAL_MCP_TOKEN_FILE), 256)).trim());
  throw new BridgeError('missing_token', 'HTTP mode requires --token-file PATH, HOST_TERMINAL_MCP_TOKEN_FILE, or HOST_TERMINAL_MCP_TOKEN. Generate a token with --init-token PATH.');
}

export function normalizeOrigin(origin) {
  let value;
  try { value = new URL(origin); } catch { throw new BridgeError('invalid_origin', 'Allowed origins must be exact HTTP(S) origins.'); }
  if (!['https:', 'http:'].includes(value.protocol) || value.hostname.includes('*') || value.username || value.password || value.pathname !== '/' || value.search || value.hash || origin !== value.origin) {
    throw new BridgeError('invalid_origin', 'Allowed origins must be exact HTTP(S) origins without credentials, paths or wildcards.');
  }
  if (value.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)) {
    throw new BridgeError('invalid_origin', 'A non-loopback allowed origin must use HTTPS.');
  }
  return value.origin;
}

function reply(res, status, message, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

function authenticated(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_FRAME_BYTES)) {
    throw new BridgeError('body_too_large', 'Request body exceeds one MiB.');
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { req.resume(); rejectBody(error); } else resolveBody(body);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) finish(new BridgeError('body_too_large', 'Request body exceeds one MiB.'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { finish(new BridgeError('invalid_json', 'Request body must be valid UTF-8 JSON.')); }
    };
    const onError = () => finish(new BridgeError('request_interrupted', 'Request body could not be read.'));
    const onAborted = () => finish(new BridgeError('request_interrupted', 'Request body was interrupted.'));
    const timer = setTimeout(() => finish(new BridgeError('body_timeout', 'Request body deadline exceeded.')), 5000);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

/** Stateless MCP over HTTP; the native host owns all persistent PTY state. */
export async function startHttpServer({ bridge, token, port = 8767, allowedOrigins = [] } = {}) {
  validateToken(token);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new BridgeError('invalid_port', 'Port must be an integer from 0 to 65535.');
  const extraOrigins = new Set(allowedOrigins.map(normalizeOrigin));
  const active = new Set();
  let actualPort;
  const listener = createServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    if (actualPort === 80) { hosts.add('127.0.0.1'); hosts.add('localhost'); }
    const repeated = ['host', 'authorization', 'origin'].some((name) => req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length > 1);
    if (repeated || !hosts.has(req.headers.host)) { reply(res, 403, 'Invalid Host header.'); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || (!extraOrigins.has(origin) && !new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]).has(origin)))) {
      reply(res, 403, 'Origin is not allowed.'); return;
    }
    if (!authenticated(req.headers.authorization, token)) { reply(res, 401, 'Bearer authentication required.', { 'WWW-Authenticate': 'Bearer realm="host-terminal"' }); return; }
    if (req.url !== '/mcp') { reply(res, 404, 'Endpoint not found. Use /mcp.'); return; }
    if (req.method !== 'POST') { reply(res, 405, 'This stateless MCP endpoint accepts POST requests only.', { Allow: 'POST' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { reply(res, 415, 'Content-Type must be application/json.'); return; }
    if (active.size >= 32) { reply(res, 503, 'Too many active MCP requests.'); return; }
    const context = { server: null };
    active.add(context);
    const dispose = () => {
      active.delete(context);
      void context.server?.close().catch(() => {});
    };
    res.once('close', dispose);
    try {
      const body = await readJson(req);
      if (res.destroyed) return;
      context.server = createMcpServer({ bridge });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await context.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      reply(res, error.code === 'body_too_large' ? 413 : error.code === 'body_timeout' ? 408 : error instanceof BridgeError ? 400 : 500,
        error instanceof BridgeError ? error.message : 'MCP request failed.');
    }
  });
  listener.maxConnections = 64;
  await new Promise((resolveListen, rejectListen) => {
    listener.once('error', rejectListen);
    listener.listen(port, '127.0.0.1', () => { listener.off('error', rejectListen); actualPort = listener.address().port; resolveListen(); });
  });
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/mcp`,
    async close() {
      await Promise.allSettled([...active].map((entry) => entry.server?.close()));
      const closed = new Promise((resolveClose) => listener.close(resolveClose));
      listener.closeAllConnections();
      await closed;
    },
  };
}
