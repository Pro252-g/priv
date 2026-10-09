import test from 'node:test';
import assert from 'node:assert/strict';
import { DishTracker } from '../public/tracker.js';
const dish = (y, x = .2, dishId = 'rice') => ({ bbox: [x, y - .05, .1, .1], dishId, dishName: 'Rice', confidence: .9 });
test('two simultaneous dishes cross once, including return crossing', () => {
  const tracker = new DishTracker({ direction: 'both' });
  let events = [];
  [.3, .4, .55, .65, .55, .4, .3].forEach((y, i) => events.push(...tracker.update([dish(y), dish(y, .7)], i * 100).events));
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map(e => e.dedupeKey)).size, 2);
});
test('stationary dishes and unknown crossings never count', () => {
  const tracker = new DishTracker();
  for (let i = 0; i < 10; i++) assert.equal(tracker.update([dish(.6)], i * 100).events.length, 0);
  tracker.reset();
  [.3, .4, .55, .65].forEach((y, i) => assert.equal(tracker.update([dish(y, .2, null)], i * 100).events.length, 0));
});
test('short disappearance preserves identity and counts at crossing', () => {
  const tracker = new DishTracker();
  const id = tracker.update([dish(.3)], 0).tracks[0].id;
  tracker.update([dish(.4)], 100);
  tracker.update([], 200);
  const result = tracker.update([dish(.55)], 300);
  assert.equal(result.tracks[0].id, id);
  assert.equal(result.events.length, 1);
});
test('unstable labels and wrong direction excluded', () => {
  const tracker = new DishTracker();
  tracker.update([dish(.3)], 0);
  tracker.update([dish(.4, .2, 'soup')], 100);
  assert.equal(tracker.update([dish(.55, .2, 'soup')], 200).events.length, 0);
  tracker.reset();
  [.7, .6, .45].forEach((y, i) => assert.equal(tracker.update([dish(y)], i * 100).events.length, 0));
});
test('grace expiry and reset give fresh identities', () => {
  const tracker = new DishTracker({ maxMissingMs: 100 });
  const first = tracker.update([dish(.3)], 0).tracks[0].id;
  assert.notEqual(tracker.update([dish(.3)], 200).tracks[0].id, first);
  const session = tracker.sessionId;
  tracker.reset();
  assert.notEqual(tracker.sessionId, session);
});

test('moving camera suppresses counting and clears crossing baseline', () => {
  const tracker = new DishTracker();
  tracker.update([dish(.3)], 0);
  tracker.update([dish(.4)], 100);
  assert.equal(tracker.update([dish(.55)], 200, false).events.length, 0);
  assert.equal(tracker.update([dish(.65)], 300, true).events.length, 0);
});

test('early crossing buffers until third stable observation with original timestamp', () => {
  const tracker = new DishTracker();
  const events = [.4, .55, .65, .7].flatMap((y, i) => tracker.update([dish(y)], i * 100).events);
  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, 100);
});
test('buffered crossing cannot be attributed to a changed label', () => {
  const tracker = new DishTracker();
  tracker.update([dish(.4)], 0);
  tracker.update([dish(.55)], 100);
  const changed = tracker.update([dish(.65, .2, 'soup')], 200);
  assert.equal(changed.events.length, 0);
  assert.equal(changed.unknownEvents.length, 1);
  assert.equal(changed.unknownEvents[0].counted, false);
  [.7, .75, .8].forEach((y, i) => assert.equal(tracker.update([dish(y, .2, 'soup')], 300 + i * 100).events.length, 0));
});
test('unknown crossing expires into review separately from counted dishes', () => {
  const tracker = new DishTracker({ candidateTtlMs: 200 });
  tracker.update([dish(.4, .2, null)], 0);
  tracker.update([dish(.55, .2, null)], 100);
  const result = tracker.update([dish(.65, .2, null)], 300);
  assert.equal(result.events.length, 0);
  assert.equal(result.unknownEvents.length, 1);
  assert.equal(result.unknownEvents[0].timestamp, 100);
  assert.equal(result.unknownEvents[0].dishId, null);
});
test('loss of visibility cannot confirm a buffered crossing on reappearance', () => {
  const tracker = new DishTracker();
  tracker.update([dish(.4)], 0);
  tracker.update([dish(.55)], 100);
  assert.equal(tracker.update([], 200).unknownEvents.length, 1);
  assert.equal(tracker.update([dish(.65)], 300).events.length, 0);
});
test('invalid or decreasing timestamps normalize without expiring candidates', () => {
  const tracker = new DishTracker();
  tracker.update([dish(.4)], 100);
  tracker.update([dish(.55)], NaN);
  const result = tracker.update([dish(.65)], 50);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].timestamp, 100);
});
test('label switching on crossing frame remains review even after new label stabilizes', () => {
  const tracker = new DishTracker();
  tracker.update([dish(.4)], 0);
  const crossing = tracker.update([dish(.55, .2, 'soup')], 100);
  assert.equal(crossing.unknownEvents.length, 1);
  [.65, .7, .75].forEach((y, i) => assert.equal(tracker.update([dish(y, .2, 'soup')], 200 + i * 100).events.length, 0));
});
