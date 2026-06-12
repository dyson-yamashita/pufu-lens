export type ActorAliasStrength = 'strong' | 'weak';

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
  readonly displayName: string;
  readonly graphNodeId: string;
  readonly id: string;
  readonly primaryEmail: string;
  readonly primaryLogin: string;
  readonly sourceTypes: readonly string[];
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

export function buildActorMergeCandidates(
  actors: readonly ProjectActorSummary[],
): readonly ActorMergeCandidateSummary[] {
  const actorsByDisplayName = new Map<string, ProjectActorSummary[]>();
  for (const actor of actors) {
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
    for (let first = 0; first < group.length - 1; first += 1) {
      for (let second = first + 1; second < group.length; second += 1) {
        const actorA = group[first];
        const actorB = group[second];
        if (!actorA || !actorB) {
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

function normalizeActorDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
