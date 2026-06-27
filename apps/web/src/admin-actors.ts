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

export type ProjectActorSummaryRow = {
  readonly actor_type: string;
  readonly created_at: Date | string;
  readonly disabled_at: Date | string | null;
  readonly disabled_by_user_id: string | null;
  readonly disabled_reason: string | null;
  readonly display_name: string;
  readonly graph_node_id: string;
  readonly id: string;
  readonly merged_into_actor_id: string | null;
  readonly merged_into_actor_name: string | null;
  readonly metadata: unknown;
  readonly primary_email: string | null;
  readonly primary_login: string | null;
  readonly status: ActorStatus;
  readonly updated_at: Date | string;
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

export function buildProjectActorSummary(
  row: ProjectActorSummaryRow,
  aliases: readonly ProjectActorAliasSummary[],
): ProjectActorSummary {
  return {
    aliasCount: aliases.length,
    actorType: row.actor_type,
    aliases,
    createdAt: formatDate(row.created_at),
    disabledAt: row.disabled_at === null ? 'none' : formatDate(row.disabled_at),
    disabledByUserId: row.disabled_by_user_id ?? 'none',
    disabledReason: row.disabled_reason ?? 'none',
    displayName: row.display_name,
    graphNodeId: row.graph_node_id,
    id: row.id,
    mergedIntoActorId: row.merged_into_actor_id ?? 'none',
    mergedIntoActorName: row.merged_into_actor_name ?? 'none',
    primaryEmail: row.primary_email ?? 'none',
    primaryLogin: row.primary_login ?? 'none',
    sourceTypes: sourceTypesFromActor(row.metadata, aliases),
    status: row.status,
    updatedAt: formatDate(row.updated_at),
  };
}

function sourceTypesFromAliases(aliases: readonly ProjectActorAliasSummary[]): readonly string[] {
  const sourceTypes = new Set<string>();
  for (const alias of aliases) {
    const sourceType = alias.source.split(':')[0]?.trim();
    if (sourceType && sourceType !== 'unknown') {
      sourceTypes.add(sourceType);
    }
  }
  return Array.from(sourceTypes).sort();
}

function sourceTypesFromActor(
  metadata: unknown,
  aliases: readonly ProjectActorAliasSummary[],
): readonly string[] {
  const sourceTypes = new Set(sourceTypesFromAliases(aliases));
  if (isRecord(metadata) && isRecord(metadata.resolution)) {
    const sourceType = metadata.resolution.sourceType;
    if (typeof sourceType === 'string' && sourceType.trim()) {
      sourceTypes.add(sourceType.trim());
    }
  }
  return Array.from(sourceTypes).sort();
}

function formatDate(value: Date | string | null): string {
  if (!value) {
    return 'not yet';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'invalid date';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
