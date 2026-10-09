"""Transactional bounded SQLite queue. Original snapshots survive failed uploads."""
import hashlib
import json
import os
import pathlib
import random
import shutil
import sqlite3
import threading
import time

from config import EdgeError, utc_now


def private_directory(location):
    location = pathlib.Path(location)
    location.mkdir(parents=True, exist_ok=True, mode=0o700)
    if location.is_symlink() or not location.is_dir():
        raise EdgeError('state_directory_unsafe')
    location.chmod(0o700)
    return location


def atomic_json(filename, value):
    filename = pathlib.Path(filename)
    temporary = filename.with_name(filename.name + '.tmp')
    with open(temporary, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, filename)
    # Directory fsync makes rename durable on supported local POSIX filesystems.
    fd = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Outbox:
    def __init__(self, state_dir, limits=None):
        self.directory = private_directory(state_dir)
        self.path = self.directory / 'queue.sqlite'
        self.limits = {'maxQueueBytes': 2**31, 'maxQueueRows': 100000, 'reserveFreeBytes': 512*2**20, **(limits or {})}
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS outbox(key TEXT PRIMARY KEY,endpoint TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,bytes INTEGER NOT NULL,
            created REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt REAL NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',error_code TEXT);
          CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state,next_attempt,created);
          CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        """)
        self.path.chmod(0o600)
        self.db.commit()

    def stats(self):
        with self.lock:
            row = self.db.execute('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes,MIN(created) oldest,SUM(state=\'blocked\') blocked FROM outbox').fetchone()
            free = shutil.disk_usage(self.directory).free
            return {'queueDepth': row['count'], 'queueBytes': row['bytes'], 'oldestQueueAgeSec': max(0., time.time()-row['oldest']) if row['oldest'] else 0.,
                    'blockedRows': row['blocked'] or 0, 'freeDiskBytes': free,
                    'capacityAvailable': free >= self.limits['reserveFreeBytes'] and row['bytes'] < self.limits['maxQueueBytes'] and row['count'] < self.limits['maxQueueRows']}

    def enqueue(self, key, endpoint, payload):
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        byte_size = len(encoded.encode())
        with self.lock:
            existing = self.db.execute('SELECT payload_hash FROM outbox WHERE key=?', (key,)).fetchone()
            if existing:
                if existing['payload_hash'] != digest:
                    raise EdgeError('outbox_identity_conflict')
                return False
            info = self.stats()
            if info['freeDiskBytes'] - byte_size < self.limits['reserveFreeBytes'] or info['queueBytes'] + byte_size > self.limits['maxQueueBytes'] or info['queueDepth'] >= self.limits['maxQueueRows']:
                raise EdgeError('storage_full')
            try:
                with self.db:
                    self.db.execute('INSERT INTO outbox(key,endpoint,payload,payload_hash,bytes,created) VALUES(?,?,?,?,?,?)', (key, endpoint, encoded, digest, byte_size, time.time()))
            except sqlite3.Error:
                raise EdgeError('storage_write_failed') from None
            return True

    def due(self):
        with self.lock:
            row = self.db.execute("SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY created LIMIT 1", (time.time(),)).fetchone()
            return dict(row) if row else None

    def ack(self, key):
        with self.lock:
            with self.db:
                self.db.execute('DELETE FROM outbox WHERE key=?', (key,))
            self.db.execute('PRAGMA incremental_vacuum(16)')

    def fail(self, key, code, retry=True, immediate=False):
        with self.lock:
            row = self.db.execute('SELECT attempts FROM outbox WHERE key=?', (key,)).fetchone()
            if not row:
                return
            attempts = row['attempts'] + 1
            backoff = 0.1 if immediate else min(300., 2 ** min(attempts, 8)) * random.uniform(.8, 1.2)
            with self.db:
                self.db.execute('UPDATE outbox SET attempts=?,next_attempt=?,state=?,error_code=? WHERE key=?', (attempts, time.time()+backoff, 'pending' if retry else 'blocked', code, key))

    def retry_blocked(self):
        with self.lock:
            with self.db:
                self.db.execute("UPDATE outbox SET state='pending',next_attempt=0 WHERE state='blocked'")

    def state(self, key, default=None):
        with self.lock:
            row = self.db.execute('SELECT value FROM state WHERE key=?', (key,)).fetchone()
            return json.loads(row['value']) if row else default

    def set_state(self, key, value):
        with self.lock:
            with self.db:
                self.db.execute('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value, ensure_ascii=False, allow_nan=False)))

    def close(self):
        with self.lock:
            self.db.close()
