/** Bounding boxes use normalized [x, y, width, height]. IDs are session-local.
 * This is motion association, not physical identity: occlusion, camera motion and
 * returning objects can create new tracks. Use a fixed camera and a count line.
 */
export class DishTracker {
  constructor(options = {}) {
    this.options = { lineY: 0.5, direction: 'down', minObservations: 3, maxMissingMs: 1500, maxDistance: 0.18, hysteresis: 0.015, ...options };
    this.reset();
  }
  configure(options) { Object.assign(this.options, options); }
  reset() {
    this.sessionId = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.nextId = 1;
    this.tracks = [];
  }
  update(detections, timestamp = Date.now(), cameraStable = true) {
    this.cameraStable = cameraStable;
    if (!cameraStable) this.tracks.forEach(t => { t.side = null; });
    this.tracks = this.tracks.filter(t => timestamp - t.lastSeen <= this.options.maxMissingMs);
    const valid = detections.filter(d => Array.isArray(d.bbox) && d.bbox.length === 4 && d.bbox.every(Number.isFinite) && d.bbox[2] > 0 && d.bbox[3] > 0);
    const candidates = [];
    this.tracks.forEach((t, ti) => valid.forEach((d, di) => {
      // Extrapolate modestly through dropped frames, capped to avoid runaway motion.
      const elapsed = Math.max(0, timestamp - t.lastSeen);
      const c = center(d.bbox), old = center(t.bbox);
      const predicted = [old[0] + t.velocity[0] * Math.min(elapsed, 500), old[1] + t.velocity[1] * Math.min(elapsed, 500)];
      const distance = Math.hypot(c[0] - predicted[0], c[1] - predicted[1]);
      const overlap = iou(t.bbox, d.bbox);
      if (distance <= this.options.maxDistance || overlap > 0.1) {
        const conflict = t.dishId && d.dishId && t.dishId !== d.dishId ? 0.25 : 0;
        candidates.push({ ti, di, score: overlap + 1 - distance / this.options.maxDistance - conflict });
      }
    }));
    candidates.sort((a, b) => b.score - a.score);
    const matchedTracks = new Set(), matchedDetections = new Set();
    const events = [];
    for (const { ti, di } of candidates) {
      if (matchedTracks.has(ti) || matchedDetections.has(di)) continue;
      matchedTracks.add(ti); matchedDetections.add(di);
      this.observe(this.tracks[ti], valid[di], timestamp, events);
    }
    valid.forEach((d, di) => {
      if (matchedDetections.has(di)) return;
      const t = { id: String(this.nextId++), bbox: [...d.bbox], velocity: [0, 0], lastSeen: timestamp, observations: 0, stableObservations: 0, counted: false, side: null, dishId: null };
      this.tracks.push(t);
      this.observe(t, d, timestamp, events);
    });
    return { tracks: this.tracks.filter(t => t.lastSeen === timestamp).map(t => ({ ...t, bbox: [...t.bbox] })), events };
  }
  observe(t, d, timestamp, events) {
    const previous = center(t.bbox), current = center(d.bbox);
    const delta = timestamp - t.lastSeen;
    if (delta > 0) t.velocity = [(current[0] - previous[0]) / delta, (current[1] - previous[1]) / delta];
    t.bbox = [...d.bbox]; t.lastSeen = timestamp; t.observations++;
    const dishId = d.dishId && d.dishId !== 'unknown' ? d.dishId : null;
    t.stableObservations = dishId && dishId === t.dishId ? t.stableObservations + 1 : dishId ? 1 : 0;
    t.dishId = dishId; t.dishName = d.dishName || ''; t.confidence = d.confidence ?? null;
    const difference = current[1] - this.options.lineY;
    const side = !this.cameraStable ? null : difference < -this.options.hysteresis ? -1 : difference > this.options.hysteresis ? 1 : null;
    if (side !== null) {
      if (t.side !== null && side !== t.side) {
        const direction = side === 1 ? 'down' : 'up';
        if (!t.counted && dishId && t.stableObservations >= this.options.minObservations && (this.options.direction === 'both' || this.options.direction === direction)) {
          t.counted = true;
          const dedupeKey = `${this.sessionId}:${t.id}`;
          events.push({ id: dedupeKey, dedupeKey, sessionId: this.sessionId, trackId: t.id, dishId, dishName: t.dishName, timestamp, direction, confidence: t.confidence, bbox: [...t.bbox] });
        }
      }
      t.side = side;
    }
  }
}
function center(b) { return [b[0] + b[2] / 2, b[1] + b[3] / 2]; }
function iou(a, b) {
  const area = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return area / (a[2] * a[3] + b[2] * b[3] - area);
}
