import type { PufuScorePublicSection, PufuScorePublicSource } from './pufu-score-input.ts';
import {
  normalizePufuScore,
  type PufuScoreMeasureColor,
  type PufuScoreSemanticV1,
} from './pufu-score-schema.ts';
import type { ReportPeriod } from './report-schema.ts';
import { normalizeReportWhitespace, truncateCodePoints } from './report-text.ts';

export interface ContextualPufuScoreInput {
  readonly period: ReportPeriod;
  readonly projectLabel?: string;
  readonly sections: readonly PufuScorePublicSection[];
  readonly sources?: readonly PufuScorePublicSource[];
  readonly summary: string;
  readonly title: string;
}

/**
 * Builds a contextual Pufu score from public-safe report and source evidence.
 */
export function buildContextualPufuScore(input: ContextualPufuScoreInput): PufuScoreSemanticV1 {
  const sources = resolveSources(input);
  const activity = sectionMarkdown(input.sections, 'activity');
  const progress = sectionMarkdown(input.sections, 'progress');
  const risks = sectionMarkdown(input.sections, 'risks');
  const progressBullets = markdownBullets(progress);
  const riskBullets = markdownBullets(risks);
  const projectLabel = contextualProjectLabel(input);
  const primarySource = sources[0];
  const sourceLabel = primarySource
    ? truncateLabel(primarySource.title || primarySource.snippet)
    : undefined;
  const gainingGoal = buildGainingGoal({
    activity,
    projectLabel,
    sourceLabel,
    summary: input.summary,
    title: input.title,
  });
  const winCondition = buildWinCondition({
    progressBullets,
    projectLabel,
    riskBullets,
    sourceLabel,
    summary: input.summary,
  });
  const purposes = buildPurposes({
    progressBullets,
    projectLabel,
    riskBullets,
    sourceLabel,
    sources,
  });
  const elements = buildElements({
    activity,
    period: input.period,
    progressBullets,
    projectLabel,
    riskBullets,
    sourceLabel,
    sources,
    summary: input.summary,
  });
  return normalizePufuScore({
    elements,
    gainingGoal,
    purposes,
    winCondition,
  });
}

function resolveSources(input: ContextualPufuScoreInput): readonly PufuScorePublicSource[] {
  if (input.sources && input.sources.length > 0) {
    return input.sources;
  }
  return dedupeSources(input.sections.flatMap(markdownSourceCandidates));
}

function markdownSourceCandidates(section: PufuScorePublicSection): PufuScorePublicSource[] {
  if (section.id !== 'activity') {
    return [];
  }
  const sources: PufuScorePublicSource[] = [];
  section.markdown.split('\n').forEach((line) => {
    const parsed = parseMarkdownSourceLine(line);
    if (!parsed) {
      return;
    }
    sources.push({
      doc_type: 'report_source',
      occurred_at: null,
      snippet: truncateLabel(parsed.snippet, 220),
      title: truncateLabel(parsed.title, 120),
    });
  });
  return sources;
}

function parseMarkdownSourceLine(line: string): { snippet: string; title: string } | undefined {
  const trimmedStart = line.trimStart();
  const marker = trimmedStart[0];
  if (marker !== '-' && marker !== '*') {
    return undefined;
  }
  const rest = trimmedStart.slice(1);
  const content = rest.trimStart();
  if (rest.length === content.length) {
    return undefined;
  }
  const separatorIndex = content.indexOf(': ');
  if (separatorIndex <= 0 || separatorIndex >= content.length - 2) {
    return undefined;
  }
  return {
    snippet: content.slice(separatorIndex + 2),
    title: content.slice(0, separatorIndex),
  };
}

