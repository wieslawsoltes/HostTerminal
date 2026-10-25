import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBroker, type NativeTransport } from '../extension/src/broker.ts';
import { bytesToBase64, type HostEvent, type HostInfo, type Request, type Result, type SessionInfo } from '../extension/src/protocol.ts';

const info: HostInfo = { protocol: 1, version: '0.2.0', os: 'linux', arch: 'x86_64', home: '/home/test', defaultShell: '/bin/sh', shells: [], limits: { maxSessions: 16, maxInputBytes: 65536, outputWindowBytes: 262144 } };
const session: SessionInfo = { id: 's1', title: 'Shell', shell: '/bin/sh', args: [], cwd: '/tmp', cols: 80, rows: 24, pid: 123, createdAt: 0, exited: false };

function harness() {
  let events!: (event: HostEvent) => void;
  let disconnected!: (message: string) => void;
  let opens = 0;
  let earlyOutput = false;
  let bridgeEnabled = false;
  let listed: SessionInfo[] = [{ ...session }];
  const sent: Request[] = [];
  const commands: Request[] = [];
  const broker = new SessionBroker((onEvent, onDisconnect) => {
    events = onEvent; disconnected = onDisconnect; opens++;
    return {
      async request<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
        commands.push({ type, ...fields });
        if (type === 'hello') return info as T;
        if (type === 'bridgeEnable') bridgeEnabled = true;
        if (type === 'bridgeDisable') bridgeEnabled = false;
        if (['bridgeEnable', 'bridgeDisable', 'bridgeStatus'].includes(type)) return { enabled: bridgeEnabled } as T;
        if (type === 'create') {
          if (earlyOutput) events({ type: 'output', sessionId: 's1', data: 'aGk=', seq: 2 });
          return { ...session } as T;
        }
        if (type === 'list') return listed.map(item => ({ ...item })) as T;
        return null as T;
      },
      send(request) { sent.push(request); },
      close() { disconnected('closed'); }
    } satisfies NativeTransport;
  });
  const received: Array<Result | HostEvent> = [];
  const view = broker.addView({ postMessage(message) { received.push(message); } });
  async function request(type: string, fields: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    await broker.handle(view, { type, ...fields, id });
    return received.find((message): message is Result => message.type === 'result' && message.id === id)!;
  }
  return { broker, view, received, sent, commands, request, event: (event: HostEvent) => events(event), disconnect: () => disconnected('lost'), opens: () => opens, early: () => { earlyOutput = true; }, list: (value: SessionInfo[]) => { listed = value; } };
}

test('concurrent windows share one handshake and native process', async () => {
  const h = harness();
  await Promise.all([h.request('connect'), h.request('connect')]);
  assert.equal(h.opens(), 1);
  assert.equal(h.commands.filter(item => item.type === 'hello').length, 1);
});
test('shell access requires an explicit connect and validated request', async () => {
  const h = harness();
  assert.equal((await h.request('create', { cols: 80, rows: 24 })).ok, false);
  assert.equal(h.opens(), 0);
  await h.request('connect');
  assert.equal((await h.request('create', { cols: 0, rows: 24 })).ok, false);
  assert.equal(h.commands.filter(item => item.type === 'create').length, 0);
});
test('output waits for render ACK and detach releases outstanding credit', async () => {
  const h = harness(); await h.request('connect'); await h.request('create', { cols: 80, rows: 24 });
  h.event({ type: 'output', sessionId: 's1', data: 'YWJj', seq: 3 });
  assert.equal(h.sent.length, 0);
  assert.equal((await h.request('ack', { sessionId: 's1', seq: 4 })).ok, false);
  await h.request('ack', { sessionId: 's1', seq: 3 });
  assert.equal(h.sent.at(-1)?.seq, 3);
  h.event({ type: 'output', sessionId: 's1', data: 'YWJj', seq: 6 });
  h.broker.removeView(h.view);
  assert.equal(h.sent.at(-1)?.seq, 6);
});
test('early PTY output is delivered after create reply and is not lost', async () => {
  const h = harness(); h.early(); await h.request('connect');
  const reply = await h.request('create', { cols: 80, rows: 24 });
  const index = h.received.indexOf(reply);
  assert.deepEqual(h.received[index + 1], { type: 'output', sessionId: 's1', data: 'aGk=', seq: 2 });
});
test('one page owns input and sizing; another can attach after release', async () => {
  const h = harness(); await h.request('connect'); await h.request('create', { cols: 80, rows: 24 });
  const otherMessages: Array<Result | HostEvent> = [];
  const other = h.broker.addView({ postMessage: message => otherMessages.push(message) });
  await h.broker.handle(other, { type: 'input', sessionId: 's1', data: 'YQ==', id: 'input' });
  await h.broker.handle(other, { type: 'attach', sessionId: 's1', id: 'attach' });
  assert.equal(otherMessages.filter(item => item.type === 'result' && !item.ok).length, 2);
  await h.request('detach', { sessionId: 's1' });
  h.event({ type: 'output', sessionId: 's1', data: 'YQ==', seq: 1 });
  await h.broker.handle(other, { type: 'attach', sessionId: 's1', id: 'attach2' });
  const reply = otherMessages.at(-1) as Result;
  assert.equal(reply.ok, true);
  if (reply.ok) assert.equal((reply.value as { replay: unknown[] }).replay.length, 1);
});
test('detached sessions drain and replay is bounded during prolonged output', async () => {
  const h = harness(); await h.request('connect'); await h.request('list');
  const data = bytesToBase64(new Uint8Array(16384));
  for (let i = 1; i <= 100; i++) h.event({ type: 'output', sessionId: 's1', data, seq: i * 16384 });
  assert.equal(h.sent.at(-1)?.seq, 1638400);
  const reply = await h.request('attach', { sessionId: 's1' });
  assert.equal(reply.ok, true);
  if (reply.ok) { const value = reply.value as { replay: unknown[]; truncated: boolean }; assert.equal(value.truncated, true); assert.equal(value.replay.length, 64); }
});
test('disconnect clears stale sessions without replaying commands; reconnect starts once', async () => {
  const h = harness(); await h.request('connect'); await h.request('create', { cols: 80, rows: 24 });
  h.disconnect();
  assert.equal((await h.request('input', { sessionId: 's1', data: 'YQ==' })).ok, false);
  await h.request('connect');
  assert.equal(h.opens(), 2);
  assert.equal(h.commands.filter(item => item.type === 'create').length, 1);
  assert.equal((await h.request('attach', { sessionId: 's1' })).ok, false);
});
test('reattach of an exited session reports exit after replay response', async () => {
  const h = harness(); await h.request('connect'); await h.request('list');
  h.event({ type: 'output', sessionId: 's1', data: 'YQ==', seq: 1 });
  h.event({ type: 'exit', sessionId: 's1', exitCode: 7 });
  const reply = await h.request('attach', { sessionId: 's1' });
  const index = h.received.indexOf(reply);
  assert.deepEqual(h.received[index + 1], { type: 'exit', sessionId: 's1', exitCode: 7 });
});

