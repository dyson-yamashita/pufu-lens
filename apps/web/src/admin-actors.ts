export type ActorAliasStrength = 'strong' | 'weak';
export type ActorDecisionType = 'merge' | 'reject';
export type ActorStatus = 'active' | 'merged' | 'disabled';

export type ProjectActorAliasSummary = {
  readonly aliasType: string;
  readonly aliasValue: string;
  readonly confidence: number;
  readonly source: string;
  readonly strength: ActorAliasStrength;
};

export type ProjectActorSummary = {
  readonly actorType: string;
  readonly aliases: readonly ProjectActorAliasSummary[];
  readonly createdAt: string;
  readonly disabledAt: string;
  readonly disabledReason: string;
  readonly disabledByUserId: string;
  readonly displayName: string;
  readonly graphNodeId: string;
  readonly id: string;
  readonly mergedIntoActorId: string;
  readonly mergedIntoActorName: string;
  readonly primaryEmail: string;
  readonly primaryLogin: string;
  readonly sourceTypes: readonly string[];
  readonly status: ActorStatus;
  readonly strongAliasCount: number;
  readonly updatedAt: string;
  readonly weakAliasCount: number;
};

export type ActorMergeCandidateSummary = {
  readonly actorA: ProjectActorSummary;
  readonly actorB: ProjectActorSummary;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly id: string;
  readonly reasons: readonly string[];
};

export type ProjectActorDirectory = {
  readonly actors: readonly ProjectActorSummary[];
  readonly mergeCandidates: readonly ActorMergeCandidateSummary[];
};

export type ActorMergeDecisionSummary = {
  readonly createdAt: string;
  readonly createdByUserId: string;
  readonly decisionType: ActorDecisionType;
  readonly id: string;
  readonly primaryActorDisplayName: string;
  readonly primaryActorId: string;
  readonly reason: string;
  readonly secondaryActorDisplayName: string;
  readonly secondaryActorId: string;
};

export type ProjectActorDetail = {
  readonly actor: ProjectActorSummary;
  readonly aliases: readonly ProjectActorAliasSummary[];
  readonly decisions: readonly ActorMergeDecisionSummary[];
};

export type ActorManualMergeSelection = {
  readonly hasDuplicateSelection: boolean;
  readonly primaryActor: ProjectActorSummary | null;
  readonly secondaryActor: ProjectActorSummary | null;
};

const maxMergeCandidateGroupSize = 15;

export function resolveActorManualMergeSelection(
  actors: readonly ProjectActorSummary[],
  input: {
    readonly primaryActorId?: string;
    readonly secondaryActorId?: string;
  },
): ActorManualMergeSelection {
  const primaryActorId = normalizeActorId(input.primaryActorId);
  const secondaryActorId = normalizeActorId(input.secondaryActorId);
  const hasDuplicateSelection =
    primaryActorId !== undefined &&
    secondaryActorId !== undefined &&
    primaryActorId === secondaryActorId;

  return {
    hasDuplicateSelection,
    primaryActor: primaryActorId ? findActiveActor(actors, primaryActorId) : null,
    secondaryActor:
      secondaryActorId && !hasDuplicateSelection ? findActiveActor(actors, secondaryActorId) : null,
  };
}

export function buildActorMergeCandidates(
  actors: readonly ProjectActorSummary[],
  rejectedPairs: ReadonlySet<string> = new Set(),
): readonly ActorMergeCandidateSummary[] {
  const actorsByDisplayName = new Map<string, ProjectActorSummary[]>();
  for (const actor of actors) {
    if (actor.status !== 'active') {
      continue;
    }
    const normalized = normalizeActorDisplayName(actor.displayName);
    if (!normalized) {
      continue;
    }
    const existing = actorsByDisplayName.get(normalized);
    if (existing) {
      existing.push(actor);
      continue;
    }
    actorsByDisplayName.set(normalized, [actor]);
  }

  const candidates: ActorMergeCandidateSummary[] = [];
  for (const group of actorsByDisplayName.values()) {
    if (group.length < 2) {
      continue;
    }
    const limitedGroup = group.slice(0, maxMergeCandidateGroupSize);
    for (let first = 0; first < limitedGroup.length - 1; first += 1) {
      for (let second = first + 1; second < limitedGroup.length; second += 1) {
        const actorA = limitedGroup[first];
        const actorB = limitedGroup[second];
        if (!actorA || !actorB) {
          continue;
        }
        if (rejectedPairs.has(actorPairKey(actorA.id, actorB.id))) {
          continue;
        }
        candidates.push({
          actorA,
          actorB,
          confidence: 0.4,
          evidence: mergeCandidateEvidence(actorA, actorB),
          id: `${actorA.id}--${actorB.id}`,
          reasons: ['display_name が一致'],
        });
      }
    }
  }

  return candidates.sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.actorA.displayName.localeCompare(right.actorA.displayName);
  });
}

function mergeCandidateEvidence(
  actorA: ProjectActorSummary,
  actorB: ProjectActorSummary,
): readonly string[] {
  return Array.from(new Set([...actorA.sourceTypes, ...actorB.sourceTypes])).sort();
}

export function actorPairKey(actorAId: string, actorBId: string): string {
  return [actorAId, actorBId].sort().join('--');
}

function normalizeActorDisplayName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeActorId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function findActiveActor(
  actors: readonly ProjectActorSummary[],
  actorId: string,
): ProjectActorSummary | null {
  return actors.find((actor) => actor.id === actorId && actor.status === 'active') ?? null;
}
