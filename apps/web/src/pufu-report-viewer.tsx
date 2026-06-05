'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { useMemo } from 'react';
import { createPufuScoreFromReport, type PufuScoreModel } from './pufu-score';
import type { PrivateReportJsonV1 } from './report';

const ProjectScore = dynamic(
  () =>
    import('../node_modules/@goto-lab/pufu-editor/dist/components/ProjectScore.js').then(
      (module) => module.ProjectScore as ComponentType<ProjectScoreProps>,
    ),
  {
    loading: () => <p className="notice">loading</p>,
    ssr: false,
  },
);

type ProjectScoreProps = {
  readonly initScore?: PufuScoreModel;
  readonly lang?: 'ja' | 'en';
  readonly preview?: boolean;
  readonly showProgress?: boolean;
  readonly textSize?: 'small' | 'base' | 'large';
  readonly uniqueKey?: string;
  readonly width?: number;
};

export function PufuReportViewer({ report }: { readonly report: PrivateReportJsonV1 }) {
  const score = useMemo(() => createPufuScoreFromReport(report), [report]);
  return (
    <section className="pufu-report-panel" data-testid="pufu-report-viewer">
      <div className="panel-heading">
        <div>
          <h2>プ譜</h2>
          <p className="mono">pufu-editor ProjectScore preview</p>
        </div>
      </div>
      <div className="pufu-score-frame">
        <div className="pufu-score-canvas" data-testid="pufu-report-score">
          <ProjectScore
            initScore={score}
            lang="ja"
            preview
            textSize="small"
            uniqueKey={`report-pufu-${report.report_id}`}
            width={1120}
          />
        </div>
      </div>
    </section>
  );
}
