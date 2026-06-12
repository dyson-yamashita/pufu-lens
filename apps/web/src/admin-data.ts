export type SourceType = 'gmail' | 'drive' | 'github' | 'web';
export type SourceStatus = 'healthy' | 'syncing' | 'failed' | 'held';
export type ParserProfileStatus = 'approved' | 'review_requested' | 'draft' | 'rejected';
export type ProjectVisibility = 'private' | 'public';
export type ConnectionProvider = 'google' | 'github';
export type ProjectConnectionStatus =
  | 'connected'
  | 'not_connected'
  | 'expired'
  | 'scope_missing'
  | 'error';

export interface ProjectConnectionSummary {
  readonly provider: ConnectionProvider;
  readonly status: ProjectConnectionStatus;
  readonly accountLabel: string | null;
  readonly configuration: ProjectConnectionConfiguration;
  readonly grantedScopes: readonly string[];
  readonly scopesSummary: string;
  readonly permissionsSummary: string;
  readonly updatedAt: string;
  readonly metadataLabels: readonly string[];
}

export interface ProjectConnectionConfiguration {
  readonly githubAppId?: string;
  readonly githubAppSlug?: string;
  readonly githubPrivateKeyConfigured?: boolean;
}

export type ProjectSourceAvailability = Record<SourceType, boolean>;

const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = ['google', 'github'];

export function requiredProviderForSourceType(sourceType: SourceType): ConnectionProvider | null {
  if (sourceType === 'web') {
    return null;
  }
  if (sourceType === 'github') {
    return 'github';
  }
  if (sourceType === 'gmail' || sourceType === 'drive') {
    return 'google';
  }
  return null;
}

export function isConnectionUsable(status: ProjectConnectionStatus): boolean {
  return status === 'connected' || status === 'expired';
}

export function isSourceTypeAvailable(
  sourceType: SourceType,
  connections: readonly ProjectConnectionSummary[],
): boolean {
  const provider = requiredProviderForSourceType(sourceType);
  if (!provider) {
    return true;
  }
  const connection = connections.find((candidate) => candidate.provider === provider);
  if (!connection || !isConnectionUsable(connection.status)) {
    return false;
  }
  if (sourceType === 'gmail') {
    return connection.grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly');
  }
  if (sourceType === 'drive') {
    return connection.grantedScopes.includes('https://www.googleapis.com/auth/drive.readonly');
  }
  return true;
}

export function availabilityFromConnections(
  connections: readonly ProjectConnectionSummary[],
): ProjectSourceAvailability {
  return {
    drive: isSourceTypeAvailable('drive', connections),
    github: isSourceTypeAvailable('github', connections),
    gmail: isSourceTypeAvailable('gmail', connections),
    web: true,
  };
}

export function isAdminUiCollectionSupported(sourceType: SourceType): boolean {
  return (
    sourceType === 'web' ||
    sourceType === 'drive' ||
    sourceType === 'gmail' ||
    sourceType === 'github'
  );
}

export function isAdminUiIngestSupported(sourceType: SourceType): boolean {
  return (
    sourceType === 'web' ||
    sourceType === 'drive' ||
    sourceType === 'gmail' ||
    sourceType === 'github'
  );
}

export function notConnectedProjectConnections(): readonly ProjectConnectionSummary[] {
  return CONNECTION_PROVIDERS.map((provider) => notConnectedSummary(provider));
}

function notConnectedSummary(provider: ConnectionProvider): ProjectConnectionSummary {
  return {
    accountLabel: null,
    configuration: {},
    grantedScopes: [],
    metadataLabels: [],
    permissionsSummary: 'Not configured',
    provider,
    scopesSummary: 'No scopes granted',
    status: 'not_connected',
    updatedAt: 'not yet',
  };
}

export interface PublicProjectReportSummary {
  readonly id: string;
  readonly publishedAt: string;
  readonly summary: string;
  readonly title: string;
}

export interface PublicProjectSummary {
  readonly description: string;
  readonly name: string;
  readonly reports: readonly PublicProjectReportSummary[];
  readonly slug: string;
}

