import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgeClient, BridgeError, defaultBridgeFile, decodeFrameLength, encodeFrame, readDescriptor } from '../mcp/bridge.mjs';
import { commandArguments, VERSION } from '../mcp/tools.mjs';
import { initializeToken, loadHttpToken, normalizeOrigin, startHttpServer } from '../mcp/http.mjs';
import { parseArguments } from '../mcp/index.mjs';

const ENTRY = resolve(process.env.HOST_TERMINAL_MCP_TEST_ENTRY ?? 'mcp/index.mjs');
const TOKEN = randomBytes(32).toString('base64url');
const HOST = { protocol: 1, version: '0.2.0', os: 'linux', arch: 'x86_64', home: '/home/test', defaultShell: '/bin/sh', shells: [{ name: 'sh', path: '/bin/sh', args: [] }], limits: { maxSessions: 16, maxInputBytes: 65536, outputWindowBytes: 262144 } };

async function mockBridge(handler) {
  const dir = await mkdtemp(join(tmpdir(), 'host-terminal-mcp-test-'));
  const descriptorPath = join(dir, 'agent-bridge.json');
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let dispatched = false;
    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (dispatched || buffer.length < 4 || buffer.length < 4 + decodeFrameLength(buffer)) return;
      dispatched = true;
      const envelope = JSON.parse(buffer.subarray(4).toString('utf8'));
      if (envelope.token !== token) { socket.end(encodeFrame({ ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } })); return; }
      calls.push(envelope.request);
      try {
        const reply = await handler(envelope.request, socket);
        if (reply !== undefined && !socket.destroyed) {
          const response = encodeFrame({ ok: true, value: reply });
          // Fragment the header to exercise the real length-prefixed reader.
          socket.write(response.subarray(0, 2));
          setTimeout(() => { if (!socket.destroyed) socket.end(response.subarray(2)); }, 1);
        }
      } catch (error) {
        if (!socket.destroyed) socket.end(encodeFrame({ ok: false, error: { code: error.code ?? 'operation_failed', message: error.message } }));
      }
    });
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  await writeFile(descriptorPath, JSON.stringify({ protocol: 1, port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
  return {
    descriptorPath, calls, dir,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((ok) => server.close(ok));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function stdioClient(descriptorPath) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { HOST_TERMINAL_BRIDGE_FILE: descriptorPath }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += chunk.toString(); });
  const client = new Client({ name: 'host-terminal-tests', version: '1.0.0' });
  await client.connect(transport);
  return { client, diagnostics: () => diagnostics, close: () => client.close() };
}

function session(id = 'session-1') {
  return { id, title: 'Test', shell: '/bin/sh', args: [], cwd: '/home/test', cols: 120, rows: 30, pid: 42, createdAt: Date.now(), exited: false };
}

function output(request, text = '', extras = {}) {
  const bytes = Buffer.from(text);
  return { sessionId: request.sessionId, data: bytes.toString('base64'), cursor: request.cursor + bytes.length, oldestCursor: 0, endCursor: request.cursor + bytes.length, truncated: false, exited: false, ...extras };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result;
}

test('stdio SDK client sees all tools and controls the same authenticated bridge', async (t) => {
  const bridge = await mockBridge((request) => {
    if (request.type === 'hello') return HOST;
    if (request.type === 'list') return [session()];
    if (request.type === 'create') return { ...session('created-1'), title: request.title ?? 'Test', args: request.args ?? [] };
    if (request.type === 'read') return output(request, 'hello π\r\n', { exited: true, exitCode: 0 });
    return null;
  });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const { client } = connection;
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  for (const tool of tools) {
    assert.equal(tool.outputSchema.type, 'object');
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean');
  }
  assert.equal(tools.find((tool) => tool.name === 'terminal_run').annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === 'terminal_read').annotations.readOnlyHint, true);
  assert.equal((await call(client, 'host_status')).structuredContent.data.host.defaultShell, '/bin/sh');
  assert.equal((await call(client, 'terminal_list')).structuredContent.data.sessions[0].id, 'session-1');
  const created = await call(client, 'terminal_create', { title: 'An agent terminal', cwd: '/work' });
  assert.equal(created.structuredContent.data.session.id, 'created-1');
  assert.deepEqual(bridge.calls.find((item) => item.type === 'create'), { type: 'create', title: 'An agent terminal', cwd: '/work', cols: 120, rows: 30 });
  const read = await call(client, 'terminal_read', { sessionId: 'created-1' });
  assert.equal(read.structuredContent.data.text, 'hello π\r\n');
  assert.equal(read.structuredContent.data.cursor, Buffer.byteLength('hello π\r\n'));
  await call(client, 'terminal_write', { sessionId: 'created-1', text: 'echo π', appendNewline: true });
  assert.equal(Buffer.from(bridge.calls.at(-1).data, 'base64').toString(), 'echo π\r');
  await call(client, 'terminal_interrupt', { sessionId: 'created-1' });
  assert.equal(bridge.calls.at(-1).data, 'Aw==');
  await call(client, 'terminal_resize', { sessionId: 'created-1', cols: 80, rows: 24 });
  await call(client, 'terminal_rename', { sessionId: 'created-1', title: 'Renamed' });
  await call(client, 'terminal_close', { sessionId: 'created-1' });
  assert.equal(bridge.calls.at(-1).type, 'close');
  assert.equal(bridge.calls.some((item) => item.type === 'ack'), false);
  assert.equal(connection.diagnostics(), '');
});

