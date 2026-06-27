export type ActorDecisionType = 'merge' | 'reject';
export type ActorStatus = 'active' | 'merged' | 'disabled';

export type ProjectActorAliasSummary = {
  readonly aliasType: string;
  readonly aliasValue: string;
  readonly confidence: number;
  readonly source: string;
};

export type ProjectActorSummary = {
  readonly aliasCount: number;
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
  readonly updatedAt: string;
};

export type ProjectActorDirectory = {
  readonly actors: readonly ProjectActorSummary[];
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
