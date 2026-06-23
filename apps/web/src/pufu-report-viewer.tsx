'use client';

import dynamic from 'next/dynamic';
import type { ComponentType, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  readonly dark?: boolean;
  readonly lang?: 'ja' | 'en';
  readonly mobile?: boolean;
  readonly preview?: boolean;
  readonly showProgress?: boolean;
  readonly textSize?: 'small' | 'base' | 'large';
  readonly uniqueKey?: string;
  readonly width?: number;
};

export function PufuReportViewer({ report }: { readonly report: PrivateReportJsonV1 }) {
  const score = useMemo(() => createPufuScoreFromReport(report), [report]);
  const scoreFrameRef = useRef<HTMLDivElement>(null);
  const scoreWidth = useElementWidth(scoreFrameRef);
  const isDarkTheme = useIsDarkTheme();
  const isMobileScore = scoreWidth !== null && scoreWidth < 760;
  return (
    <section className="pufu-report-panel" data-testid="pufu-report-viewer">
      <div className="panel-heading">
        <div>
          <h2>プ譜</h2>
          <p className="mono">pufu-editor ProjectScore preview</p>
        </div>
      </div>
      <div className="pufu-score-frame">
        <div className="pufu-score-canvas" data-testid="pufu-report-score" ref={scoreFrameRef}>
          {scoreWidth === null ? (
            <p className="notice">loading</p>
          ) : (
            <ProjectScore
              dark={isDarkTheme}
              initScore={score}
              lang="ja"
              mobile={isMobileScore}
              preview
              textSize="small"
              uniqueKey={`report-pufu-${report.report_id}`}
              width={scoreWidth}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(Math.max(1, Math.floor(entry.contentRect.width)));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDark(root.dataset.theme === 'dark');
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributeFilter: ['data-theme'], attributes: true });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
