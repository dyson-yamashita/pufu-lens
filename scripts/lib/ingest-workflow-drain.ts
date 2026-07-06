export type DrainWorkflowStep = 'collect' | 'parse' | 'resolve' | 'chunk' | 'graph';

export type DrainRemainingState = {
  parseQueue: number;
  parsedRaw: number;
};

export function hasDrainRemainingWork(
  steps: readonly DrainWorkflowStep[],
  remaining: DrainRemainingState,
): boolean {
  for (const step of steps) {
    if (step === 'parse' && remaining.parseQueue > 0) {
      return true;
    }
    if ((step === 'resolve' || step === 'chunk' || step === 'graph') && remaining.parsedRaw > 0) {
      return true;
    }
  }
  return false;
}

export function shouldCountParsedRaw(steps: readonly DrainWorkflowStep[]): boolean {
  return steps.some((step) => step === 'resolve' || step === 'chunk' || step === 'graph');
}

export function summarizeDrainRemaining(remaining: DrainRemainingState): DrainRemainingState {
  return {
    parseQueue: remaining.parseQueue,
    parsedRaw: remaining.parsedRaw,
  };
}
