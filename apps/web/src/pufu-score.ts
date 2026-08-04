import { buildContextualPufuScore } from './pufu-score-generation.ts';
import type { PufuScoreReportInput } from './pufu-score-input.ts';
import {
  normalizePufuScore,
  type PufuScoreMeasureColor,
  type PufuScoreSemanticV1,
} from './pufu-score-schema.ts';

export type { PufuScoreReportInput } from './pufu-score-input.ts';

const emptyComment = { color: 'blue' as const, text: '' };

function generateUUID(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure random UUID generation is unavailable.');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type PufuScoreModel = {
  elements: {
    businessScheme: PufuBaseModel;
    environment: PufuBaseModel;
    foreignEnemy: PufuBaseModel;
    money: PufuBaseModel;
    people: PufuBaseModel;
    quality: PufuBaseModel;
    rival: PufuBaseModel;
    time: PufuBaseModel;
  };
  gainingGoal: PufuBaseModel;
  purposes: PufuPurposeModel[];
  winCondition: PufuBaseModel;
};

type PufuBaseModel = {
  comment: typeof emptyComment;
  text: string;
  uuid: string;
};

type PufuMeasureModel = PufuBaseModel & {
  color: PufuScoreMeasureColor;
  progress?: number;
};

type PufuPurposeModel = PufuBaseModel & {
  measures: PufuMeasureModel[];
};

/**
 * Hydrates a client-safe report input into a pufu-editor ProjectScore model.
 */
export function createPufuScoreFromReport(report: PufuScoreReportInput): PufuScoreModel {
  const semantic = resolvePufuScoreSemantic(report);
  return hydratePufuScore(semantic);
}

function resolvePufuScoreSemantic(report: PufuScoreReportInput): PufuScoreSemanticV1 {
  if (report.pufu_score) {
    return normalizePufuScore(report.pufu_score);
  }
  return buildContextualPufuScore({
    period: report.period,
    sections: report.sections,
    sources: report.pufu_sources,
    summary: report.summary,
    title: report.title,
  });
}

function hydratePufuScore(score: PufuScoreSemanticV1): PufuScoreModel {
  return {
    elements: {
      businessScheme: element(score.elements.businessScheme),
      environment: element(score.elements.environment),
      foreignEnemy: element(score.elements.foreignEnemy),
      money: element(score.elements.money),
      people: element(score.elements.people),
      quality: element(score.elements.quality),
      rival: element(score.elements.rival),
      time: element(score.elements.time),
    },
    gainingGoal: objective(score.gainingGoal),
    purposes: score.purposes.map((purpose) =>
      purposeNode(
        purpose.text,
        purpose.measures.map((item) => measure(item.text, item.color)),
      ),
    ),
    winCondition: objective(score.winCondition),
  };
}

function objective(text: string) {
  return { comment: emptyComment, text, uuid: generateUUID() };
}

function purposeNode(text: string, measures: PufuMeasureModel[]) {
  return { comment: emptyComment, measures, text, uuid: generateUUID() };
}

function measure(text: string, color: PufuMeasureModel['color']) {
  return {
    color,
    comment: emptyComment,
    text,
    uuid: generateUUID(),
  };
}

function element(text: string) {
  return { comment: emptyComment, text, uuid: generateUUID() };
}