test('terminal_run sends a command once and preserves output and exit status', async (t) => {
  let reads = 0;
  const bridge = await mockBridge((request) => {
    if (request.type === 'hello') return HOST;
    if (request.type === 'create') return session('run-1');
    if (request.type === 'read') {
      reads++;
      if (reads === 1) return output(request, 'first\n', { endCursor: 11 });
      return output(request, 'last\n', { exited: true, exitCode: 7 });
    }
    throw new Error(`Unexpected command: ${request.type}`);
  });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = (await call(connection.client, 'terminal_run', { command: 'printf first; exit 7', waitMs: 1000 })).structuredContent.data;
  assert.equal(value.text, 'first\nlast\n');
  assert.equal(value.exitCode, 7);
  assert.equal(value.exited, true);
  assert.equal(value.cursor, 11);
  assert.equal(value.sessionPreserved, true);
  assert.equal(bridge.calls.filter((item) => item.type === 'create').length, 1);
  assert.deepEqual(bridge.calls.find((item) => item.type === 'create').args, ['-c', 'printf first; exit 7']);
  assert.equal(bridge.calls.some((item) => item.type === 'close'), false);
});

test('running commands return a usable cursor at the wait/output bound', async (t) => {
  const bridge = await mockBridge((request) => {
    if (request.type === 'create') return session('bounded-1');
    if (request.type === 'read') return output(request, '1234', { endCursor: request.cursor + 20 });
    return HOST;
  });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = (await call(connection.client, 'terminal_run', { command: 'long-command', shell: '/bin/sh', maxBytes: 4, waitMs: 100 })).structuredContent.data;
  assert.equal(value.cursor, 4);
  assert.equal(value.hasMore, true);
  assert.equal(value.outputLimitReached, true);
  assert.equal(value.exited, false);
  assert.equal(bridge.calls.filter((item) => item.type === 'create').length, 1);
});

test('long polling observes new output and honors cancellation-independent bounds', async (t) => {
  let reads = 0;
  const bridge = await mockBridge((request) => output(request, ++reads === 1 ? '' : 'ready'));
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = (await call(connection.client, 'terminal_read', { sessionId: 'poll-1', waitMs: 500, cursor: 12 })).structuredContent.data;
  assert.equal(value.text, 'ready');
  assert.equal(value.cursor, 17);
  assert.equal(reads, 2);
});

test('a lost mutating response is reported as uncertain without retrying', async (t) => {
  const bridge = await mockBridge((_, socket) => { socket.end(); return undefined; });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = await call(connection.client, 'terminal_write', { sessionId: 'existing-1', text: 'execute once', appendNewline: true });
  assert.equal(value.isError, true);
  assert.equal(value.structuredContent.error.uncertainState, true);
  assert.equal(bridge.calls.length, 1);
});

test('native mutation failures can represent partial writes and are never replayed', async (t) => {
  const bridge = await mockBridge(() => { throw new BridgeError('operation_failed', 'PTY writer failed after partial input'); });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = await call(connection.client, 'terminal_write', { sessionId: 'partial-write', text: 'do-something', appendNewline: true });
  assert.equal(value.isError, true);
  assert.equal(value.structuredContent.error.uncertainState, true);
  assert.equal(bridge.calls.length, 1);
});

