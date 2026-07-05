import type { ChatSource, PublicChatSource } from './chat.ts';
import type { PrivateReportJsonV1 } from './report.ts';

export function publicChatSourcesFromReport(
  chatSources: readonly ChatSource[],
  report: PrivateReportJsonV1,
): PublicChatSource[] {
  const references = new Map<string, PublicChatSource>();
  for (const section of report.sections) {
    section.sources?.forEach((source, index) => {
      if (!references.has(source.document_id)) {
        references.set(source.document_id, {
          label: source.title?.trim() || source.doc_type,
          publicSourceId: `src_${section.id}_${index + 1}`,
          sectionId: section.id,
        });
      }
    });
  }
  report.pufu_sources?.forEach((source, index) => {
    if (!references.has(source.document_id)) {
      references.set(source.document_id, {
        label: source.title,
        publicSourceId: `src_pufu_${index + 1}`,
        sectionId: 'pufu_sources',
      });
    }
  });

  const result: PublicChatSource[] = [];
  const seen = new Set<string>();
  for (const source of chatSources) {
    const publicSource = references.get(source.documentId);
    if (publicSource && !seen.has(publicSource.publicSourceId)) {
      result.push(publicSource);
      seen.add(publicSource.publicSourceId);
    }
  }
  return result;
}

export function isPublicWebChatSource(source: ChatSource): boolean {
  return source.docType === 'web' || source.docType === 'web_page';
}
