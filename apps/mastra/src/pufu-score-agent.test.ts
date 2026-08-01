import assert from 'node:assert/strict';
import {
  buildPufuScoreGenerationContext,
  PUFU_SCORE_SCHEMA_VERSION,
  type PufuScoreGenerationContext,
} from '@pufu-lens/web/report';
import { buildPufuScoreAgentPrompt } from './pufu-score-agent.ts';

const exhibitionContext: PufuScoreGenerationContext = buildPufuScoreGenerationContext({
  documents: [
    {
      canonicalUri: 'https://note.example.com/osc-osaka',
      docType: 'web_page',
      documentId: 'doc-osc',
      occurredAt: '2026-01-31T15:24:00.000Z',
      summary:
        '昨年に引き続き、オープンソースカンファレンス＠大阪に「プ譜友の会」からプ譜エディターを出展しました。',
      title: '【プ譜友の会】オープンソースカンファレンス2026＠大阪の出展レポート',
    },
  ],
  generated: {
    sections: [
      {
        id: 'activity',
        markdown: '対外イベントでプ譜エディターを来場者に紹介する活動が進みました。',
        title: '概況',
      },
      {
        id: 'progress',
        markdown: '- ブースでプ譜エディターの画面や使い方を見せる。',
        title: '進行状況',
      },
      {
        id: 'risks',
        markdown: '- 出展で得た来場者の反応・質問・つまずきの整理',
        title: '課題・次のアクション',
      },
    ],
    summary: '出展レポートからプロジェクトの概況と進行状況を整理しました。',
    title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
  },
  period: { end: '2026-06-07', start: '2026-06-01' },
  projectSlug: 'pufu-tomonokai',
  totalDocumentCount: 1,
});

const releaseContext: PufuScoreGenerationContext = buildPufuScoreGenerationContext({
  documents: [
    {
      canonicalUri: 'https://example.com/pulls/7',
      docType: 'pull_request',
      documentId: 'doc-pr',
      occurredAt: '2026-06-03T00:00:00.000Z',
      summary: 'CLI の公開手順を整備し、利用者がローカルで試せる導線を追加しました。',
      title: 'Release CLI onboarding',
    },
  ],
  generated: {
    sections: [
      {
        id: 'activity',
        markdown: '成果物を外部に公開し、利用者からの反応を確認する段階に進みました。',
        title: '概況',
      },
      {
        id: 'progress',
        markdown: '- CLI の公開手順を整備し、利用者がローカルで試せる導線を追加した。',
        title: '進行状況',
      },
      {
        id: 'risks',
        markdown: '- 公開後の利用状況・反応の確認と、次に強化する機能の整理',
        title: '課題・次のアクション',
      },
    ],
    summary: '公開後の利用状況を確認しながら、次の改善点を整理しました。',
    title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
  },
  period: { end: '2026-06-07', start: '2026-06-01' },
  projectSlug: 'pufu-cli',
  totalDocumentCount: 1,
});

const exhibitionPrompt = buildPufuScoreAgentPrompt(exhibitionContext);
const releasePrompt = buildPufuScoreAgentPrompt(releaseContext);

assert.match(exhibitionPrompt, /オープンソースカンファレンス2026＠大阪/);
assert.match(releasePrompt, /Release CLI onboarding/);
assert.notEqual(exhibitionPrompt, releasePrompt);
assert.doesNotMatch(exhibitionPrompt, /doc-osc|canonicalUri|documentId|document_id/);
assert.doesNotMatch(releasePrompt, /doc-pr|canonicalUri|documentId|document_id/);
assert.match(exhibitionPrompt, /pufu-score-v1/);
assert.match(exhibitionPrompt, /未信頼 JSON/);

assert.equal(exhibitionContext.evidenceSources[0]?.title.includes('大阪'), true);
assert.equal(exhibitionContext.evidenceSources[0]?.summary.includes('プ譜エディター'), true);

assert.equal(PUFU_SCORE_SCHEMA_VERSION, 'pufu-score-v1');

console.log('mastra pufu score agent tests passed');
