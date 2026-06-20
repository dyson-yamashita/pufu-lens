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
      const issueDocuments = documents.filter((document) => document.docType === 'issue');
      const risks = documents.filter((document) =>
        `${document.title} ${document.summary}`
          .toLowerCase()
          .match(/risk|block|fail|error|遅延|障害/),
      );
      const sources = sourceDocuments.map((document) => ({
        canonical_uri: document.canonicalUri,
        doc_type: document.docType,
        document_id: document.documentId,
        snippet: truncate(document.summary || document.title, 220),
      }));
      return {
        sections: [
          {
            id: 'activity',
            markdown: sourceDocuments.length
              ? [
                  `対象期間に確認できた情報は ${documents.length} 件です。直近の材料から見ると、プロジェクトは次の文脈で動いています。`,
                  '',
                  ...sourceDocuments.map(
                    (document) =>
                      `- ${document.title}: ${truncate(document.summary || '要約は未設定です。', 180)}`,
                  ),
                ].join('\n')
              : '対象期間の indexed document はありません。現時点では概況を判断する材料が不足しています。',
            sources,
            title: '概況',
          },
          {
            id: 'issues',
            items: issueDocuments.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: issueDocuments.length
              ? issueDocuments.map((document) => `- ${document.title}`).join('\n')
              : '現時点で大きな論点候補は抽出されていません。ただし、情報量が少ない場合は未検出の論点が残る可能性があります。',
            title: '論点',
          },
          {
            id: 'progress',
            markdown:
              documents.length > 0
                ? [
                    `${period.start} から ${period.end} の情報を見る限り、プロジェクトは情報収集と状況把握を継続できている状態です。`,
                    `確認できた document は ${documents.length} 件で、判断材料は蓄積されつつあります。`,
                    '今後は、個別タスクの消化数よりも、目指す状態に近づいているか、次の意思決定に十分な材料が揃っているかを確認する必要があります。',
                  ].join('\n')
                : `${period.start} から ${period.end} の期間には indexed document がなく、進行状況を判断できる材料がありません。`,
            metrics: {
              documents: documents.length,
              discussion_points: issueDocuments.length,
              risk_signals: risks.length,
            },
            title: '進行状況',
          },
          {
            id: 'risks',
            items: risks.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: risks.length
              ? risks.map((document) => `- ${document.title}`).join('\n')
              : '重大なリスク候補は抽出されていません。とはいえ、情報が少ない場合は不確実性そのものがリスクになります。',
            title: '不確実性・リスク',
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
                    'Sections must include exactly these ids:',
                    '- activity: title "概況"; summarize what kind of project state the documents indicate.',
                    '- progress: title "進行状況"; explain how the project appears to be moving or not moving.',
                    '- issues: title "論点"; summarize open questions, tensions, or decisions to clarify.',
                    '- risks: title "不確実性・リスク"; summarize blockers, risk signals, and unknowns.',
                    'Use markdown prose and concise bullets. metrics are optional and should support situation understanding, not task management.',
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
      };
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
