(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MinutesRecordingStore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function now() { return new Date().toISOString(); }
  function finiteTime(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
  function language(value) { return value === 'en' ? 'en' : 'zh'; }
  function editedFields(row) {
    var fields = Array.isArray(row.editedFields) ? row.editedFields.filter(function (field) { return ['source', 'speaker', 'startMs', 'endMs'].includes(field); }) : [];
    if (row.edited && !fields.includes('source')) fields.push('source');
    if (row.speakerEdited && !fields.includes('speaker')) fields.push('speaker');
    if (row.timingEdited) ['startMs', 'endMs'].forEach(function (field) { if (!fields.includes(field)) fields.push(field); });
    return fields.filter(function (field, index) { return fields.indexOf(field) === index; });
  }
  function createRecord(options) {
    options = options || {};
    var stamp = now();
    return { schemaVersion: 1, id: options.id || 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      title: options.title || '录音 ' + new Date().toLocaleString('zh-CN', { hour12: false }), sourceLabel: options.sourceLabel || 'soundcore Work',
      createdAt: stamp, updatedAt: stamp, startedAt: null, endedAt: null, state: 'draft', durationMs: 0,
      language: language(options.language), sourceType: options.sourceType || 'live_device', segments: [], audioBlob: null, audioUrl: null, audioMimeType: '', hasAudioBlob: false, silenceRanges: [],
      summary: '', chapters: [], summaryStatus: 'idle', summaryError: '', translationStatus: 'idle', translationError: '', speakerDiarization: false, contentEdited: false, sourceVersion: 'stream', speakerJob: { status: 'idle' } };
  }
  function normalizeSegment(row) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 80 || typeof row.source !== 'string' || row.source.length > 10000) throw new Error('录音文字格式不正确');
    var fields = editedFields(row), sourceRevision = Number.isSafeInteger(row.sourceRevision) && row.sourceRevision >= 0 ? row.sourceRevision : 0;
    return { id: row.id, source: row.source, sourceLanguage: language(row.sourceLanguage),
      sourceRevision: sourceRevision,
      sourceFinal: row.sourceFinal !== false, translation: typeof row.translation === 'string' ? row.translation.slice(0, 10000) : '',
      translationLanguage: row.translationLanguage === 'zh' || row.translationLanguage === 'en' ? row.translationLanguage : (row.sourceLanguage === 'en' ? 'zh' : 'en'),
      translationRevision: Number.isSafeInteger(row.translationRevision) ? row.translationRevision : -1, translationFinal: !!row.translationFinal,
      startMs: finiteTime(row.startMs), endMs: finiteTime(row.endMs), speaker: typeof row.speaker === 'string' && row.speaker.trim() ? row.speaker.slice(0, 80) : '发言人',
      edited: fields.includes('source'), speakerEdited: fields.includes('speaker'), timingEdited: fields.includes('startMs') || fields.includes('endMs'),
      contentEdited: fields.length > 0, editedFields: fields,
      baseSourceRevision: fields.length ? (Number.isSafeInteger(row.baseSourceRevision) && row.baseSourceRevision >= 0 ? row.baseSourceRevision : sourceRevision) : null,
      contentConflict: !!row.contentConflict, providerSource: typeof row.providerSource === 'string' ? row.providerSource : '' };
  }
  function normalizeRecord(record) {
    if (!record || typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.id)) throw new Error('录音标识无效');
    if (!Array.isArray(record.segments) || record.segments.length > 50000) throw new Error('录音文字超出本地保存范围');
    var result = Object.assign(createRecord({ id: record.id }), record);
    result.title = String(result.title || '未命名录音').trim().slice(0, 160) || '未命名录音';
    result.segments = record.segments.map(normalizeSegment);
    result.contentEdited = result.segments.some(function (row) { return row.contentEdited; });
    result.durationMs = finiteTime(record.durationMs) || 0;
    result.updatedAt = typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : now();
    return result;
  }
  function applyCaption(record, event) {
    if (!event || !['transcript', 'translation'].includes(event.type) || typeof event.segmentId !== 'string' || !event.segmentId || event.segmentId.length > 80 ||
      !Number.isSafeInteger(event.revision) || event.revision < 0 || typeof event.text !== 'string' || event.text.length > 10000 ||
      !['zh', 'en'].includes(event.language) || typeof event.final !== 'boolean') throw new Error('收到无效字幕，已保留此前文字');
    var rows = record.segments.slice(), index = rows.findIndex(function (row) { return row.id === event.segmentId; }), old = rows[index], next;
    if (event.type === 'transcript') {
      if (old && (event.revision <= old.sourceRevision || (old.sourceFinal && !event.final) || old.edited)) return record;
      next = normalizeSegment({ id: event.segmentId, source: event.text, sourceLanguage: event.language, sourceRevision: event.revision,
        sourceFinal: event.final, startMs: finiteTime(event.startMs) === null && old ? old.startMs : event.startMs,
        endMs: finiteTime(event.endMs) === null && old ? old.endMs : event.endMs,
        speaker: old && old.speakerEdited ? old.speaker : (event.speaker || (old && old.speaker)), speakerEdited: old && old.speakerEdited });
    } else {
      if (!old || !Number.isSafeInteger(event.sourceRevision) || event.sourceRevision !== old.sourceRevision || event.language === old.sourceLanguage ||
        event.revision <= old.translationRevision || (old.translationFinal && !event.final)) return record;
      next = Object.assign({}, old, { translation: event.text, translationLanguage: event.language, translationRevision: event.revision, translationFinal: event.final });
    }
    if (index < 0) { if (rows.length >= 50000) throw new Error('字幕数量超出保存范围'); rows.push(next); } else rows[index] = next;
    return Object.assign({}, record, { segments: rows, updatedAt: now(), durationMs: Math.max(record.durationMs || 0, finiteTime(next.endMs) || 0) });
  }
  function mergeSegments(record, finalRows) {
    if (!Array.isArray(finalRows)) return record;
    var rows = record.segments.slice();
    finalRows.forEach(function (raw) {
      var item = normalizeSegment(raw), index = rows.findIndex(function (old) { return old.id === item.id; }), old = rows[index];
      var fields = old ? editedFields(old) : [], providerSource = item.providerSource || item.source;
      if (old && fields.length) {
        fields.forEach(function (field) { item[field] = old[field]; });
        item.editedFields = fields; item.contentEdited = true; item.edited = fields.includes('source'); item.speakerEdited = fields.includes('speaker'); item.timingEdited = fields.includes('startMs') || fields.includes('endMs');
        item.baseSourceRevision = Number.isSafeInteger(old.baseSourceRevision) && old.baseSourceRevision >= 0 ? old.baseSourceRevision : old.sourceRevision;
        item.contentConflict = item.contentConflict || item.baseSourceRevision !== item.sourceRevision; item.providerSource = providerSource;
        if (fields.includes('source') && old.source !== providerSource) { item.translation = ''; item.translationFinal = false; item.translationRevision = -1; }
      }
      var translationMatches = old && old.source === item.source && (fields.includes('source') ?
        item.baseSourceRevision === item.sourceRevision : old.sourceRevision === item.sourceRevision);
      if (old && !item.translation && translationMatches) item = Object.assign({}, item, { translation: old.translation, translationLanguage: old.translationLanguage, translationRevision: old.translationRevision, translationFinal: old.translationFinal });
      if (index < 0) rows.push(item); else if (item.sourceRevision >= old.sourceRevision) rows[index] = item;
    });
    return Object.assign({}, record, { segments: rows, updatedAt: now(), contentEdited: rows.some(function (row) { return editedFields(row).length > 0; }) });
  }
  function createStore(options) {
    options = options || {};
    if (options.adapter) return options.adapter;
    var indexed = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null), opening, currentDatabase;
    var persistedAudio = new WeakMap(), audioVersions = new Map();
    function rememberAudio(id, blob) { var version = {}; audioVersions.set(id, version); persistedAudio.set(blob, version); }
    function forget(database) {
      if (currentDatabase === database) { currentDatabase = null; opening = null; }
    }
    function db() {
      if (!indexed) return Promise.reject(new Error('此宿主未提供本地数据库，无法保存录音'));
      if (!opening) opening = new Promise(function (resolve, reject) {
        var request = indexed.open(options.name || 'minutes-recordings-v1', 1);
        request.onupgradeneeded = function () {
          var database = request.result;
          if (!database.objectStoreNames.contains('recordings')) database.createObjectStore('recordings', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('audio')) database.createObjectStore('audio', { keyPath: 'id' });
        };
        request.onsuccess = function () {
          var database = request.result; currentDatabase = database;
          database.onversionchange = function () { database.close(); forget(database); };
          database.onclose = function () { forget(database); };
          resolve(database);
        };
        request.onerror = function () { opening = null; reject(request.error || new Error('无法打开本地录音库')); };
        request.onblocked = function () { opening = null; reject(new Error('本地录音库被另一个页面占用，请关闭旧页面后重试')); };
      });
      return opening;
    }
    function run(stores, mode, work, retried) {
      var usedDatabase;
      return db().then(function (database) { usedDatabase = database; return new Promise(function (resolve, reject) {
        var transaction = database.transaction(stores, mode), result;
        transaction.oncomplete = function () { resolve(typeof result === 'function' ? result() : result); };
        transaction.onerror = transaction.onabort = function (event) {
          var error = transaction.error || (event && event.target && event.target.error);
          if (!error) { error = new Error('本地保存暂时中断，请保持页面打开后重试'); error.name = 'AbortError'; }
          reject(error);
        };
        try { result = work(transaction); } catch (error) { transaction.abort(); reject(error); }
      }); }).catch(function (error) {
        // An interrupted/closed local connection can be reopened safely: these
        // operations only read or put the same recording ID, with no ASR call.
        if (!retried && usedDatabase && ['AbortError', 'InvalidStateError'].includes(error.name)) {
          forget(usedDatabase); usedDatabase.close();
          return run(stores, mode, work, true);
        }
        throw error;
      });
    }
    return {
      list: function () { return run(['recordings'], 'readonly', function (transaction) { var request = transaction.objectStore('recordings').getAll(); return function () { return request.result.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }); }; }); },
      get: function (id) { return run(['recordings', 'audio'], 'readonly', function (transaction) {
        var recordRequest = transaction.objectStore('recordings').get(id), audioRequest = transaction.objectStore('audio').get(id);
        return function () {
          if (!recordRequest.result) return null;
          var blob = audioRequest.result ? audioRequest.result.blob : null;
          if (blob) rememberAudio(id, blob);
          return Object.assign({}, recordRequest.result, { audioBlob: blob });
        };
      }); },
      save: function (record) {
        var value = normalizeRecord(record), metadata = Object.assign({}, value), blob = value.audioBlob;
        delete metadata.audioBlob;
        metadata.hasAudioBlob = !!blob || !!metadata.hasAudioBlob;
        return run(['recordings', 'audio'], 'readwrite', function (transaction) {
          transaction.objectStore('recordings').put(metadata);
          // iOS may reject reserializing a persisted Blob while the webview is
          // hidden. Metadata updates do not need to rewrite unchanged audio.
          if (blob && (!audioVersions.has(value.id) || persistedAudio.get(blob) !== audioVersions.get(value.id))) transaction.objectStore('audio').put({ id: value.id, blob: blob });
          return Object.assign({}, metadata, { audioBlob: blob || null });
        }).then(function (saved) {
          if (blob) rememberAudio(value.id, blob);
          return saved;
        });
      }
    };
  }
  function pad(value, length) { return String(value).padStart(length, '0'); }
  function srtTime(ms) { var value = Math.floor(ms); return pad(Math.floor(value / 3600000), 2) + ':' + pad(Math.floor(value / 60000) % 60, 2) + ':' + pad(Math.floor(value / 1000) % 60, 2) + ',' + pad(value % 1000, 3); }
  function timeLabel(ms) { if (finiteTime(ms) === null) return '时间未提供'; return pad(Math.floor(ms / 60000), 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2); }
  function toText(record) {
    var lines = [record.title, '创建时间：' + new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false }), ''];
    if (record.summary) lines.push('纪要', record.summary, '');
    record.segments.forEach(function (row) { if (!row.source) return; lines.push('[' + timeLabel(row.startMs) + '] ' + row.speaker, row.source); if (row.translation) lines.push(row.translation); lines.push(''); });
    return lines.join('\n');
  }
  function toSrt(record) {
    var rows = record.segments.filter(function (row) { return row.source.trim(); });
    if (!rows.length) throw new Error('还没有可导出的文字');
    if (rows.some(function (row) { return finiteTime(row.startMs) === null || finiteTime(row.endMs) === null || row.endMs <= row.startMs; })) throw new Error('部分字幕缺少真实时间戳，暂不能导出 SRT');
    rows = rows.slice().sort(function (a, b) { return a.startMs - b.startMs; });
    return rows.map(function (row, index) { return (index + 1) + '\n' + srtTime(row.startMs) + ' --> ' + srtTime(row.endMs) + '\n' + row.source.replace(/\r/g, '') + (row.translation ? '\n' + row.translation.replace(/\r/g, '') : '') + '\n'; }).join('\n');
  }
  function safeFilename(title) { return String(title || '录音').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100).trim() || '录音'; }
  return { createStore: createStore, createRecord: createRecord, normalizeRecord: normalizeRecord, applyCaption: applyCaption, mergeSegments: mergeSegments, editedFields: editedFields,
    toText: toText, toSrt: toSrt, safeFilename: safeFilename, timeLabel: timeLabel };
}));
