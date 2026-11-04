var captions = require('../../lib/captions');
var demoEvents = require('../../lib/demo');
var STEP_MS = 1200;
var DURATION_MS = demoEvents.length * STEP_MS;
var TABS = ['transcript', 'summary', 'chapters', 'speakers', 'info'];
var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function timeLabel(milliseconds) {
  var seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
function parts(text, query) {
  if (!query) return [{ key: '0', text: text, match: false }];
  var result = [], start = 0, lower = text.toLowerCase(), needle = query.toLowerCase(), found;
  while ((found = lower.indexOf(needle, start)) !== -1) {
    if (found > start) result.push({ key: String(result.length), text: text.slice(start, found), match: false });
    result.push({ key: String(result.length), text: text.slice(found, found + query.length), match: true });
    start = found + query.length;
  }
  if (start < text.length) result.push({ key: String(result.length), text: text.slice(start), match: false });
  return result;
}
Page({
  data: Object.assign({
    running: false, status: '本地示例 · 未接入录音豆', title: 'soundcore Work_本地示例',
    dateLabel: '', createdAt: '', activeTab: 'transcript', elapsed: '00:00', duration: timeLabel(DURATION_MS),
    progress: 0, speed: 1, rows: [], searchOpen: false, searchQuery: '', searchCount: 0, searchIndex: 0, scrollTarget: '',
    searchKeywords: ['start', 'small step', '边走边聊'], optionsOpen: false, speedOpen: false,
    skipSilence: false, showCommentMarkers: true, showTranslations: false, notice: '',
    speedOptions: SPEEDS.map(function (speed) { return { value: speed, major: [0.5, 1, 2, 3].indexOf(speed) !== -1 }; })
  }, captions.view(captions.createState())),
  onLoad: function () {
    this.captionState = captions.createState(); this.demoTimer = null; this.demoIndex = 0; this.positionMs = 0;
    var now = new Date(), clock = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    this.setData({ dateLabel: (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 ' + clock,
      createdAt: now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + clock });
    for (var i = 0; i < demoEvents.length; i++) this.captionState = captions.reduce(this.captionState, demoEvents[i]);
    this.renderCaptions();
  },
  renderCaptions: function () {
    var query = this.data.searchQuery, matches = 0;
    var rows = this.captionState.segments.map(function (row, index) {
      var segments = parts(row.source, query);
      segments.forEach(function (part) {
        if (part.match) { part.matchIndex = matches++; part.id = 'search-hit-' + part.matchIndex; }
      });
      return { id: row.id, speaker: '发言人 1', time: index === 0 ? '00:00' : '00:03', source: row.source,
        sourceParts: segments, translation: row.translation, final: row.sourceFinal,
        current: index === this.captionState.segments.length - 1 && this.data.running };
    }, this);
    var selected = matches ? Math.min(this.data.searchIndex, matches - 1) : 0;
    rows.forEach(function (row) { row.sourceParts.forEach(function (part) { part.active = part.match && part.matchIndex === selected; }); });
    this.setData(Object.assign({}, captions.view(this.captionState), { rows: rows, searchCount: matches, searchIndex: selected,
      scrollTarget: matches && this.data.searchOpen ? 'search-hit-' + selected : '',
      elapsed: timeLabel(this.positionMs), progress: Math.min(100, this.positionMs / DURATION_MS * 100) }));
  },
  startTimer: function () {
    if (this.demoTimer !== null) clearInterval(this.demoTimer);
    this.demoTimer = setInterval(this.advanceDemo.bind(this), STEP_MS / this.data.speed);
  },
  startDemo: function () {
    this.stopDemo(); this.captionState = captions.createState(); this.demoIndex = 0; this.positionMs = 0;
    this.setData({ running: true, status: '示例播放中 · 未接入录音豆', notice: '' });
    this.advanceDemo(); this.startTimer();
  },
  togglePlayback: function () {
    if (this.data.running) { this.stopDemo(); return; }
    if (this.demoIndex === 0 || this.demoIndex >= demoEvents.length) { this.startDemo(); return; }
    this.setData({ running: true, status: '示例播放中 · 未接入录音豆' }); this.startTimer(); this.renderCaptions();
  },
  advanceDemo: function () {
    if (this.demoIndex >= demoEvents.length) {
      this.positionMs = DURATION_MS; this.stopDemo(); this.setData({ status: '示例结束 · 未接入录音豆' }); this.renderCaptions(); return;
    }
    this.captionState = captions.reduce(this.captionState, demoEvents[this.demoIndex]);
    this.positionMs = this.demoIndex * STEP_MS; this.demoIndex++; this.renderCaptions();
  },
  stopDemo: function () {
    if (this.demoTimer !== null && this.demoTimer !== undefined) clearInterval(this.demoTimer);
    this.demoTimer = null; this.setData({ running: false, status: '本地示例 · 未接入录音豆' });
  },
  seekTo: function (milliseconds) {
    var wasRunning = this.data.running; this.stopDemo();
    this.positionMs = Math.max(0, Math.min(DURATION_MS, milliseconds));
    this.demoIndex = Math.min(demoEvents.length, Math.floor(this.positionMs / STEP_MS) + 1);
    this.captionState = captions.createState();
    for (var i = 0; i < this.demoIndex; i++) this.captionState = captions.reduce(this.captionState, demoEvents[i]);
    if (wasRunning && this.positionMs < DURATION_MS) {
      this.setData({ running: true, status: '示例播放中 · 未接入录音豆' }); this.startTimer();
    }
    this.renderCaptions();
  },
  seek: function (event) {
    var value = Number(event && event.detail ? event.detail.value : event);
    if (Number.isFinite(value)) this.seekTo(Math.max(0, Math.min(100, value)) / 100 * DURATION_MS);
  },
  skipBack: function () { this.seekTo(this.positionMs - 15000); },
  skipForward: function () { this.seekTo(this.positionMs + 15000); },
  openSpeed: function () { this.setData({ speedOpen: true, optionsOpen: false, notice: '' }); },
  selectSpeed: function (event) {
    var speed = Number(event && event.currentTarget ? event.currentTarget.dataset.speed : event);
    if (SPEEDS.indexOf(speed) === -1) return;
    this.setData({ speed: speed });
    if (this.data.running) this.startTimer();
  },
  toggleSkipSilence: function () {
    this.setData({ skipSilence: !this.data.skipSilence, notice: '本地示例没有音频，跳过空白片段仅保留开关状态。' });
  },
  setTab: function (event) {
    var name = typeof event === 'string' ? event : event.currentTarget.dataset.tab;
    if (TABS.indexOf(name) !== -1) this.setData({ activeTab: name, optionsOpen: false, speedOpen: false, notice: '' });
  },
  toggleSearch: function () { this.setData({ searchOpen: !this.data.searchOpen, activeTab: 'transcript', optionsOpen: false, speedOpen: false, notice: '' }); },
  updateSearch: function (event) {
    var query = String(event && event.detail ? event.detail.value : event || '').slice(0, 80);
    this.setData({ searchQuery: query, searchIndex: 0 }); this.renderCaptions();
  },
  useKeyword: function (event) { this.updateSearch(event.currentTarget.dataset.keyword); },
  clearQuery: function () { this.updateSearch(''); },
  moveSearch: function (direction) {
    if (!this.data.searchCount) return;
    this.setData({ searchIndex: (this.data.searchIndex + direction + this.data.searchCount) % this.data.searchCount });
    this.renderCaptions();
  },
  previousMatch: function () { this.moveSearch(-1); },
  nextMatch: function () { this.moveSearch(1); },
  clearSearch: function () { this.setData({ searchQuery: '', searchOpen: false, searchIndex: 0 }); this.renderCaptions(); },
  toggleOptions: function () { this.setData({ optionsOpen: !this.data.optionsOpen, speedOpen: false, notice: '' }); },
  closeSheets: function () { this.setData({ optionsOpen: false, speedOpen: false, notice: '' }); },
  toggleCommentMarkers: function () { this.setData({ showCommentMarkers: !this.data.showCommentMarkers,
    notice: '已更新本地开关；当前示例没有评论记号。' }); },
  toggleTranslations: function () { this.setData({ showTranslations: !this.data.showTranslations, optionsOpen: false,
    notice: '仅显示或隐藏预设示例译文，未调用翻译服务。' }); },
  localOption: function (event) {
    var action = event.currentTarget.dataset.option;
    var messages = {
      podcast: '本地示例没有音频，暂不支持播客模式。',
      rename: '本地示例尚未接入录音文件，暂不可重命名。',
      speaker: '本地示例未接入真实发言人识别，暂不可修改说话人。',
      download: '本地示例没有音频文件，暂不可下载。',
      stats: '本地示例尚未产生真实播放统计。',
      report: '本地示例未接入举报服务。',
      delete: '本地示例没有云端录音，未执行删除。'
    };
    if (messages[action]) this.setData({ optionsOpen: false, notice: messages[action] });
  },
  resetSample: function () {
    this.stopDemo(); this.positionMs = 0; this.demoIndex = 0; this.captionState = captions.createState();
    for (var i = 0; i < demoEvents.length; i++) this.captionState = captions.reduce(this.captionState, demoEvents[i]);
    this.setData({ optionsOpen: false, speedOpen: false, searchQuery: '', searchOpen: false, searchIndex: 0, notice: '' }); this.renderCaptions();
  },
  showAi: function () { this.setData({ notice: '这是本地界面示例，尚未接入 AI 纪要服务。', optionsOpen: false }); },
  showShare: function () { this.setData({ notice: '本地示例尚未上传飞书，暂不可分享。', optionsOpen: false }); },
  goBack: function () { this.stopDemo(); this.setData({ notice: '当前是独立的本地预览页面，没有上一条录音。' }); },
  dismissNotice: function () { this.setData({ notice: '' }); },
  onHide: function () { this.stopDemo(); },
  onUnload: function () { this.stopDemo(); }
});