export interface DataSourceSummary {
  readonly id: string;
  readonly name: string;
  readonly sourceType: SourceType;
  readonly status: SourceStatus;
  readonly scope: string;
  readonly editableScope: string;
  readonly rawCount: number;
  readonly ingestedCount: number;
  readonly queueCount: number;
  readonly failedCount: number;
  readonly heldCount: number;
  readonly lastChecked: string;
  readonly lastIndexed: string;
  readonly ingestHistory: readonly IngestHistoryEntry[];
  readonly configSummary: string;
}

export interface IngestHistoryEntry {
  readonly label: string;
  readonly value: string;
}

export interface ParserProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly sourceType: SourceType;
  readonly activeVersion: string;
  readonly draftVersion: string;
  readonly status: ParserProfileStatus;
  readonly heldQueueCount: number;
  readonly validationReport: string;
  readonly reviewVersionId?: string;
}

export interface ProjectSummary {
  readonly description: string | null;
  readonly slug: string;
  readonly name: string;
  readonly status: 'active' | 'attention';
  readonly memberCount: number;
  readonly rawCount: number;
  readonly ingestedCount: number;
  readonly queueCount: number;
  readonly failedCount: number;
  readonly heldCount: number;
  readonly lastIndexed: string;
  readonly dataSources: readonly DataSourceSummary[];
  readonly parserProfiles: readonly ParserProfileSummary[];
  readonly visibility: ProjectVisibility;
}