test('agent bridge enablement requires a connected UI and broadcasts status without a session', async () => {
  const h = harness();
  assert.equal((await h.request('bridgeEnable')).ok, false);
  assert.equal(h.opens(), 0);
  await h.request('connect');
  const otherMessages: Array<Result | HostEvent> = [];
  h.broker.addView({ postMessage: message => otherMessages.push(message) });
  const enabled = await h.request('bridgeEnable');
  assert.deepEqual(enabled.ok && enabled.value, { enabled: true });
  assert.deepEqual(otherMessages.at(-1), { type: 'bridgeStatusChanged', status: { enabled: true } });
  await h.request('bridgeDisable');
  assert.deepEqual(otherMessages.at(-1), { type: 'bridgeStatusChanged', status: { enabled: false } });
});

test('agent session changes notify every extension view without creating an invalid session', async () => {
  const h = harness(); await h.request('connect');
  const otherMessages: Array<Result | HostEvent> = [];
  h.broker.addView({ postMessage: message => otherMessages.push(message) });
  h.event({ type: 'sessionsChanged' });
  assert.deepEqual(h.received.at(-1), { type: 'sessionsChanged' });
  assert.deepEqual(otherMessages.at(-1), { type: 'sessionsChanged' });
  assert.equal((await h.request('list')).ok, true);
});

test('agent-only sessions are reconciled and ACKed after every Chrome view closes', async () => {
  const h = harness(); await h.request('connect');
  h.broker.removeView(h.view);
  for (let index = 0; index < 96; index++) {
    const id = `agent-${index}`;
    h.list([{ ...session, id }]);
    h.event({ type: 'sessionsChanged' });
    h.event({ type: 'output', sessionId: id, data: 'YQ==', seq: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.sent.at(-1), { type: 'ack', sessionId: id, seq: 1 });
    h.list([]);
    h.event({ type: 'sessionsChanged' });
    await new Promise(resolve => setImmediate(resolve));
    // A closed process's delayed event must not resurrect its replay buffer.
    h.event({ type: 'exit', sessionId: id, exitCode: 0 });
  }
  assert.equal(h.commands.filter(item => item.type === 'list').length, 192);
  assert.equal(h.sent.length, 96);
});

test('agent change reconciliation coalesces notifications and does not revive disconnected state', async () => {
  const h = harness(); await h.request('connect');
  h.event({ type: 'sessionsChanged' });
  h.event({ type: 'sessionsChanged' });
  h.event({ type: 'sessionsChanged' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.commands.filter(item => item.type === 'list').length, 2);
  h.event({ type: 'sessionsChanged' });
  h.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  await h.request('connect');
  assert.equal((await h.request('attach', { sessionId: 's1' })).ok, false);
});
