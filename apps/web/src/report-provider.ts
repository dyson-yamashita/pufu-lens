import type { ReportDocumentRecord } from './report-repository.ts';
import {
  type PrivateReportJsonV1,
  type ReportPeriod,
  validateGeneratedReport,
} from './report-schema.ts';

export interface ReportGenerationProvider {
  generate(input: {
    readonly documents: readonly ReportDocumentRecord[];
    readonly period: ReportPeriod;
    readonly projectSlug: string;
  }): Promise<Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>>;
}

export function createExtractiveReportProvider(): ReportGenerationProvider {
  return {
    async generate({ documents, period }) {
      const sourceDocuments = documents.slice(0, 8);
      const risks = documents.filter((document) =>
        `${document.title} ${document.summary}`
          .toLowerCase()
          .match(/risk|block|fail|error|遅延|障害/),
      );
      const progressSources = sourceDocuments.map((document) => sourceFromDocument(document));

      return {
        sections: [
          {
            id: 'activity',
            markdown: buildActivityMarkdown(documents, period, sourceDocuments),
            title: '概況',
          },
          {
            id: 'progress',
            markdown: buildProgressMarkdown(period, sourceDocuments),
            sources: progressSources,
            title: '進行状況',
          },
          {
            id: 'risks',
            items: risks.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: buildRisksMarkdown(risks),
            title: '課題・次のアクション',
          },
        ],
        summary:
          documents.length > 0
            ? `${documents.length} 件の indexed document から、プロジェクトの概況と進行状況を整理しました。`
            : '対象期間の indexed document がないため、プロジェクト概況は未判定です。',
        title: `プロジェクト状況レポート ${period.start} - ${period.end}`,
      };
    },
  };
}

export function createGeminiReportProvider(input: {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly model: string;
}): ReportGenerationProvider {
  if (!input.apiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini report generation.');
  }
  if (!input.model) {
    throw new Error('GEMINI_CHAT_MODEL is required for Gemini report generation.');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint =
    input.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`;
  return {
    async generate({ documents, period, projectSlug }) {
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(input.apiKey)}`, {
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    'Return only JSON for Pufu Lens private report schema v1 fields: title, summary, sections.',
                    'This report is for understanding the project situation, not checking task completion.',
                    'Summarize the overall context, current movement, decisions implied by the information, uncertainty, and signals that matter.',
                    'Do not make the report primarily about GitHub issues, PR counts, task lists, or TODO tracking.',
                    'Sections must include exactly these ids and no others:',
                    '- activity: title "概況"; a few short prose lines describing what kind of activities occurred. Do not include source lists, references, or bullet lists of documents.',
                    '- progress: title "進行状況"; bullet-list the work/activity contents only. Do not include metrics objects or document/discussion counts. Put references in sources with title when available.',
                    '- risks: title "課題・次のアクション"; bullet-list blockers, risks, and concrete next actions. If none are evident, suggest next actions for gathering clarity.',
                    'Do not generate an issues section.',
                    'Use markdown prose and concise bullets. Do not include metrics objects.',
                    `Project: ${projectSlug}`,
                    `Period: ${period.start} to ${period.end}`,
                    `Documents: ${JSON.stringify(documents)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`Gemini report request failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      } | null;
      if (!body || typeof body !== 'object') {
        throw new Error('Gemini report response is not a valid JSON object.');
      }
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
      if (!text) {
        throw new Error('Gemini report response did not include JSON text.');
      }
      let generated: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>;
      try {
        generated = JSON.parse(text) as Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to parse Gemini report response as JSON: ${reason}. Raw text prefix: ${text.slice(
            0,
            500,
          )}`,
        );
      }
      validateGeneratedReport(generated);
      return generated;
    },
  };
}

function buildActivityMarkdown(
  documents: readonly ReportDocumentRecord[],
  period: ReportPeriod,
  sourceDocuments: readonly ReportDocumentRecord[],
): string {
  if (sourceDocuments.length === 0) {
    return '対象期間の indexed document はありません。現時点では概況を判断する材料が不足しています。';
  }
  const activitySummary = summarizeDocumentTypes(sourceDocuments);
  return [
    `${period.start} から ${period.end} の期間に、プロジェクトに関する ${documents.length} 件の情報が確認できました。`,
    activitySummary,
    '全体として、関係者間の更新や議論が継続している状態と読み取れます。',
  ].join('\n');
}

function buildProgressMarkdown(
  period: ReportPeriod,
  sourceDocuments: readonly ReportDocumentRecord[],
): string {
  if (sourceDocuments.length === 0) {
    return `- ${period.start} から ${period.end} の期間には indexed document がなく、進行状況を判断できる材料がありません。`;
  }
  return sourceDocuments.map((document) => `- ${document.title}`).join('\n');
}

function buildRisksMarkdown(risks: readonly ReportDocumentRecord[]): string {
  if (risks.length === 0) {
    return '- 次の期間に向けて、判断材料の収集と関係者とのすり合わせを進めてください。';
  }
  return risks
    .map(
      (document) =>
        `- ${document.title}: ${truncate(document.summary || '要約は未設定です。', 120)}`,
    )
    .join('\n');
}

function summarizeDocumentTypes(documents: readonly ReportDocumentRecord[]): string {
  const labels = [...new Set(documents.map((document) => documentTypeLabel(document.docType)))];
  if (labels.length === 0) {
    return '確認できた情報から、プロジェクトに関する更新や議論が継続している状態です。';
  }
  if (labels.length === 1) {
    return `主な活動は ${labels[0]} に関する更新や議論の記録です。`;
  }
  return `主な活動は ${labels.slice(0, -1).join('、')} および ${labels.at(-1)} に関する更新や議論の記録です。`;
}

function documentTypeLabel(docType: string): string {
  if (docType === 'web_page') {
    return 'Web ページ';
  }
  if (docType === 'pull_request') {
    return 'プルリクエスト';
  }
  if (docType === 'issue') {
    return 'Issue';
  }
  return docType.replace(/_/g, ' ');
}

function sourceFromDocument(document: ReportDocumentRecord) {
  return {
    canonical_uri: document.canonicalUri,
    doc_type: document.docType,
    document_id: document.documentId,
    snippet: truncate(document.summary || document.title, 220),
    title: document.title,
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
