'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const captions = require('../lib/captions');
const events = require('../lib/demo');

function fixture() {
  let definition, nextId = 1;
  const timers = new Map();
  const sandbox = {
    Page(value) { definition = value; },
    require(name) { return name.endsWith('captions') ? captions : events; },
    setInterval(fn, interval) { const id = nextId++; timers.set(id, { fn, interval }); return id; },
    clearInterval(id) { timers.delete(id); },
    tt: new Proxy({}, { get() { throw new Error('UI tried to access platform API'); } }),
    fetch() { throw new Error('UI tried to access network'); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/index/demo-controller.js'), 'utf8'), sandbox);
  const page = { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad();
  return { page, timers };
}

test('Minutes layout initially exposes complete neutral sample without starting playback', () => {
  const { page, timers } = fixture();
  assert.equal(timers.size, 0);
  assert.equal(page.data.rows.length, 2);
  assert.equal(page.data.rows[0].speaker, '发言人 1');
  assert.match(page.data.status, /本地示例.*未接入/);
  assert.equal(page.data.showTranslations, false);
});

test('pause resumes at the same event and speed changes keep exactly one timer', () => {
  const { page, timers } = fixture();
  page.togglePlayback(); page.advanceDemo();
  const index = page.demoIndex;
  page.togglePlayback(); assert.equal(timers.size, 0);
  page.togglePlayback(); assert.equal(page.demoIndex, index); assert.equal(timers.size, 1);
  page.openSpeed(); page.selectSpeed(1.25); assert.equal(page.data.speed, 1.25); assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].interval, 960);
  page.onHide(); assert.equal(timers.size, 0);
});

test('seeking rebuilds revisions and clamps skip controls at both sample boundaries', () => {
  const { page, timers } = fixture();
  page.seek(100);
  assert.equal(page.data.rows.length, 2);
  assert.equal(page.data.progress, 100);
  assert.match(page.data.translation, /talk as we walk/);
  page.skipBack();
  assert.equal(page.data.progress, 0);
  assert.equal(page.data.rows.length, 1);
  assert.equal(page.data.rows[0].source, 'Let us start');
  assert.equal(page.data.rows[0].translation, '');
  page.skipForward(); assert.equal(page.data.progress, 100);
  const before = page.data.progress;
  page.seek('invalid'); assert.equal(page.data.progress, before);
  assert.equal(timers.size, 0);
});

test('search is literal and case-insensitive with bounded query and reversible highlighting', () => {
  const { page } = fixture();
  page.toggleSearch(); page.updateSearch('LET');
  assert.equal(page.data.searchCount, 1);
  assert.equal(page.data.rows[0].sourceParts.find(p => p.match).text, 'Let');
  page.updateSearch('.*'); assert.equal(page.data.searchCount, 0);
  page.updateSearch('x'.repeat(1000)); assert.equal(page.data.searchQuery.length, 80);
  page.clearSearch(); assert.equal(page.data.searchOpen, false); assert.equal(page.data.searchCount, 0);
});

test('empty tabs, translated sample and cloud controls stay local and explicit', () => {
  const { page, timers } = fixture();
  page.setTab('chapters'); assert.equal(page.data.activeTab, 'chapters');
  assert.equal(page.data.chapters, undefined);
  page.setTab('summary'); assert.equal(page.data.activeTab, 'summary');
  page.setTab('transcript');
  page.setTab('unknown'); assert.equal(page.data.activeTab, 'transcript');
  page.toggleTranslations(); assert.equal(page.data.showTranslations, true);
  page.showAi(); assert.match(page.data.notice, /尚未接入/);
  page.showShare(); assert.match(page.data.notice, /暂不可分享/);
  page.goBack(); assert.match(page.data.notice, /本地预览/);
  page.resetSample(); assert.equal(page.data.rows.length, 2); assert.equal(page.data.notice, '');
  assert.equal(timers.size, 0);
});

test('speed sheet has seven supported values, rejects invalid speed and closes independently of playback', () => {
  const { page, timers } = fixture();
  assert.deepEqual(Array.from(page.data.speedOptions, option => option.value), [0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
  page.togglePlayback();
  page.toggleOptions(); page.openSpeed();
  assert.equal(page.data.optionsOpen, false); assert.equal(page.data.speedOpen, true);
  page.selectSpeed({ currentTarget: { dataset: { speed: '3' } } });
  assert.equal(page.data.speed, 3); assert.equal([...timers.values()][0].interval, 400);
  page.selectSpeed(0); page.selectSpeed(100); page.selectSpeed('invalid');
  assert.equal(page.data.speed, 3); assert.equal(timers.size, 1);
  page.toggleSkipSilence(); assert.equal(page.data.skipSilence, true); assert.match(page.data.notice, /没有音频/);
  page.closeSheets(); assert.equal(page.data.speedOpen, false); assert.equal(page.data.running, true);
  page.onUnload(); assert.equal(timers.size, 0);
});

test('search navigation selects actual literal matches and resets when the query is cleared', () => {
  const { page } = fixture();
  page.toggleSearch(); page.updateSearch('边');
  assert.equal(page.data.searchCount, 2); assert.equal(page.data.scrollTarget, 'search-hit-0');
  page.nextMatch(); assert.equal(page.data.searchIndex, 1); assert.equal(page.data.scrollTarget, 'search-hit-1');
  assert.equal(page.data.rows[1].sourceParts.filter(part => part.active).length, 1);
  page.nextMatch(); assert.equal(page.data.searchIndex, 0);
  page.previousMatch(); assert.equal(page.data.searchIndex, 1);
  page.updateSearch('no match'); page.nextMatch();
  assert.equal(page.data.searchCount, 0); assert.equal(page.data.searchIndex, 0); assert.equal(page.data.scrollTarget, '');
  page.useKeyword({ currentTarget: { dataset: { keyword: 'start' } } });
  assert.equal(page.data.searchCount, 1);
  page.clearQuery(); assert.equal(page.data.searchOpen, true); assert.equal(page.data.searchQuery, '');
  page.clearSearch(); assert.equal(page.data.searchOpen, false);
});

test('every unimplemented menu action reports a local limitation and leaves the sample intact', () => {
  const { page, timers } = fixture();
  const original = JSON.stringify(page.data.rows);
  for (const action of ['podcast', 'rename', 'speaker', 'download', 'stats', 'report', 'delete']) {
    page.toggleOptions();
    page.localOption({ currentTarget: { dataset: { option: action } } });
    assert.equal(page.data.optionsOpen, false);
    assert.match(page.data.notice, /本地示例/);
    assert.equal(JSON.stringify(page.data.rows), original);
  }
  assert.match(page.data.notice, /未执行删除/);
  page.toggleOptions(); page.toggleCommentMarkers();
  assert.equal(page.data.showCommentMarkers, false); assert.equal(page.data.optionsOpen, true);
  assert.match(page.data.notice, /没有评论记号/); assert.equal(timers.size, 0);
});