function dedupeSources(sources: readonly PufuScorePublicSource[]): PufuScorePublicSource[] {
  const seen = new Set<string>();
  const deduped: PufuScorePublicSource[] = [];
  for (const source of sources) {
    const key = `${source.title}:${source.snippet}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(source);
    }
  }
  return deduped;
}

function contextualProjectLabel(input: ContextualPufuScoreInput): string {
  if (input.projectLabel) {
    return truncateLabel(input.projectLabel, 80);
  }
  const title = normalizeReportWhitespace(input.title);
  const withoutPeriod = title.replace(/プロジェクト状況レポート.*$/u, '').trim();
  return truncateLabel(withoutPeriod || title, 80);
}

function sectionMarkdown(
  sections: readonly PufuScorePublicSection[],
  id: PufuScorePublicSection['id'],
): string {
  return sections.find((section) => section.id === id)?.markdown ?? '';
}

function markdownBullets(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => normalizeReportWhitespace(line.replace(/^[-*]\s+/, '')))
    .filter(Boolean);
}

function buildGainingGoal(input: {
  readonly activity: string;
  readonly projectLabel: string;
  readonly sourceLabel?: string;
  readonly summary: string;
  readonly title: string;
}): string {
  if (input.sourceLabel) {
    return `${input.projectLabel} について、${input.sourceLabel} に記された状況を踏まえ、次の判断に進める状態をつくる。`;
  }
  const activityLead = firstSentence(input.activity);
  if (activityLead) {
    return `${input.projectLabel} について、${activityLead}`;
  }
  const summaryLead = firstSentence(input.summary);
  if (summaryLead) {
    return `${input.projectLabel} について、${summaryLead}`;
  }
  return `${input.projectLabel} のレポート「${truncateLabel(input.title, 100)}」に示された状況を整理し、次の判断に進める状態をつくる。`;
}

function buildWinCondition(input: {
  readonly progressBullets: readonly string[];
  readonly projectLabel: string;
  readonly riskBullets: readonly string[];
  readonly sourceLabel?: string;
  readonly summary: string;
}): string {
  if (input.riskBullets.length > 0) {
    const focus = truncateLabel(input.riskBullets[0] ?? '', 120);
    return `関係者が「${focus}」を含む課題と次の一手を説明でき、${input.projectLabel} の進め方に合意できる。`;
  }
  if (input.progressBullets.length > 0) {
    const focus = truncateLabel(input.progressBullets[0] ?? '', 120);
    return `関係者が「${focus}」の進捗と次に確認すべき点を説明でき、${input.projectLabel} の進め方に合意できる。`;
  }
  if (input.sourceLabel) {
    return `関係者が ${input.sourceLabel} から読み取れる状況と、${input.projectLabel} で次に試すことを説明できる。`;
  }
  return `${input.projectLabel} のレポート要約「${truncateLabel(input.summary, 120)}」に沿って、次に確認すべき判断材料を関係者間で共有できている。`;
}

function buildPurposes(input: {
  readonly progressBullets: readonly string[];
  readonly projectLabel: string;
  readonly riskBullets: readonly string[];
  readonly sourceLabel?: string;
  readonly sources: readonly PufuScorePublicSource[];
}): PufuScoreSemanticV1['purposes'] {
  const purposes: PufuScoreSemanticV1['purposes'][number][] = [];
  if (input.progressBullets.length > 0) {
    const focus = truncateLabel(input.progressBullets[0] ?? '', 100);
    purposes.push({
      measures: [
        measure(`「${focus}」を関係者が同じ言葉で説明できるよう整理する。`, 'green'),
        measure(
          input.sourceLabel
            ? `${input.sourceLabel} の記述とレポート進捗を突き合わせる。`
            : `${input.projectLabel} の進捗記述を根拠として関係者間で確認する。`,
          'blue',
        ),
      ],
      text: `「${focus}」が ${input.projectLabel} の現在地として共有されている`,
    });
  }
  if (input.riskBullets.length > 0) {
    const focus = truncateLabel(input.riskBullets[0] ?? '', 100);
    purposes.push({
      measures: [
        measure(`「${focus}」の前提と未確認点を分けて記録する。`, 'yellow'),
        measure(`${input.projectLabel} で次に試す具体行動を 1 件以上決める。`, 'red'),
      ],
      text: `「${focus}」について、次の一手が言語化されている`,
    });
  } else if (input.sources.length > 0) {
    const focus = truncateLabel(input.sources[0]?.title || input.sources[0]?.snippet || '', 100);
    purposes.push({
      measures: [
        measure(`「${focus}」から読み取れる事実と解釈を分けて整理する。`, 'blue'),
        measure(`${input.projectLabel} で追加確認が必要な論点を列挙する。`, 'yellow'),
      ],
      text: `参照資料から ${input.projectLabel} の状況が説明できる`,
    });
  }
  if (purposes.length === 0) {
    purposes.push({
      measures: [
        measure(
          `${input.projectLabel} のレポートに、判断に必要な状況説明が不足している点を明示する。`,
          'yellow',
        ),
        measure('不足している根拠を補うための確認項目を関係者で合意する。', 'green'),
      ],
      text: `${input.projectLabel} の現在地が関係者間で言語化されている`,
    });
  }
  return purposes.slice(0, 4);
}

function buildElements(input: {
  readonly activity: string;
  readonly period: ReportPeriod;
  readonly progressBullets: readonly string[];
  readonly projectLabel: string;
  readonly riskBullets: readonly string[];
  readonly sourceLabel?: string;
  readonly sources: readonly PufuScorePublicSource[];
  readonly summary: string;
}): PufuScoreSemanticV1['elements'] {
  const combined = [
    input.summary,
    input.activity,
    ...input.progressBullets,
    ...input.riskBullets,
    ...input.sources.map((source) => `${source.title} ${source.snippet}`),
  ].join('\n');
  return {
    businessScheme: input.sourceLabel
      ? `${input.sourceLabel} を含む情報を、${input.projectLabel} の大局観をそろえる材料として扱う。`
      : `${input.projectLabel} のレポート本文を、関係者が同じ大局観を持つための材料として扱う。`,
    environment: input.activity
      ? truncateLabel(firstSentence(input.activity) || input.activity, 300)
      : `${input.projectLabel} の周辺状況は、このレポートだけでは十分に記されていない。`,
    foreignEnemy: input.riskBullets[0]
      ? `「${truncateLabel(input.riskBullets[0], 120)}」が進行を妨げる可能性がある。`
      : combined.trim()
        ? `${input.projectLabel} の目的達成を阻む外部要因は、現時点のレポートでは明確に記されていない。`
        : `${input.projectLabel} のレポートには外部要因に関する根拠が不足している。`,
    money: /予算|コスト|工数|費用|投資/u.test(combined)
      ? 'レポートに言及された予算・工数・コストの制約を判断時に明示する。'
      : `${input.projectLabel} のレポートには、使える予算・工数・運用負荷に関する根拠が不足している。`,
    people: /来場者|利用者|関係者|メンバー|チーム/u.test(combined)
      ? 'レポートに現れる関係者の認識と期待をそろえることが重要。'
      : `${input.projectLabel} のレポートには、関係者の認識や期待に関する根拠が不足している。`,
    quality: input.progressBullets[0]
      ? `「${truncateLabel(input.progressBullets[0], 120)}」の事実と解釈を分けて扱う必要がある。`
      : `${input.projectLabel} のレポートでは、事実と解釈を分けて扱う必要がある。`,
    rival: input.riskBullets[1]
      ? `「${truncateLabel(input.riskBullets[1], 120)}」が優先順位や資源配分の論点になりうる。`
      : `${input.projectLabel} で成果や資源を取り合う論点は、レポート上は未整理の部分がある。`,
    time: `${input.period.start} から ${input.period.end} 時点の ${input.projectLabel} に関する認識。`,
  };
}

function measure(text: string, color: PufuScoreMeasureColor) {
  return { color, text: truncateLabel(text, 300) };
}

function firstSentence(text: string): string {
  const normalized = normalizeReportWhitespace(text);
  if (!normalized) {
    return '';
  }
  const match = normalized.match(/^[^。！？!?…]+[。！？!?…]?/u);
  return match?.[0]?.trim() ?? normalized;
}

function truncateLabel(value: string, maxCodePoints = 80): string {
  return truncateCodePoints(normalizeReportWhitespace(value), maxCodePoints);
}
