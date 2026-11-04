'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/recording-store');
function event(id, options = {}) { return { type: 'transcript', segmentId: id, revision: 0, language: 'zh', text: '今天讨论项目安排。', final: true, startMs: 100, endMs: 2100, speaker: '发言人', ...options }; }

test('recording persistence model retains more than the old 80-row UI window', () => {
  let record = store.createRecord({ id: 'full-recording' });
  for (let i = 0; i < 150; i++) record = store.applyCaption(record, event('row-' + i));
  assert.equal(record.segments.length, 150);
  assert.equal(store.normalizeRecord(record).segments.length, 150);
  assert.equal(record.segments[0].id, 'row-0');
});

test('caption revisions reject stale text and translation and retain real time boundaries', () => {
  let record = store.createRecord({ id: 'revision-recording' });
  record = store.applyCaption(record, event('row', { final: false, text: '今天', endMs: null }));
  record = store.applyCaption(record, event('row', { revision: 1, text: '今天讨论。', startMs: undefined, endMs: 2100 }));
  record = store.applyCaption(record, { type: 'translation', segmentId: 'row', revision: 0, sourceRevision: 1, text: 'We discuss today.', language: 'en', final: true });
  record = store.applyCaption(record, event('row', { revision: 0, text: 'stale' }));
  record = store.applyCaption(record, { type: 'translation', segmentId: 'row', revision: 1, sourceRevision: 0, text: 'stale translation', language: 'en', final: true });
  assert.equal(record.segments[0].source, '今天讨论。');
  assert.equal(record.segments[0].translation, 'We discuss today.');
  assert.equal(record.segments[0].startMs, 100);
  assert.equal(record.segments[0].endMs, 2100);
});

test('final service output cannot erase local edits or received segments omitted from the response', () => {
  let record = store.createRecord({ id: 'edited-recording' });
  record = store.applyCaption(record, event('row'));
  record = store.applyCaption(record, event('omitted'));
  record.segments[0] = { ...record.segments[0], source: '手动修订正文', edited: true, speaker: '王同学', speakerEdited: true };
  record = store.mergeSegments(record, [{ ...record.segments[0], source: 'provider text', edited: false, speaker: '发言人', speakerEdited: false }]);
  assert.equal(record.segments[0].source, '手动修订正文');
  assert.equal(record.segments[0].speaker, '王同学');
  assert.equal(record.segments.length, 2);
});

test('TXT and SRT export real text and timestamps without fabricated timing', () => {
  let record = store.createRecord({ id: 'export-recording', title: '项目/讨论' });
  record = store.applyCaption(record, event('row'));
  assert.match(store.toText(record), /今天讨论项目安排/);
  assert.match(store.toSrt(record), /00:00:00,100 --> 00:00:02,100/);
  assert.equal(store.safeFilename(record.title), '项目_讨论');
  record.segments[0].startMs = null;
  assert.throws(() => store.toSrt(record), /缺少真实时间戳/);
  assert.match(store.toText(record), /时间未提供/);
});

test('unavailable local database reports failure instead of claiming a save', async () => {
  const database = store.createStore();
  await assert.rejects(database.save(store.createRecord({ id: 'no-database' })), /无法保存录音/);
  assert.equal(typeof database.delete, 'undefined');
});

test('ordinary cached captions are not marked as manual content edits', () => {
  let record = store.createRecord({ id: 'ordinary-cache' });
  record = store.applyCaption(record, event('row'));
  const normalized = store.normalizeRecord(record);
  assert.equal(normalized.contentEdited, false);
  assert.equal(normalized.segments[0].contentEdited, false);
  assert.deepEqual(normalized.segments[0].editedFields, []);
  assert.equal(normalized.segments[0].baseSourceRevision, null);
});

test('new finalized provider output preserves only explicit fields and flags an outdated edit base', () => {
  let record = store.createRecord({ id: 'manual-conflict' });
  record = store.applyCaption(record, event('row', { revision: 1 }));
  record.segments[0] = { ...record.segments[0], source: '手工正文', speaker: '王同学', startMs: 200, endMs: 2000,
    edited: true, speakerEdited: true, timingEdited: true, contentEdited: true,
    editedFields: ['source', 'speaker', 'startMs', 'endMs'], baseSourceRevision: 1,
    translation: 'Outdated translated text', translationFinal: true };
  record = store.mergeSegments(record, [{ id: 'row', source: '更新后的原转写', sourceLanguage: 'zh', sourceRevision: 2,
    sourceFinal: true, startMs: 80, endMs: 2500, speaker: '发言人' }]);
  const row = record.segments[0];
  assert.equal(row.source, '手工正文'); assert.equal(row.speaker, '王同学');
  assert.equal(row.startMs, 200); assert.equal(row.endMs, 2000);
  assert.equal(row.sourceRevision, 2); assert.equal(row.baseSourceRevision, 1);
  assert.equal(row.contentConflict, true); assert.equal(row.providerSource, '更新后的原转写');
  assert.equal(row.translation, ''); assert.equal(record.contentEdited, true);
});
