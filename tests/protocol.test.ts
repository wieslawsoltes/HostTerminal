import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, bytesToBase64, base64ToBytes, base64ByteLength } from '../extension/src/protocol.ts';
import { ReplayBuffer } from '../extension/src/replay.ts';

test('raw terminal bytes survive base64, including split UTF-8 and binary', () => {
  const bytes = new Uint8Array([...Array(256).keys(), ...new TextEncoder().encode('Zażółć 🦀 漢字\r\n')]);
  const encoded = bytesToBase64(bytes);
  assert.deepEqual(base64ToBytes(encoded), bytes);
  assert.equal(base64ByteLength(encoded), bytes.byteLength);
});
test('create validates dimensions, environment and no NUL in process args', () => {
  assert.equal(validateRequest({ type: 'create', cols: 80, rows: 24, env: { LANG: 'C.UTF-8' } }).type, 'create');
  for (const fields of [ { cols: 0 }, { rows: NaN }, { rows: 2.5 }, { cols: 1001 }, { args: ['a\0b'] }, { shell: '/bin/sh\0' }, { env: { 'A=B': 'bad' } }, { env: { OK: null } } ]) {
    assert.throws(() => validateRequest({ type: 'create', cols: 80, rows: 24, ...fields }));
  }
});
test('rejects unsupported bridge calls, malformed identities and future ACK values', () => {
  for (const request of [null, [], { type: 'eval' }, { type: 'input', sessionId: '', data: '' }, { type: 'ack', sessionId: 'one', seq: -1 }, { type: 'ack', sessionId: 'one', seq: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateRequest(request));
  }
});
test('input base64 grammar and byte cap enforced before forwarding', () => {
  assert.doesNotThrow(() => validateRequest({ type: 'input', sessionId: 'a', data: bytesToBase64(new Uint8Array(65536)) }));
  for (const data of ['$', 'A===', 'abc', bytesToBase64(new Uint8Array(65537)), bytesToBase64(new Uint8Array(65538)), bytesToBase64(new Uint8Array(65540))]) {
    assert.throws(() => validateRequest({ type: 'input', sessionId: 'a', data }));
  }
});
test('replay evicts whole chunks and bounds byte and object counts', () => {
  const ring = new ReplayBuffer(7, 2);
  for (let i = 1; i <= 4; i++) ring.append({ type: 'output', sessionId: 'a', data: bytesToBase64(new Uint8Array([i, i, i])), seq: i * 3 });
  assert.deepEqual(ring.snapshot().map(item => item.seq), [9, 12]);
  assert.equal(ring.truncated, true);
  assert.equal(ring.size, 6);
  const snapshot = ring.snapshot(); snapshot.pop();
  assert.equal(ring.snapshot().length, 2);
});
