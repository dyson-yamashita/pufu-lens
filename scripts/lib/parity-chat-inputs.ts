import { createHash } from 'node:crypto';
import { collectGraphCoverageEvidenceQueries } from '../../apps/web/src/private-chat-graph-coverage.ts';
import { runPrivateChatPreparingStep } from '../../apps/web/src/private-chat-search.ts';
import { chatControlledScenarios } from './parity-chat-controls.ts';
import { parityFixture } from './parity-fixture.ts';

export type ParityChatPhase = 'primary' | 'retry' | 'coverage';
export const parityChatPlanVersion = 'chat-fixed-preparing-v1';
/** Hashes the exact UTF-8 generation input without normalization. */
export const parityChatTextHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Maps fixture input fields only; failure inputs remain available to the separate fault collector. */
export function parityChatInputs() {
  return parityFixture.cases
    .filter((test) => test.kind === 'chat')
    .map((test) => ({
      id: test.id,
      projectId: test.projectId,
      question: test.query,
    }));
}

/** Pins non-LLM preparation. V1 uses the default limit; independent synthetic plans may set it. */
export function prepareParityChat(input: {
  projectId: string;
  question: string;
  hybridSearchDocumentLimit?: number;
}) {
  return runPrivateChatPreparingStep({
    ...input,
    graphName: null,
    nowIso: '2026-09-26T00:00:00Z',
  });
}

/** Enumerates every possible query for the fixed plan, including conditional retry/coverage.
 * Text is generation input only, never report evidence. No candidate ranking or judgment is read.
 */
export function parityChatEmbeddingInputs() {
  return [
    ...parityChatInputs().filter((input) => !input.id.startsWith('failure-')),
    ...chatControlledScenarios,
  ].flatMap((input) => {
    const { plan } = prepareParityChat(input);
    if (plan.expandedQueries.length) throw new Error('Unsupported parity Chat expanded plan');
    const phases: [ParityChatPhase, readonly string[]][] = [
      ['primary', [plan.primaryQuery]],
      [
        'retry',
        plan.simplifiedRetryQuery && plan.simplifiedRetryQuery !== plan.primaryQuery
          ? [plan.simplifiedRetryQuery]
          : [],
      ],
      ['coverage', collectGraphCoverageEvidenceQueries({ plan, question: input.question })],
    ];
    return phases.flatMap(([phase, texts]) =>
      texts.map((text) => ({
        caseId: input.id,
        projectId: input.projectId,
        phase,
        text,
        textHash: parityChatTextHash(text),
      })),
    );
  });
}
