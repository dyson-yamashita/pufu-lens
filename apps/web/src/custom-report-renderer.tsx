import type {
  ClassificationResult,
  CustomReportPart,
  CustomReportSnapshotV1,
  SliderJudgementResult,
} from './custom-report-schema';
import { MarkdownContent } from './markdown-content';
import { PufuReportViewer } from './pufu-report-viewer';
import { toPufuScoreReportInput } from './pufu-score-input';
import type { PrivateReportJsonV1, PrivateReportSection } from './report';

export function CustomReportLayoutRenderer({
  report,
  snapshot,
}: {
  readonly report: PrivateReportJsonV1;
  readonly snapshot: CustomReportSnapshotV1;
}) {
  return (
    <section className="custom-report-layout" data-testid="custom-report-layout">
      <div className="custom-report-layout-meta">
        <span>Template v{snapshot.template_version}</span>
        <span className="mono">{snapshot.template_snapshot_hash}</span>
      </div>
      <CustomReportPartRenderer part={snapshot.layout.root} report={report} snapshot={snapshot} />
    </section>
  );
}

function CustomReportPartRenderer({
  part,
  report,
  snapshot,
}: {
  readonly part: CustomReportPart;
  readonly report: PrivateReportJsonV1;
  readonly snapshot: CustomReportSnapshotV1;
}) {
  switch (part.type) {
    case 'title': {
      const Heading = part.level === 1 ? 'h2' : part.level === 3 ? 'h4' : 'h3';
      return (
        <Heading className="custom-report-title" data-testid={`custom-report-part-${part.id}`}>
          {part.text}
        </Heading>
      );
    }
    case 'pufu_board':
      return (
        <div data-testid={`custom-report-part-${part.id}`}>
          <PufuReportViewer report={toPufuScoreReportInput(report)} />
        </div>
      );
    case 'slider_judgement': {
      const result = snapshot.results[part.result_key];
      if (result?.type !== 'slider_judgement') {
        return <MissingCustomReportResult partId={part.id} resultKey={part.result_key} />;
      }
      return <SliderJudgementView partId={part.id} result={result} />;
    }
    case 'classification_result': {
      const result = snapshot.results[part.result_key];
      if (result?.type !== 'classification_result') {
        return <MissingCustomReportResult partId={part.id} resultKey={part.result_key} />;
      }
      return <ClassificationResultView partId={part.id} result={result} />;
    }
    case 'fixed_text': {
      const result = snapshot.results[part.id];
      const text = result?.type === 'fixed_text' ? result.text : part.text;
      return (
        <p
          className="custom-report-fixed-text markdown-text"
          data-testid={`custom-report-part-${part.id}`}
        >
          {text}
        </p>
      );
    }
    case 'fixed_image': {
      const result = snapshot.results[part.id];
      const assetRef = result?.type === 'fixed_image' ? result.asset_ref : part.asset_ref;
      return (
        <FixedImageView
          altText={part.alt_text}
          assetRef={assetRef}
          caption={part.caption}
          partId={part.id}
        />
      );
    }
    case 'columns':
      return (
        <div className="custom-report-columns" data-testid={`custom-report-part-${part.id}`}>
          {part.columns.map((column) => (
            <div
              className="custom-report-column"
              key={`${part.id}-column-${column.children[0]?.id ?? 'empty'}`}
              style={{ flex: column.width_fraction ? `${column.width_fraction} 1 0` : undefined }}
            >
              {column.children.map((child) => (
                <CustomReportPartRenderer
                  key={child.id}
                  part={child}
                  report={report}
                  snapshot={snapshot}
                />
              ))}
            </div>
          ))}
        </div>
      );
    case 'row':
      return (
        <div className="custom-report-row" data-testid={`custom-report-part-${part.id}`}>
          {part.children.map((child) => (
            <CustomReportPartRenderer
              key={child.id}
              part={child}
              report={report}
              snapshot={snapshot}
            />
          ))}
        </div>
      );
    case 'divider':
      return <hr className="custom-report-divider" data-testid={`custom-report-part-${part.id}`} />;
    case 'copyright':
      return (
        <p className="custom-report-copyright" data-testid={`custom-report-part-${part.id}`}>
          {part.text}
        </p>
      );
    default: {
      const _exhaustiveCheck: never = part;
      return null;
    }
  }
}

function SliderJudgementView({
  partId,
  result,
}: {
  readonly partId: string;
  readonly result: SliderJudgementResult;
}) {
  const score = Math.max(0, Math.min(100, result.score));
  return (
    <article className="custom-report-card" data-testid={`custom-report-part-${partId}`}>
      <div className="custom-report-slider-heading">
        <span>{result.left_label}</span>
        <strong>{score}</strong>
        <span>{result.right_label}</span>
      </div>
      <meter
        className="custom-report-slider-track"
        aria-label="Judgement score"
        min={0}
        max={100}
        value={score}
      >
        {score}
      </meter>
      <p className="markdown-text">{result.reason}</p>
    </article>
  );
}