export const fallbackProjects = [
  {
    slug: 'sample-a',
    name: 'Sample A',
    description: '公開レポートと Public Chat を確認できるサンプルプロジェクトです。',
    status: 'attention',
    memberCount: 4,
    rawCount: 42,
    ingestedCount: 34,
    queueCount: 6,
    failedCount: 2,
    heldCount: 3,
    lastIndexed: '2026-06-02 09:12',
    dataSources: [
      {
        id: 'sample-a-web-docs',
        name: '公開ドキュメント',
        sourceType: 'web',
        status: 'healthy',
        scope: 'https://example.com/docs',
        editableScope: 'https://example.com/docs',
        rawCount: 8,
        ingestedCount: 8,
        queueCount: 0,
        failedCount: 0,
        heldCount: 0,
        lastChecked: '2026-06-02 09:08',
        lastIndexed: '2026-06-02 09:12',
        ingestHistory: [
          { label: 'Last collect', value: '2026-06-02 09:08' },
          { label: 'Last indexed', value: '2026-06-02 09:12' },
          { label: 'Raw / Ingested', value: '8 / 8' },
        ],
        configSummary: 'URL 5 件、canonical URL 検査あり',
      },
      {
        id: 'sample-a-github-main',
        name: 'GitHub 主要リポジトリ',
        sourceType: 'github',
        status: 'failed',
        scope: 'dyson-yamashita/pufu-lens',
        editableScope: 'dyson-yamashita/pufu-lens',
        rawCount: 21,
        ingestedCount: 17,
        queueCount: 4,
        failedCount: 2,
        heldCount: 1,
        lastChecked: '2026-06-02 08:44',
        lastIndexed: '2026-06-02 08:49',
        ingestHistory: [
          { label: 'Last collect', value: '2026-06-02 08:44' },
          { label: 'Last indexed', value: '2026-06-02 08:49' },
          { label: 'Raw / Ingested', value: '21 / 17' },
        ],
        configSummary: 'Issue / PR / comment を収集',
      },
      {
        id: 'sample-a-drive-product',
        name: 'Drive プロダクト資料',
        sourceType: 'drive',
        status: 'held',
        scope: 'folder: product-specs',
        editableScope: 'product-specs',
        rawCount: 13,
        ingestedCount: 9,
        queueCount: 2,
        failedCount: 0,
        heldCount: 2,
        lastChecked: '2026-06-01 18:05',
        lastIndexed: '2026-06-01 18:09',
        ingestHistory: [
          { label: 'Last collect', value: '2026-06-01 18:05' },
          { label: 'Last indexed', value: '2026-06-01 18:09' },
          { label: 'Raw / Ingested', value: '13 / 9' },
        ],
        configSummary: 'folder 制限、revision 追跡あり',
      },
    ],
    parserProfiles: [
      {
        id: 'sample-a-web-parser',
        name: 'web-default',
        sourceType: 'web',
        activeVersion: 'v3',
        draftVersion: 'v4',
        status: 'approved',
        heldQueueCount: 0,
        validationReport: 'canonical URL と HTML 本文抽出が通過',
      },
      {
        id: 'sample-a-drive-parser',
        name: 'drive-product-docs',
        sourceType: 'drive',
        activeVersion: 'v1',
        draftVersion: 'v2',
        status: 'review_requested',
        heldQueueCount: 2,
        validationReport: 'owner metadata 欠落 2 件を確認待ち',
      },
    ],
    visibility: 'public',
  },
  {
    slug: 'sample-b',
    name: 'Sample B',
    description: 'private project の操作確認に使うサンプルプロジェクトです。',
    status: 'active',
    memberCount: 2,
    rawCount: 17,
    ingestedCount: 16,
    queueCount: 1,
    failedCount: 0,
    heldCount: 0,
    lastIndexed: '2026-06-02 07:36',
    dataSources: [
      {
        id: 'sample-b-web-status',
        name: '公開ステータス',
        sourceType: 'web',
        status: 'healthy',
        scope: 'https://status.example.com',
        editableScope: 'https://status.example.com',
        rawCount: 5,
        ingestedCount: 5,
        queueCount: 0,
        failedCount: 0,
        heldCount: 0,
        lastChecked: '2026-06-02 07:30',
        lastIndexed: '2026-06-02 07:36',
        ingestHistory: [
          { label: 'Last collect', value: '2026-06-02 07:30' },
          { label: 'Last indexed', value: '2026-06-02 07:36' },
          { label: 'Raw / Ingested', value: '5 / 5' },
        ],
        configSummary: 'URL 1 件、再実行重複なし',
      },
      {
        id: 'sample-b-gmail-support',
        name: 'Gmail サポートラベル',
        sourceType: 'gmail',
        status: 'syncing',
        scope: 'label:support',
        editableScope: 'label:support',
        rawCount: 12,
        ingestedCount: 11,
        queueCount: 1,
        failedCount: 0,
        heldCount: 0,
        lastChecked: '2026-06-02 07:28',
        lastIndexed: '2026-06-02 07:35',
        ingestHistory: [
          { label: 'Last collect', value: '2026-06-02 07:28' },
          { label: 'Last indexed', value: '2026-06-02 07:35' },
          { label: 'Raw / Ingested', value: '12 / 11' },
        ],
        configSummary: 'thread 最新メールと引用を分離',
      },
    ],
    parserProfiles: [
      {
        id: 'sample-b-gmail-parser',
        name: 'gmail-support',
        sourceType: 'gmail',
        activeVersion: 'v2',
        draftVersion: 'none',
        status: 'approved',
        heldQueueCount: 0,
        validationReport: '引用チェーンと sender alias が通過',
      },
    ],
    visibility: 'private',
  },
] satisfies readonly ProjectSummary[];

export const fallbackPublicProjects = [
  {
    description: '公開レポートと Public Chat を確認できるサンプルプロジェクトです。',
    name: 'Sample A',
    reports: [
      {
        id: 'report-a',
        publishedAt: '2026-06-04 19:00',
        summary: '公開可能な概要です。',
        title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
      },
    ],
    slug: 'sample-a',
  },
] satisfies readonly PublicProjectSummary[];

export function listProjects(): readonly ProjectSummary[] {
  return fallbackProjects;
}

export function listPublicProjects(): readonly PublicProjectSummary[] {
  return fallbackPublicProjects;
}

export function getProject(slug: string): ProjectSummary {
  const project = fallbackProjects.find((candidate) => candidate.slug === slug);
  if (!project) {
    throw new Error(`Unknown project slug: ${slug}`);
  }
  return project;
}

export function getSourceTypeCounts(project: ProjectSummary): Record<SourceType, number> {
  return project.dataSources.reduce<Record<SourceType, number>>(
    (counts, source) => {
      counts[source.sourceType] += 1;
      return counts;
    },
    { drive: 0, github: 0, gmail: 0, web: 0 },
  );
}
