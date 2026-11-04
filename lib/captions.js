/* The event schema belongs to this scaffold, not to Feishu or any ASR vendor. */
var MAX_SEGMENTS = 80;
var MAX_TEXT = 2000;

function revision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT;
}

function createState() {
  return { segments: [] };
}

function reduce(state, event) {
  if (!event || !['transcript', 'translation'].includes(event.type) ||
      typeof event.segmentId !== 'string' || !event.segmentId || event.segmentId.length > 80 ||
      !revision(event.revision) || !validText(event.text) ||
      !['zh', 'en'].includes(event.language) || typeof event.final !== 'boolean') {
    throw new Error('Invalid caption event');
  }
  var rows = state.segments.slice();
  var index = rows.findIndex(function (row) { return row.id === event.segmentId; });
  var old = index < 0 ? null : rows[index];
  var next;
  if (event.type === 'transcript') {
    if (old && (event.revision <= old.sourceRevision || (old.sourceFinal && !event.final))) return state;
    next = {
      id: event.segmentId,
      source: event.text,
      sourceLanguage: event.language,
      sourceRevision: event.revision,
      sourceFinal: event.final,
      translation: '',
      translationLanguage: event.language === 'en' ? 'zh' : 'en',
      translationRevision: -1,
      translationFinal: false
    };
  } else {
    if (!revision(event.sourceRevision)) throw new Error('Missing translation source revision');
    if (!old || event.sourceRevision !== old.sourceRevision ||
        event.language === old.sourceLanguage || event.revision <= old.translationRevision ||
        (old.translationFinal && !event.final)) return state;
    next = Object.assign({}, old, {
      translation: event.text,
      translationLanguage: event.language,
      translationRevision: event.revision,
      translationFinal: event.final
    });
  }
  if (index < 0) rows.push(next);
  else rows[index] = next;
  return { segments: rows.slice(-MAX_SEGMENTS) };
}

function view(state) {
  var rows = state.segments;
  var current = rows[rows.length - 1];
  return {
    source: current ? current.source : '点击下方按钮，预览字幕变化。',
    sourceLabel: !current || current.sourceLanguage === 'zh' ? '中文原话' : '英文原话',
    translation: current ? current.translation : 'Click below to preview the captions.',
    translationLabel: !current || current.sourceLanguage === 'zh' ? '英文译文' : '中文译文',
    sourceFinal: current ? current.sourceFinal : false,
    history: rows.slice(0, -1).slice(-5)
  };
}

module.exports = { createState: createState, reduce: reduce, view: view, MAX_SEGMENTS: MAX_SEGMENTS };
