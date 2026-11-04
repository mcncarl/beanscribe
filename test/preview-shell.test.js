'use strict';
// Focused checks of preview.html's own script pieces, run against small stand-ins for the DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../preview.html'), 'utf8');

function source(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' is defined');
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end);
}
class Element {
  constructor() { this.children = []; this.attributes = {}; this.dataset = {}; this.textContent = ''; this.rebuilds = 0; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; this.rebuilds++; }
  toggleAttribute(name, on) { if (on) this.attributes[name] = ''; else delete this.attributes[name]; }
}

test('the library list is rebuilt only when the list of recordings itself changes', () => {
  const elements = {};
  const $ = id => elements[id] || (elements[id] = new Element());
  const context = {
    $, AUTO_TITLE: /^录音 \d{4}\/\d{1,2}\/\d{1,2}/, span: () => '',
    hide: (id, value) => $(id).toggleAttribute('hidden', !!value),
    text: (id, value) => { $(id).textContent = value === undefined || value === null ? '' : String(value); },
    node: (tag, className, value) => { const el = new Element(); el.tag = tag; el.className = className; if (value !== undefined) el.textContent = value; return el; },
    document: { createTextNode: value => ({ text: value }) }
  };
  vm.runInNewContext(source('renderLibrary') + source('libraryGroups'), context);
  const records = [{ id: 'a', title: '周会', createdAt: '2026-11-03T01:00:00Z', dayText: '今天', timeText: '09:00', state: 'stopped', stateText: '已保存', previewText: '你好' }];
  const data = { records, error: '', loading: false };
  context.renderLibrary(data);
  const groups = $('recording-groups');
  assert.equal(groups.rebuilds, 1); assert.equal(groups.children.length, 2);
  // Captions, status and busy changes re-render with the same list: nothing is rebuilt.
  for (let i = 0; i < 5; i++) context.renderLibrary({ ...data, loading: i % 2 === 0 });
  assert.equal(groups.rebuilds, 1); assert.equal(groups.children.length, 2);
  // A reloaded library is drawn again, and the empty state still follows it.
  context.renderLibrary({ ...data, records: [] });
  assert.equal(groups.rebuilds, 2); assert.equal(groups.children.length, 0);
  assert.equal('hidden' in $('library-empty').attributes, false);
});

test('a page restored from the back-forward cache reloads, since pagehide released the runtime', () => {
  const line = html.split('\n').find(text => text.includes("addEventListener('pageshow'"));
  assert.ok(line, 'a pageshow listener exists');
  const listeners = {}, reloads = [];
  const context = { window: { addEventListener(name, listener) { listeners[name] = listener; } }, location: { reload() { reloads.push('reload'); } } };
  vm.runInNewContext(line, context);
  listeners.pageshow({ persisted: false });
  assert.equal(reloads.length, 0);
  listeners.pageshow({ persisted: true });
  assert.equal(reloads.length, 1);
});
