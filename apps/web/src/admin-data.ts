export type SourceType = 'gmail' | 'drive' | 'github' | 'web';
export type SourceStatus = 'healthy' | 'syncing' | 'failed' | 'held';
export type ParserProfileStatus = 'approved' | 'review_requested' | 'draft' | 'rejected';

export interface DataSourceSummary {
  readonly id: string;
  readonly name: string;
  readonly sourceType: SourceType;
  readonly status: SourceStatus;
  readonly scope: string;
  readonly rawCount: number;
  readonly queueCount: number;
  readonly failedCount: number;
  readonly heldCount: number;
  readonly lastChecked: string;
  readonly lastIndexed: string;
  readonly configSummary: string;
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
  readonly slug: string;
  readonly name: string;
  readonly status: 'active' | 'attention';
  readonly memberCount: number;
  readonly rawCount: number;
  readonly queueCount: number;
  readonly failedCount: number;
  readonly heldCount: number;
  readonly lastIndexed: string;
  readonly dataSources: readonly DataSourceSummary[];
  readonly parserProfiles: readonly ParserProfileSummary[];
}

export const fallbackProjects = [
  {
    slug: 'sample-a',
    name: 'Sample A',
    status: 'attention',
    memberCount: 4,
    rawCount: 42,
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
        rawCount: 8,
        queueCount: 0,
        failedCount: 0,
        heldCount: 0,
        lastChecked: '2026-06-02 09:08',
        lastIndexed: '2026-06-02 09:12',
        configSummary: 'URL 5 件、canonical URL 検査あり',
      },
      {
        id: 'sample-a-github-main',
        name: 'GitHub 主要リポジトリ',
        sourceType: 'github',
        status: 'failed',
        scope: 'dyson-yamashita/pufu-lens',
        rawCount: 21,
        queueCount: 4,
        failedCount: 2,
        heldCount: 1,
        lastChecked: '2026-06-02 08:44',
        lastIndexed: '2026-06-02 08:49',
        configSummary: 'Issue / PR / comment を収集',
      },
      {
        id: 'sample-a-drive-product',
        name: 'Drive プロダクト資料',
        sourceType: 'drive',
        status: 'held',
        scope: 'folder: product-specs',
        rawCount: 13,
        queueCount: 2,
        failedCount: 0,
        heldCount: 2,
        lastChecked: '2026-06-01 18:05',
        lastIndexed: '2026-06-01 18:09',
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
  },
  {
    slug: 'sample-b',
    name: 'Sample B',
    status: 'active',
    memberCount: 2,
    rawCount: 17,
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
        rawCount: 5,
        queueCount: 0,
        failedCount: 0,
        heldCount: 0,
        lastChecked: '2026-06-02 07:30',
        lastIndexed: '2026-06-02 07:36',
        configSummary: 'URL 1 件、再実行重複なし',
      },
      {
        id: 'sample-b-gmail-support',
        name: 'Gmail サポートラベル',
        sourceType: 'gmail',
        status: 'syncing',
        scope: 'label:support',
        rawCount: 12,
        queueCount: 1,
        failedCount: 0,
        heldCount: 0,
        lastChecked: '2026-06-02 07:28',
        lastIndexed: '2026-06-02 07:35',
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
  },
] satisfies readonly ProjectSummary[];

export function listProjects(): readonly ProjectSummary[] {
  return fallbackProjects;
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