function ClassificationResultView({
  partId,
  result,
}: {
  readonly partId: string;
  readonly result: ClassificationResult;
}) {
  return (
    <article className="custom-report-card" data-testid={`custom-report-part-${partId}`}>
      <p className="eyebrow">{result.category_key}</p>
      <h3>{result.title}</h3>
      {result.asset_ref ? (
        <FixedImagePlaceholder assetRef={result.asset_ref} label={result.title} />
      ) : null}
      <p>{result.description}</p>
      <p className="markdown-text muted-copy">{result.reason}</p>
    </article>
  );
}

function FixedImageView({
  altText,
  assetRef,
  caption,
  partId,
}: {
  readonly altText?: string;
  readonly assetRef: string;
  readonly caption?: string;
  readonly partId: string;
}) {
  const trimmedAltText = altText?.trim();
  const trimmedCaption = caption?.trim();
  const placeholderLabel =
    trimmedAltText && trimmedAltText.length > 0
      ? trimmedAltText
      : trimmedCaption && trimmedCaption.length > 0
        ? trimmedCaption
        : 'Image';

  return (
    <figure className="custom-report-image" data-testid={`custom-report-part-${partId}`}>
      <FixedImagePlaceholder assetRef={assetRef} label={placeholderLabel} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function FixedImagePlaceholder({
  assetRef,
  label,
}: {
  readonly assetRef: string;
  readonly label: string;
}) {
  return (
    <div className="custom-report-image-placeholder" role="img" aria-label={label}>
      <span>Image asset</span>
      <code>{assetRef}</code>
    </div>
  );
}

function MissingCustomReportResult({
  partId,
  resultKey,
}: {
  readonly partId: string;
  readonly resultKey: string;
}) {
  return (
    <p className="notice error" data-testid={`custom-report-part-${partId}`}>
      custom report result is missing: {resultKey}
    </p>
  );
}

export function StandardReportSections({
  publicView = false,
  report,
}: {
  readonly publicView?: boolean;
  readonly report: PrivateReportJsonV1;
}) {
  return (
    <>
      <PufuReportViewer report={toPufuScoreReportInput(report)} />
      {report.sections.map((section) => (
        <StandardReportSection key={section.id} publicView={publicView} section={section} />
      ))}
    </>
  );
}

function StandardReportSection({
  publicView,
  section,
}: {
  readonly publicView: boolean;
  readonly section: PrivateReportSection;
}) {
  return (
    <section
      className="report-section"
      data-testid={`${publicView ? 'public-' : ''}report-section-${section.id}`}
    >
      <h3>{section.title}</h3>
      <MarkdownContent className="report-markdown" text={section.markdown} />
      {section.metrics && Object.keys(section.metrics).length > 0 ? (
        <div className="metric-strip compact">
          {Object.entries(section.metrics).map(([name, value]) => (
            <div className="metric" key={name}>
              <span>{name}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {section.sources?.length ? (
        <details
          className="report-section-sources"
          data-testid={`${publicView ? 'public-' : ''}report-section-sources-${section.id}`}
        >
          <summary
            data-testid={`${publicView ? 'public-' : ''}report-section-sources-toggle-${section.id}`}
          >
            Sources ({section.sources.length})
          </summary>
          <div className="source-list">
            {section.sources.map((source) => (
              <article
                className="source-chip"
                data-testid={`${publicView ? 'public-' : ''}report-source-${source.document_id}`}
                key={source.document_id}
              >
                <strong>{normalizePrivateReportSourceLabel(source.doc_type)}</strong>
                {isPublicHttpUrl(source.canonical_uri) ? (
                  <a
                    href={source.canonical_uri}
                    rel="noreferrer"
                    target="_blank"
                    title={source.canonical_uri}
                  >
                    {privateReportSourceTitle(source)}
                  </a>
                ) : (
                  <>
                    <span>{privateReportSourceTitle(source)}</span>
                    <small>
                      {publicView ? source.document_id : source.canonical_uri || source.document_id}
                    </small>
                  </>
                )}
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function normalizePrivateReportSourceLabel(docType: string): string {
  if (docType === 'web_page') {
    return 'web';
  }
  return docType.replace(/_/g, ' ');
}

function privateReportSourceTitle(source: {
  readonly canonical_uri?: string | null;
  readonly document_id: string;
  readonly title?: string;
}): string {
  if (source.title?.trim()) {
    return source.title.trim();
  }
  if (isPublicHttpUrl(source.canonical_uri)) {
    try {
      return new URL(source.canonical_uri).hostname;
    } catch {
      return source.document_id;
    }
  }
  return source.document_id;
}

function isPublicHttpUrl(uri?: string | null): uri is string {
  return typeof uri === 'string' && /^https?:\/\//i.test(uri);
}
