/* Prepared sample text. This does not record, recognize, or translate audio. */
module.exports = [
  { type: 'transcript', segmentId: 'demo-1', revision: 0, language: 'en', text: 'Let us start', final: false },
  { type: 'transcript', segmentId: 'demo-1', revision: 1, language: 'en', text: 'Let us start with one small step.', final: true },
  { type: 'translation', segmentId: 'demo-1', sourceRevision: 1, revision: 0, language: 'zh', text: '让我们先迈出一小步。', final: true },
  { type: 'transcript', segmentId: 'demo-2', revision: 0, language: 'zh', text: '我们可以边走边', final: false },
  { type: 'transcript', segmentId: 'demo-2', revision: 1, language: 'zh', text: '我们可以边走边聊，想法会慢慢清晰。', final: true },
  { type: 'translation', segmentId: 'demo-2', sourceRevision: 1, revision: 0, language: 'en', text: 'We can talk as we walk, and the ideas will become clearer.', final: true }
];