test('short output waits allow one native snapshot and preserve a running command', async (t) => {
  const bridge = await mockBridge(async (request) => {
    await new Promise((done) => setTimeout(done, 25));
    if (request.type === 'create') return session('short-wait');
    if (request.type === 'read') return output(request);
    return HOST;
  });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const read = await call(connection.client, 'terminal_read', { sessionId: 'short-wait', waitMs: 1 });
  assert.equal(read.structuredContent.ok, true);
  assert.equal(read.structuredContent.data.waitExpired, true);
  const run = await call(connection.client, 'terminal_run', { command: 'work', shell: '/bin/sh', waitMs: 1 });
  assert.equal(run.structuredContent.ok, true);
  assert.equal(run.structuredContent.data.waitExpired, true);
  assert.equal(run.structuredContent.data.sessionId, 'short-wait');
  assert.equal(bridge.calls.filter((item) => item.type === 'create').length, 1);
});

test('expiration during a later poll returns the last valid snapshot', async (t) => {
  let reads = 0;
  const bridge = await mockBridge(async (request) => {
    if (++reads > 1) await new Promise((done) => setTimeout(done, 100));
    return output(request);
  });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = await call(connection.client, 'terminal_read', { sessionId: 'late-poll', waitMs: 140 });
  assert.equal(reads, 2);
  assert.equal(value.structuredContent.ok, true);
  assert.equal(value.structuredContent.data.waitExpired, true);
  assert.equal(value.structuredContent.data.cursor, 0);
});

test('a read failure after command creation preserves session and cursor details', async (t) => {
  const bridge = await mockBridge((request) => {
    if (request.type === 'create') return session('already-started');
    if (request.type === 'read') throw new Error('Output temporarily unavailable');
    return HOST;
  });
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  const value = await call(connection.client, 'terminal_run', { command: 'do-work', shell: '/bin/sh' });
  assert.equal(value.isError, true);
  assert.equal(value.structuredContent.error.details.commandStarted, true);
  assert.equal(value.structuredContent.error.details.sessionId, 'already-started');
  assert.equal(bridge.calls.filter((item) => item.type === 'create').length, 1);
});

test('invalid write combinations and oversized UTF-8 never reach native input', async (t) => {
  const bridge = await mockBridge(() => null);
  t.after(() => bridge.close());
  const connection = await stdioClient(bridge.descriptorPath);
  t.after(() => connection.close());
  for (const args of [{ text: 'x', data: 'eA==' }, { data: 'not base64' }, { text: 'π'.repeat(40_000) }, {}]) {
    const value = await call(connection.client, 'terminal_write', { sessionId: 'test-1', ...args });
    assert.equal(value.isError, true);
  }
  assert.equal(bridge.calls.length, 0);
});

test('descriptor absence and insecure permissions fail closed', async (t) => {
  const bridge = await mockBridge(() => HOST);
  t.after(() => bridge.close());
  await assert.rejects(readDescriptor(join(bridge.dir, 'missing')), { code: 'bridge_disabled' });
  if (process.platform !== 'win32') {
    await chmod(bridge.descriptorPath, 0o644);
    await assert.rejects(readDescriptor(bridge.descriptorPath), { code: 'insecure_credentials' });
    await chmod(bridge.descriptorPath, 0o600);
    await symlink(bridge.descriptorPath, join(bridge.dir, 'link.json'));
    await assert.rejects(readDescriptor(join(bridge.dir, 'link.json')), { code: 'insecure_credentials' });
  }
  const connection = await stdioClient(join(bridge.dir, 'missing'));
  t.after(() => connection.close());
  const value = await call(connection.client, 'host_status');
  assert.equal(value.isError, true);
  assert.equal(value.structuredContent.error.code, 'bridge_disabled');
});

test('native framing rejects oversize replies and times out once', async (t) => {
  const bridge = await mockBridge((_, socket) => {
    const oversized = encodeFrame({ sample: 1 }).subarray(0, 4);
    oversized.fill(0xff);
    socket.end(oversized);
    return undefined;
  });
  t.after(() => bridge.close());
  await assert.rejects(new BridgeClient({ descriptorPath: bridge.descriptorPath }).request({ type: 'hello' }), { code: 'invalid_response', uncertainState: false });
  const stalled = await mockBridge(() => undefined);
  t.after(() => stalled.close());
  await assert.rejects(new BridgeClient({ descriptorPath: stalled.descriptorPath, timeoutMs: 30 }).request({ type: 'input', sessionId: 'test-1', data: 'eA==' }), { code: 'bridge_timeout', uncertainState: true });
  assert.equal(stalled.calls.length, 1);
});

