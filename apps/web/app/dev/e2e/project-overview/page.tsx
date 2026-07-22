import { notFound } from 'next/navigation';
import type { ProjectOverviewSnapshot } from '../../../../src/project-overview-data.ts';
import { ProjectOverviewSection } from '../../../../src/project-overview-section.tsx';
import { PROJECT_OVERVIEW_SCHEMA_VERSION } from '../../../../src/report-project-overview.ts';
import { isFixtureFallbackEnabled } from '../../../../src/runtime-guards.ts';

const snapshot: ProjectOverviewSnapshot = {
  generatedAt: '2026-07-22T03:30:00.000Z',
  overview: {
    assets: [
      {
        description: '定期レポートとプ譜を組み合わせ、判断材料を同じ画面で確認できます。',
        title: '状況把握の基盤',
      },
      {
        description: 'プロジェクトの履歴と知見が継続的に蓄積されています。',
        title: '活動データの蓄積',
      },
    ],
    issues: [
      {
        description: '公開範囲ごとの表示内容を運用で継続確認する必要があります。',
        next_action: '公開プロジェクトと非公開プロジェクトの定期確認を行う。',
        title: '公開範囲の運用確認',
      },
      {
        description: '定期レポートが未生成の期間は概要を表示できません。',
        next_action: '初回レポート生成の案内と生成状況を確認する。',
        title: '初回生成までの空白',
      },
    ],
    schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
    status_summary:
      '定期レポートを基に、プロジェクトの現状、蓄積されたアセット、次に扱う課題を確認できる状態です。',
  },
  period: { end: '2026-07-19', start: '2026-07-13' },
  pufuInput: {
    period: { end: '2026-07-19', start: '2026-07-13' },
    pufu_sources: [
      {
        doc_type: 'issue',
        occurred_at: '2026-07-17T01:00:00.000Z',
        snippet: 'プロジェクト Overview に定期レポート由来の状況を掲載する。',
        title: 'Project overview reporting',
      },
    ],
    report_id: 'project-overview-sample-a-2026-07-13-2026-07-19',
    sections: [
      {
        id: 'activity',
        markdown: '定期レポートによるプロジェクト状況の可視化を進めています。',
        title: '概況',
      },
      {
        id: 'progress',
        markdown: 'Overview に状況、アセット、課題、プ譜をまとめました。',
        title: '進行状況',
      },
      {
        id: 'risks',
        markdown: '公開範囲と初回生成までの表示を継続して確認します。',
        title: '課題・次のアクション',
      },
    ],
    summary: 'プロジェクト状況を定期レポートから整理しました。',
    title: 'プロジェクト状況レポート 2026-07-13 - 2026-07-19',
  },
  reportHref: '/projects/sample-a/reports/report-scheduled',
  showReportLink: true,
};

/**
 * Renders a stable project overview fixture for browser E2E and visual verification.
 *
 * Returns 404 outside non-production fixture-fallback environments.
 */
export default function ProjectOverviewE2eHarnessPage() {
  if (!isFixtureFallbackEnabled() || process.env.PUFU_LENS_ENABLE_FIXTURE_FALLBACK !== 'true') {
    notFound();
  }

  return (
    <main className="page-shell" data-testid="project-overview-e2e-harness">
      <ProjectOverviewSection snapshot={snapshot} />
    </main>
  );
}
