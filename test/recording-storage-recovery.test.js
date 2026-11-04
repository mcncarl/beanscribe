'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../lib/recording-store');

function namedError(name) { const error = new Error(name); error.name = name; return error; }
function databaseFixture(outcomes = []) {
  const data = { recordings: new Map(), audio: new Map() };
  const databases = []; let attempts = 0, audioWriteAttempts = 0, audioWriteError = null;
  const indexedDB = { open() {
    const request = {};
    const database = { closed: false, close() { this.closed = true; },
      transaction(stores, mode) {
        attempts++;
        const outcome = outcomes.shift() || 'success';
        if (this.closed || outcome === 'InvalidStateError') throw namedError('InvalidStateError');
        let aborted = false;
        const writes = [], transaction = { error: null, abort() { aborted = true; },
          objectStore(name) { return {
            put(value) {
              if (name === 'audio') { audioWriteAttempts++; if (audioWriteError) throw audioWriteError; }
              writes.push([name, structuredClone(value)]);
            },
            get(id) { return { result: data[name].has(id) ? structuredClone(data[name].get(id)) : undefined }; },
            getAll() { return { result: [...data[name].values()].map(value => structuredClone(value)) }; }
          }; }
        };
        queueMicrotask(() => {
          if (aborted) return;
          if (outcome === 'success') {
            writes.forEach(([name, value]) => data[name].set(value.id, value));
            transaction.oncomplete();
          } else {
            transaction.error = outcome === 'abort-without-error' ? null : namedError(outcome);
            transaction.onabort({ target: transaction });
          }
        });
        return transaction;
      }
    };
    databases.push(database);
    queueMicrotask(() => { request.result = database; request.onsuccess(); });
    return request;
  } };
  return { store: model.createStore({ indexedDB }), data, databases, get attempts() { return attempts; },
    get audioWriteAttempts() { return audioWriteAttempts; }, set audioWriteError(value) { audioWriteError = value; } };
}

test('saving metadata after reopening preserves the persisted blob without serializing it again', async () => {
  const f = databaseFixture();
  const record = model.createRecord({ id: 'native-document-roundtrip', title: '原稿' });
  record.audioBlob = new Blob(['saved-audio']);
  await f.store.save(record);
  const reopened = await f.store.get(record.id);
  f.audioWriteError = namedError('UnknownError');
  reopened.title = '修改后的标题';
  await f.store.save(reopened);
  assert.equal(f.audioWriteAttempts, 1);
  const saved = await f.store.get(record.id);
  assert.equal(saved.title, '修改后的标题');
  assert.equal(saved.hasAudioBlob, true);
  assert.equal(await saved.audioBlob.text(), 'saved-audio');
});

test('a new audio blob still writes and a failed replacement preserves the original audio and metadata', async () => {
  const f = databaseFixture();
  const record = model.createRecord({ id: 'changed-audio', title: '原稿' });
  record.audioBlob = new Blob(['old-audio']);
  await f.store.save(record);
  const reopened = await f.store.get(record.id);
  reopened.audioBlob = new Blob(['new-audio']);
  reopened.title = '新稿';
  f.audioWriteError = namedError('UnknownError');
  await assert.rejects(f.store.save(reopened), error => error.name === 'UnknownError');
  assert.equal(f.audioWriteAttempts, 2);
  let saved = await f.store.get(record.id);
  assert.equal(saved.title, '原稿');
  assert.equal(await saved.audioBlob.text(), 'old-audio');
  f.audioWriteError = null;
  await f.store.save(reopened);
  saved = await f.store.get(record.id);
  assert.equal(saved.title, '新稿');
  assert.equal(await saved.audioBlob.text(), 'new-audio');
});

test('restoring an older blob after a replacement or reusing it for another record still writes audio', async () => {
  const f = databaseFixture();
  const original = model.createRecord({ id: 'restore-audio' });
  original.audioBlob = new Blob(['original']);
  await f.store.save(original);
  await f.store.save({ ...original, audioBlob: new Blob(['replacement']) });
  await f.store.save(original);
  assert.equal(await (await f.store.get(original.id)).audioBlob.text(), 'original');
  await f.store.save({ ...original, id: 'second-record' });
  assert.equal(await (await f.store.get('second-record')).audioBlob.text(), 'original');
  assert.equal(f.audioWriteAttempts, 4);
});

test('an interrupted local transaction reopens once and preserves text and audio', async () => {
  const f = databaseFixture(['abort-without-error', 'success']);
  const record = model.createRecord({ id: 'interrupted', title: '完整原稿' });
  record.audioBlob = new Blob(['original-audio']);
  record.segments = [{ id: 'one', source: '后台收到的文字', sourceLanguage: 'zh', startMs: 0, endMs: 1000 }];
  await f.store.save(record);
  assert.equal(f.databases.length, 2); assert.equal(f.databases[0].closed, true);
  assert.equal(f.attempts, 2); assert.equal(f.data.recordings.size, 1);
  const saved = await f.store.get(record.id);
  assert.equal(saved.segments[0].source, '后台收到的文字');
  assert.equal(await saved.audioBlob.text(), 'original-audio');
});

test('a stale closed database is replaced after synchronous InvalidStateError', async () => {
  const f = databaseFixture(['InvalidStateError', 'success']);
  await f.store.save(model.createRecord({ id: 'closed-connection' }));
  assert.equal(f.databases.length, 2); assert.equal(f.attempts, 2);
  assert.equal(f.data.recordings.has('closed-connection'), true);
});

test('quota and data failures are reported without retrying or changing prior content', async () => {
  for (const name of ['QuotaExceededError', 'DataCloneError']) {
    const f = databaseFixture(['success', name]);
    await f.store.save(model.createRecord({ id: 'existing', title: '原稿' }));
    await assert.rejects(f.store.save(model.createRecord({ id: 'existing', title: '尚未保存' })), error => error.name === name);
    assert.equal(f.attempts, 2); assert.equal(f.databases.length, 1);
    assert.equal(f.data.recordings.get('existing').title, '原稿');
  }
});

test('repeated transaction interruption has a bounded retry and remains a failure', async () => {
  const f = databaseFixture(['abort-without-error', 'abort-without-error']);
  await assert.rejects(f.store.save(model.createRecord({ id: 'unavailable' })), error => error.name === 'AbortError' && /暂时中断/.test(error.message));
  assert.equal(f.attempts, 2); assert.equal(f.data.recordings.size, 0);
});

test('unexpected connection close is forgotten without deleting saved recordings', async () => {
  const f = databaseFixture();
  await f.store.save(model.createRecord({ id: 'before' }));
  f.databases[0].closed = true; f.databases[0].onclose();
  await f.store.save(model.createRecord({ id: 'after' }));
  assert.equal(f.databases.length, 2);
  assert.deepEqual((await f.store.list()).map(row => row.id).sort(), ['after', 'before']);
});
