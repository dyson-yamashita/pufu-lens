import type { ReportDocumentRecord } from './report-repository.ts';
import { normalizeReportWhitespace, truncateReportText } from './report-text.ts';

export const REPORT_CANDIDATE_LIMIT = 200;
export const REPORT_MATERIAL_GROUP_LIMIT = 40;
export const REPORT_REPRESENTATIVE_LIMIT = 30;

export type ReportEditorialRole = 'context' | 'decision' | 'progress' | 'risk';

export interface ReportMaterialGroup {
  readonly documentCount: number;
  readonly documentIds: readonly string[];
  readonly markdown: string;
  readonly role: ReportEditorialRole;
  readonly title: string;
}

export interface EditedReportMaterials {
  readonly materialGroups: readonly ReportMaterialGroup[];
  readonly representativeDocuments: readonly ReportDocumentRecord[];
  readonly totalDocumentCount: number;
}

const ROLE_ORDER: readonly ReportEditorialRole[] = ['decision', 'risk', 'progress', 'context'];

const ROLE_TITLES: Readonly<Record<ReportEditorialRole, string>> = {
  context: '背景・文脈',
  decision: '判断・決定',
  progress: '進捗・成果',
  risk: '課題・リスク',
};

const ROLE_PATTERNS: Readonly<Record<Exclude<ReportEditorialRole, 'context'>, RegExp>> = {
  decision: /\b(?:approv(?:e|ed|al)|decid(?:e|ed)|select(?:ed|ion))\b|決定|合意|採用|選定|方針/iu,
  progress:
    /\b(?:complete(?:d)?|deliver(?:ed)?|implement(?:ed)?|launch(?:ed)?|merge(?:d)?|progress|release(?:d)?)\b|完了|実装|改善|進捗|公開|更新|リリース/iu,
  risk: /\b(?:block(?:ed|er)?|delay(?:ed)?|error|fail(?:ed|ure)?|risk)\b|課題|懸念|障害|遅延|失敗/iu,
};

/**
 * Edits report candidates into bounded representative evidence and thematic material groups.
 */
export function editReportMaterials(
  documents: readonly ReportDocumentRecord[],
): EditedReportMaterials {
  const classified = documents.map((document) => ({
    document,
    role: editorialRole(document),
  }));
  const materialGroups = ROLE_ORDER.map((role) => {
    const groupDocuments = classified
      .filter((candidate) => candidate.role === role)
      .map((candidate) => candidate.document);
    return groupDocuments.length > 0 ? materialGroup(role, groupDocuments) : undefined;
  }).filter((group): group is ReportMaterialGroup => group !== undefined);

  return {
    materialGroups,
    representativeDocuments: selectRepresentativeDocuments(classified),
    totalDocumentCount: documents.length,
  };
}

function editorialRole(document: ReportDocumentRecord): ReportEditorialRole {
  const text = `${normalizeReportWhitespace(document.title)}\n${normalizeReportWhitespace(
    document.summary,
  )}`;
  for (const role of ROLE_ORDER) {
    if (role !== 'context' && ROLE_PATTERNS[role].test(text)) {
      return role;
    }
  }
  return 'context';
}

function materialGroup(
  role: ReportEditorialRole,
  documents: readonly ReportDocumentRecord[],
): ReportMaterialGroup {
  const boundedDocuments = documents.slice(0, REPORT_MATERIAL_GROUP_LIMIT);
  return {
    documentCount: boundedDocuments.length,
    documentIds: boundedDocuments.map((document) => document.documentId),
    markdown: boundedDocuments.map(materialLine).join('\n'),
    role,
    title: ROLE_TITLES[role],
  };
}

function materialLine(document: ReportDocumentRecord): string {
  const occurredAt = document.occurredAt ? `, ${document.occurredAt}` : '';
  const title = truncateReportText(normalizeReportWhitespace(document.title), 120);
  const summary = truncateReportText(normalizeReportWhitespace(document.summary) || title, 220);
  return `- [${document.documentId}] (${document.docType}${occurredAt}) ${title}: ${summary}`;
}

function selectRepresentativeDocuments(
  classified: readonly {
    readonly document: ReportDocumentRecord;
    readonly role: ReportEditorialRole;
  }[],
): readonly ReportDocumentRecord[] {
  if (classified.length <= REPORT_REPRESENTATIVE_LIMIT) {
    return classified.map((candidate) => candidate.document);
  }

  const selectedIds = new Set<string>();
  const select = (document: ReportDocumentRecord | undefined): void => {
    if (document && selectedIds.size < REPORT_REPRESENTATIVE_LIMIT) {
      selectedIds.add(document.documentId);
    }
  };

  for (const role of ROLE_ORDER) {
    select(classified.find((candidate) => candidate.role === role)?.document);
  }

  select(
    [...classified].reverse().find((candidate) => candidate.document.occurredAt !== null)?.document,
  );

  const seenDocTypes = new Set<string>();
  for (const { document } of classified) {
    if (!seenDocTypes.has(document.docType)) {
      seenDocTypes.add(document.docType);
      select(document);
    }
  }

  const roleBuckets = ROLE_ORDER.map((role) =>
    classified
      .filter((candidate) => candidate.role === role)
      .map((candidate) => candidate.document),
  );
  const maxBucketLength = Math.max(...roleBuckets.map((bucket) => bucket.length));
  for (let index = 0; index < maxBucketLength; index += 1) {
    for (const bucket of roleBuckets) {
      select(bucket[index]);
    }
  }

  return classified
    .map((candidate) => candidate.document)
    .filter((document) => selectedIds.has(document.documentId));
}