test('HTTP transport authenticates, rejects foreign origins/hosts and serves an SDK client', async (t) => {
  const calls = [];
  const endpoint = await startHttpServer({ port: 0, token: TOKEN, bridge: { request: async (request) => { calls.push(request); return HOST; } } });
  t.after(() => endpoint.close());
  const post = (headers = {}, body = '{}') => fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post()).status, 401);
  assert.equal((await post({ Authorization: 'Bearer bad' })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'null' })).status, 403);
  const badHostStatus = await new Promise((done, fail) => {
    const req = httpRequest(endpoint.url, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', fail);
    req.end('{}');
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}` }, '{broken')).status, 400);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}` }, 'x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await fetch(endpoint.url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal(calls.length, 0);
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  assert.equal((await client.listTools()).tools.length, 10);
  assert.equal((await call(client, 'host_status')).structuredContent.data.host.version, '0.2.0');
  assert.equal(calls.length, 1);
});

test('HTTP origin overrides are exact and bearer tokens stay in private files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-terminal-token-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'http-token');
  assert.equal(await initializeToken(path), path);
  assert.equal((await loadHttpToken({ tokenFile: path })).length, 43);
  await assert.rejects(initializeToken(path), { code: 'EEXIST' });
  await assert.rejects(loadHttpToken({ env: {} }), { code: 'missing_token' });
  for (const origin of ['https://example.com/path', 'https://user@example.com', 'https://*.example.com', 'http://example.com', 'null']) assert.throws(() => normalizeOrigin(origin));
  const endpoint = await startHttpServer({ port: 0, token: TOKEN, allowedOrigins: ['https://chatgpt.com'], bridge: { request: async () => HOST } });
  t.after(() => endpoint.close());
  const result = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://chatgpt.com', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).result.serverInfo.name, 'host-terminal');
});

test('platform discovery, shell dispatch, arguments and package manifests are consistent', async () => {
  assert.equal(defaultBridgeFile({ platform: 'linux', env: {}, home: '/users/example' }), '/users/example/.local/share/host-terminal/agent-bridge.json');
  assert.equal(defaultBridgeFile({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/users/example' }), '/data/host-terminal/agent-bridge.json');
  assert.equal(defaultBridgeFile({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, home: '/users/example' }), '/users/example/.local/share/host-terminal/agent-bridge.json');
  assert.equal(defaultBridgeFile({ platform: 'darwin', env: {}, home: '/users/example' }), '/users/example/Library/Application Support/Host Terminal/agent-bridge.json');
  assert.deepEqual(commandArguments('C:\\Windows\\System32\\cmd.exe', 'echo one'), ['/D', '/C', 'echo one']);
  assert.deepEqual(commandArguments('C:\\Program Files\\PowerShell\\pwsh.exe', 'Write-Output one'), ['-NoLogo', '-NoProfile', '-Command', 'Write-Output one']);
  assert.throws(() => commandArguments('/usr/bin/python', 'print(1)'), { code: 'unsupported_shell' });
  assert.throws(() => parseArguments(['--host', '0.0.0.0']));
  assert.throws(() => parseArguments(['--http', '--port', 'NaN']));
  assert.throws(() => parseArguments(['--http', '--allowed-origin', '*']));
  assert.equal(parseArguments(['--http', '--port', '0']).port, 0);
  const manifest = JSON.parse(await readFile('plugin/plugin.json', 'utf8'));
  const compatibility = JSON.parse(await readFile('plugin/.codex-plugin/plugin.json', 'utf8'));
  const wiring = JSON.parse(await readFile('plugin/mcp.json', 'utf8'));
  const marketplace = JSON.parse(await readFile('.agents/plugins/marketplace.json', 'utf8'));
  assert.equal(manifest.version, compatibility.version);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.version, JSON.parse(await readFile('package.json', 'utf8')).version);
  assert.equal(wiring.mcpServers.host_terminal.type, 'stdio');
  assert.deepEqual(wiring.mcpServers.host_terminal.args, ['${PLUGIN_ROOT}/server/index.mjs']);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source.path, './plugin');
});
