import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableSender } from '../public/outbox.js';

class MemoryOutbox {
  entries = new Map();
  async put(entry) { this.entries.set(entry.key, structuredClone(entry)); }
  async remove(key) { this.entries.delete(key); }
  async list(owner) { return [...this.entries.values()].filter(e => String(e.owner) === String(owner)).map(e => structuredClone(e)); }
}

const original = (overrides = {}) => ({
  key: 'owner:restaurant:crossing', owner: 'owner', tenant: 'restaurant',
  endpoint: '/api/events', event: { id: 'crossing', dishName: 'Soup' },
  payload: { dishId: 1, sessionId: 'session', crossingId: 'crossing', image: 'data:image/jpeg;base64,/9j/AA==' },
  ...overrides,
});

async function activate(sender) {
  await sender.activate('owner');
  clearTimeout(sender.timer);
}

async function attempt(sender) {
  clearTimeout(sender.timer);
  for (const [key, state] of sender.retry) sender.retry.set(key, { ...state, next: 0 });
  await sender.drain();
  clearTimeout(sender.timer);
}

test('snapshot retries retain the original payload and acknowledge one inserted event only after media commits', async t => {
  const storage = new MemoryOutbox(), responses = [
    { inserted: 1, duplicates: 0, mediaPending: 1 },
    { inserted: 0, duplicates: 1, mediaPending: 1 },
    { inserted: 0, duplicates: 1, mediaPending: 0 },
  ], sent = [], saved = [], health = [];
  const sender = new DurableSender({ storage, send: async entry => { sent.push(structuredClone(entry.payload)); return responses.shift(); }, onSaved: (entry, result) => saved.push({ entry, result }), onHealth: state => health.push(state) });
  t.after(() => sender.deactivate());
  await activate(sender);
  const entry = original();
  await sender.enqueue(entry);
  await attempt(sender);
  assert.equal(saved.length, 0);
  assert.equal((await storage.list('owner'))[0].delivery.inserted, 1);
  await attempt(sender);
  assert.equal(saved.length, 0);
  assert.equal((await storage.list('owner'))[0].payload.image, entry.payload.image);
  await attempt(sender);
  assert.equal((await storage.list('owner')).length, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].result.inserted, 1);
  assert.equal(saved[0].result.mediaPending, 0);
  assert.deepEqual(sent, [entry.payload, entry.payload, entry.payload]);
  assert(health.some(h => h.pendingMedia && h.error.includes('سجل الحدث محفوظ')));
  await attempt(sender);
  assert.equal(saved.length, 1);
});

test('a reactivated sender restores the media payload and the original insert acknowledgement', async t => {
  const storage = new MemoryOutbox(), entry = original({ endpoint: '/api/unknown-events' });
  const first = new DurableSender({ storage, send: async () => ({ inserted: 1, duplicates: 0, mediaPending: 1 }) });
  t.after(() => first.deactivate());
  await activate(first); await first.enqueue(entry); await attempt(first); first.deactivate();
  const sent = [], saved = [];
  const restored = new DurableSender({ storage, send: async replay => { sent.push(replay); return { inserted: 0, duplicates: 1, mediaPending: 0 }; }, onSaved: (replay, result) => saved.push({ replay, result }) });
  t.after(() => restored.deactivate());
  const recovered = await restored.activate('owner'); clearTimeout(restored.timer);
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].payload, entry.payload);
  assert.equal(recovered[0].delivery.inserted, 1);
  await attempt(restored);
  assert.equal(sent[0].endpoint, '/api/unknown-events');
  assert.deepEqual(sent[0].payload, entry.payload);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].result.inserted, 1);
  assert.equal((await storage.list('owner')).length, 0);
});

test('events without media and legacy responses finish normally', async t => {
  for (const result of [{ inserted: 1, duplicates: 0, mediaPending: 0 }, { inserted: 1, duplicates: 0 }]) {
    const storage = new MemoryOutbox(), saved = [];
    const entry = original({ payload: { dishId: 1, sessionId: 'session', crossingId: 'crossing' } });
    const sender = new DurableSender({ storage, send: async () => result, onSaved: (replay, response) => saved.push(response) });
    t.after(() => sender.deactivate());
    await activate(sender); await sender.enqueue(entry); await attempt(sender);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].inserted, 1);
    assert.equal(saved[0].mediaPending, 0);
    assert.equal((await storage.list('owner')).length, 0);
    sender.deactivate();
  }
});

test('a blocked media sender does not block durable enqueue of the next crossing', async t => {
  const storage = new MemoryOutbox(); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const sender = new DurableSender({ storage, send: async () => { started(); return waiting; } });
  t.after(() => sender.deactivate());
  await activate(sender); await sender.enqueue(original()); clearTimeout(sender.timer);
  const draining = sender.drain(); await entered;
  const second = original({ key: 'owner:restaurant:second', payload: { dishId: 1, sessionId: 'session', crossingId: 'second' } });
  await sender.enqueue(second); clearTimeout(sender.timer);
  assert.equal((await storage.list('owner')).length, 2);
  sender.deactivate(); release({ inserted: 1, duplicates: 0, mediaPending: 0 }); await draining;
  assert.equal((await storage.list('owner')).length, 1);
});

test('a failed durable acknowledgement update keeps the original count for a later duplicate', async t => {
  const storage = new MemoryOutbox(), saved = [], responses = [
    { inserted: 1, duplicates: 0, mediaPending: 1 },
    { inserted: 0, duplicates: 1, mediaPending: 0 },
  ];
  const sender = new DurableSender({ storage, send: async () => responses.shift(), onSaved: (entry, result) => saved.push(result) });
  t.after(() => sender.deactivate());
  await activate(sender); await sender.enqueue(original()); clearTimeout(sender.timer);
  const put = storage.put.bind(storage); let failOnce = true;
  storage.put = async entry => { if (failOnce) { failOnce = false; throw Error('Quota exceeded'); } return put(entry); };
  await attempt(sender);
  assert.equal(saved.length, 0);
  assert.equal((await storage.list('owner')).length, 1);
  await attempt(sender);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].inserted, 1);
  assert.equal((await storage.list('owner')).length, 0);
});
