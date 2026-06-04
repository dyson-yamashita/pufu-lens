import { PublicReportDocument } from '../../../../../src/report-client';

export default async function PublicReportPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }>;
}) {
  const { projectSlug, reportId } = await params;
  return (
    <main className="public-shell">
      <section className="page-header compact">
        <p className="eyebrow">PUBLIC REPORT</p>
        <h1>公開レポート</h1>
      </section>
      <PublicReportDocument projectSlug={projectSlug} reportId={reportId} />
    </main>
  );
}
