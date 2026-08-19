import type { GraphReadRepository } from '@pufu-lens/graph';
import type { SyntheticMonitorRepository } from './synthetic-monitor-service.ts';

export type SyntheticMonitorTestRepository = SyntheticMonitorRepository & {
  countGraphDocumentNode(input: {
    readonly graphNodeId: string;
    readonly projectId: string;
  }): Promise<number>;
  countGraphRelations(
    input: Parameters<GraphReadRepository['countRelations']>[0],
  ): ReturnType<GraphReadRepository['countRelations']>;
};

/** Adapts legacy-shaped test doubles to the provider-neutral graph read contract. */
export function createSyntheticMonitorTestGraphReadRepository(
  repository: SyntheticMonitorTestRepository,
): Pick<GraphReadRepository, 'countDocumentNode' | 'countRelations'> {
  return {
    countDocumentNode: (input) => repository.countGraphDocumentNode(input),
    countRelations: (input) => repository.countGraphRelations(input),
  };
}
