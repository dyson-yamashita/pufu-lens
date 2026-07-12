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

export function hasGraphStep(steps: readonly DrainWorkflowStep[]): boolean {
  return steps.includes('graph');
}

export function shouldFailDrainAtLimit(
  steps: readonly DrainWorkflowStep[],
  remaining: DrainRemainingState,
): boolean {
  return hasDrainRemainingWork(steps, remaining);
}

export function shouldContinueDrainAfterBatch(input: {
  batchProgress: number;
  remaining: DrainRemainingState;
  steps: readonly DrainWorkflowStep[];
}): boolean {
  if (hasDrainRemainingWork(input.steps, input.remaining)) {
    return true;
  }
  return hasGraphStep(input.steps) && input.batchProgress > 0;
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
