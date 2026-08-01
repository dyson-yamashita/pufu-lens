import assert from 'node:assert/strict';
import { createPufuScoreFromReport } from './pufu-score.ts';
import { buildContextualPufuScore } from './pufu-score-generation.ts';
import { toPufuScoreReportInput } from './pufu-score-input.ts';
import {
  PUFU_SCORE_SCHEMA_VERSION,
  type PufuScoreSemanticV1,
  validatePufuScoreSemantic,
} from './pufu-score-schema.ts';

const exhibitionReport = {
  period: { end: '2026-06-07', start: '2026-06-01' },
  pufu_sources: [
    {
      doc_type: 'web_page',
      occurred_at: '2026-01-31T15:24:00.000Z',
      snippet:
        '昨年に引き続き、オープンソースカンファレンス＠大阪に「プ譜友の会」からプ譜エディターを出展しました。',
      title: '【プ譜友の会】オープンソースカンファレンス2026＠大阪の出展レポート',
    },
  ],
  report_id: 'report-exhibition',
  sections: [
    {
      id: 'activity' as const,
      markdown: '対外イベントでプ譜エディターを来場者に紹介する活動が進みました。',
      title: '概況',
    },
    {
      id: 'progress' as const,
      markdown: '- ブースでプ譜エディターの画面や使い方を見せる。',
      title: '進行状況',
    },
    {
      id: 'risks' as const,
      markdown: '- 出展で得た来場者の反応・質問・つまずきの整理',
      title: '課題・次のアクション',
    },
  ],
  summary: '出展レポートからプロジェクトの概況と進行状況を整理しました。',
  title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
};

const releaseReport = {
  period: { end: '2026-06-07', start: '2026-06-01' },
  pufu_sources: [
    {
      doc_type: 'pull_request',
      occurred_at: '2026-06-03T00:00:00.000Z',
      snippet: 'CLI の公開手順を整備し、利用者がローカルで試せる導線を追加しました。',
      title: 'Release CLI onboarding',
    },
  ],
  report_id: 'report-release',
  sections: [
    {
      id: 'activity' as const,
      markdown: '成果物を外部に公開し、利用者からの反応を確認する段階に進みました。',
      title: '概況',
    },
    {
      id: 'progress' as const,
      markdown: '- CLI の公開手順を整備し、利用者がローカルで試せる導線を追加した。',
      title: '進行状況',
    },
    {
      id: 'risks' as const,
      markdown: '- 公開後の利用状況・反応の確認と、次に強化する機能の整理',
      title: '課題・次のアクション',
    },
  ],
  summary: '公開後の利用状況を確認しながら、次の改善点を整理しました。',
  title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
};

const exhibitionScore = createPufuScoreFromReport(exhibitionReport);
const releaseScore = createPufuScoreFromReport(releaseReport);

assert.notEqual(exhibitionScore.gainingGoal.text, releaseScore.gainingGoal.text);
assert.notEqual(exhibitionScore.winCondition.text, releaseScore.winCondition.text);
assert.notEqual(exhibitionScore.purposes[0]?.text, releaseScore.purposes[0]?.text);
assert.doesNotMatch(JSON.stringify(exhibitionScore), /プ譜エディターを試す人を増やす/);
assert.doesNotMatch(JSON.stringify(releaseScore), /来場者が「プ譜で何を整理できるか」/);
assert.match(
  exhibitionScore.gainingGoal.text,
  /オープンソースカンファレンス2026＠大阪|出展レポート/,
);
assert.match(releaseScore.gainingGoal.text, /Release CLI onboarding|CLI/);

const storedScore: PufuScoreSemanticV1 = {
  elements: {
    businessScheme: '固定された座組',
    environment: '固定された環境',
    foreignEnemy: '固定された外敵',
    money: '固定されたお金',
    people: '固定されたひと',
    quality: '固定された品質',
    rival: '固定されたライバル',
    time: '固定された時間',
  },
  gainingGoal: '保存済みの獲得目標',
  purposes: [
    {
      measures: [{ color: 'green', text: '保存済み施策A' }],
      text: '保存済み中間目的',
    },
  ],
  schema_version: PUFU_SCORE_SCHEMA_VERSION,
  winCondition: '保存済み勝利条件',
};

const hydratedStored = createPufuScoreFromReport({
  ...exhibitionReport,
  pufu_score: storedScore,
});
assert.equal(hydratedStored.gainingGoal.text, '保存済みの獲得目標');
assert.equal(hydratedStored.winCondition.text, '保存済み勝利条件');
assert.equal(hydratedStored.purposes[0]?.text, '保存済み中間目的');
assert.equal(hydratedStored.purposes[0]?.measures[0]?.text, '保存済み施策A');

assert.throws(
  () =>
    validatePufuScoreSemantic({
      ...storedScore,
      gainingGoal: 'contact@example.com',
    }),
  /private text/,
);

assert.throws(
  () =>
    validatePufuScoreSemantic({
      ...storedScore,
      gainingGoal: '   ',
    }),
  /must be a non-empty string/,
);

assert.throws(
  () =>
    validatePufuScoreSemantic({
      ...storedScore,
      document_id: 'doc-hidden',
    }),
  /unknown key: document_id/,
);

assert.throws(
  () =>
    validatePufuScoreSemantic({
      ...storedScore,
      purposes: [
        {
          measures: [{ canonical_uri: 'https://internal.example', color: 'blue', text: 'measure' }],
          text: 'purpose',
        },
      ],
    }),
  /unknown key: canonical_uri/,
);

const contextual = buildContextualPufuScore({
  period: exhibitionReport.period,
  projectLabel: 'sample-a',
  sections: exhibitionReport.sections,
  sources: exhibitionReport.pufu_sources,
  summary: exhibitionReport.summary,
  title: exhibitionReport.title,
});
assert.equal(contextual.schema_version, PUFU_SCORE_SCHEMA_VERSION);
assert.ok(contextual.purposes.length >= 1);
assert.ok(contextual.purposes.every((purpose) => purpose.measures.length >= 1));

const titleBasedContextual = buildContextualPufuScore({
  period: exhibitionReport.period,
  sections: exhibitionReport.sections,
  sources: exhibitionReport.pufu_sources,
  summary: exhibitionReport.summary,
  title: 'sample-b プロジェクト状況レポート 2026-06-01 - 2026-06-07',
});
assert.match(JSON.stringify(titleBasedContextual), /sample-b/);

const sanitizedInput = toPufuScoreReportInput({
  generated_at: '2026-06-04T00:00:00.000Z',
  period: exhibitionReport.period,
  project_id: 'project-a',
  pufu_score: {
    ...storedScore,
    gainingGoal: 'safe goal with secret=hidden',
  },
  report_id: exhibitionReport.report_id,
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown: 'activity',
      title: '概況',
    },
    {
      id: 'progress',
      markdown: 'progress',
      title: '進行状況',
    },
    {
      id: 'risks',
      markdown: 'risks',
      title: '課題・次のアクション',
    },
  ],
  summary: exhibitionReport.summary,
  title: exhibitionReport.title,
});
assert.ok(sanitizedInput.pufu_score);
assert.doesNotMatch(JSON.stringify(sanitizedInput.pufu_score), /secret=hidden/);
