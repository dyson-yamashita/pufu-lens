import type {
  PrivateReportJsonV1,
  PrivateReportPufuSource,
  PrivateReportSection,
} from './report.ts';

const emptyComment = { color: 'blue' as const, text: '' };

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export type PufuScoreModel = {
  elements: {
    businessScheme: PufuBaseModel;
    environment: PufuBaseModel;
    foreignEnemy: PufuBaseModel;
    money: PufuBaseModel;
    people: PufuBaseModel;
    quality: PufuBaseModel;
    rival: PufuBaseModel;
    time: PufuBaseModel;
  };
  gainingGoal: PufuBaseModel;
  purposes: PufuPurposeModel[];
  winCondition: PufuBaseModel;
};

type PufuBaseModel = {
  comment: typeof emptyComment;
  text: string;
  uuid: string;
};

type PufuMeasureModel = PufuBaseModel & {
  color: 'blue' | 'green' | 'yellow';
  progress?: number;
};

type PufuPurposeModel = PufuBaseModel & {
  measures: PufuMeasureModel[];
};

export type PufuScoreReportInput = Pick<
  PrivateReportJsonV1,
  'period' | 'pufu_sources' | 'report_id' | 'sections' | 'summary' | 'title'
>;

type PufuSourceCandidate = Pick<
  PrivateReportPufuSource,
  'canonical_uri' | 'doc_type' | 'document_id' | 'occurred_at' | 'snippet' | 'title'
>;

export function createPufuScoreFromReport(report: PufuScoreReportInput): PufuScoreModel {
  const sources = sourceCandidates(report);
  if (isExhibitionSource(sources)) {
    return createExhibitionPufuScore(report, sources);
  }
  const sourceState = summarizeSourceState(sources);
  const sourceQuestion = summarizeSourceQuestion(sources);
  const sourceRisk = summarizeSourceRisk(sources);
  return {
    elements: {
      businessScheme: element(
        sources.length > 0
          ? `${sourceLabel(primarySource(sources))} を、関係者が同じ大局観を持つための根拠資料として扱う。`
          : '収集された情報を、関係者が同じ大局観を持つための材料として扱う。',
      ),
      environment: element(sourceState),
      foreignEnemy: element(sourceRisk),
      money: element('使える予算・工数・運用負荷は、判断時に明示する必要がある。'),
      people: element('関係者の認識、期待、温度感をそろえることが重要。'),
      quality: element('データソースから読み取れる事実と、解釈した仮説を分けて扱う必要がある。'),
      rival: element(sourceQuestion),
      time: element(`${report.period.start} から ${report.period.end} 時点の認識。`),
    },
    gainingGoal: objective(sourceGoal(sources)),
    purposes: [
      purpose('現状認識がそろっている', [
        measure(sourceRephraseMeasure(sources), 'green'),
        measure(sourceEvidenceMeasure(sources), 'blue'),
      ]),
      purpose('進み方の仮説が言語化されている', [
        measure(sourceMovementMeasure(sources), 'blue'),
        measure(sourceQuestionMeasure(sources), 'yellow'),
      ]),
      purpose('不確実性を前提に次の一手を選べる', [
        measure(sourceRiskMeasure(sources), 'yellow'),
        measure('このプ譜を現在時点のスナップショットとして見直す。', 'green'),
      ]),
    ],
    winCondition: objective(
      '関係者が「データソースから何が分かり、どうなりたいか、そのために何を試すか」を説明できる。',
    ),
  };
}

function createExhibitionPufuScore(
  report: PufuScoreReportInput,
  sources: readonly PufuSourceCandidate[],
): PufuScoreModel {
  const primary = primarySource(sources);
  const eventName = exhibitionEventName(sources);
  return {
    elements: {
      businessScheme: element(
        `${eventName} のブースで、プ譜友の会がプ譜エディターを来場者に見せる座組。`,
      ),
      environment: element(
        'オープンソースや開発ツールに関心を持つ来場者が集まる場で、初見の人にも価値を伝える必要がある。',
      ),
      foreignEnemy: element(
        '短い会話時間では、プ譜の考え方や使いどころが伝わりきらない可能性がある。',
      ),
      money: element('出展に使える人手、準備時間、ブース運営の負荷を抑えながら成果につなげる。'),
      people: element('プ譜友の会の出展メンバーと、ブースに立ち寄る来場者が主な関係者。'),
      quality: element('来場者が自分のプロジェクトに置き換えて理解できる説明とデモの質が重要。'),
      rival: element('他ブースやイベント内の多数の話題の中で、来場者の関心を得る必要がある。'),
      time: element(`${report.period.start} から ${report.period.end} 時点で確認した出展活動。`),
    },
    gainingGoal: objective(`${eventName} への出展を通じて、プ譜エディターを試す人を増やす。`),
    purposes: [
      purpose('来場者がプ譜エディターに触れる入口ができている', [
        measure('ブースでプ譜エディターの画面や使い方を見せる。', 'green'),
        measure('来場者のプロジェクトや困りごとを聞き、プ譜に置き換えて説明する。', 'blue'),
      ]),
      purpose('プ譜の価値が初見の人にも伝わっている', [
        measure('プ譜が何を整理する道具なのかを、短い説明で伝える。', 'blue'),
        measure('来場者の反応や質問から、伝わりにくい点をその場で補足する。', 'yellow'),
      ]),
      purpose('出展後の学びが次の活動につながっている', [
        measure('出展で得た反応、質問、説明の手応えをプ譜友の会で共有する。', 'yellow'),
        measure(
          `${sourceLabel(primary)} を振り返り、次のイベントやエディター改善に反映する。`,
          'green',
        ),
      ]),
    ],
    winCondition: objective(
      '来場者が「プ譜で何を整理できるか」を理解し、プ譜エディターを試す次の接点が生まれている。',
    ),
  };
}

function sourceCandidates(report: PufuScoreReportInput): PufuSourceCandidate[] {
  const explicitSources = report.pufu_sources ?? [];
  if (explicitSources.length > 0) {
    return [...explicitSources];
  }
  const sectionSources: PufuSourceCandidate[] = report.sections.flatMap((section) =>
    (section.sources ?? []).map((source) => ({
      canonical_uri: source.canonical_uri,
      doc_type: source.doc_type,
      document_id: source.document_id,
      occurred_at: null,
      snippet: source.snippet,
      title: sourceTitleFromSnippet(source.snippet) || source.canonical_uri || source.document_id,
    })),
  );
  const markdownSources = report.sections.flatMap(markdownSourceCandidates);
  return dedupeSources([...markdownSources, ...sectionSources]);
}

function markdownSourceCandidates(section: PrivateReportSection): PufuSourceCandidate[] {
  if (section.id !== 'activity') {
    return [];
  }
  const sources: PufuSourceCandidate[] = [];
  section.markdown.split('\n').forEach((line, index) => {
    const match = line.match(/^\s*[-*]\s+(.+?):\s+(.+)$/);
    const title = match?.[1];
    const snippet = match?.[2];
    if (!title || !snippet) {
      return;
    }
    sources.push({
      canonical_uri: '',
      doc_type: 'report_source',
      document_id: `markdown-source-${index}`,
      occurred_at: null,
      snippet: truncateText(snippet, 220),
      title: truncateText(title, 120),
    });
  });
  return sources;
}

function dedupeSources(sources: PufuSourceCandidate[]): PufuSourceCandidate[] {
  const seen = new Set<string>();
  const deduped: PufuSourceCandidate[] = [];
  for (const source of sources) {
    const key = source.document_id || `${source.title}:${source.snippet}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(source);
    }
  }
  return deduped;
}

function isExhibitionSource(sources: readonly PufuSourceCandidate[]): boolean {
  return /出展|展示|カンファレンス|オープンソースカンファレンス|OSC/i.test(sourceText(sources));
}

function exhibitionEventName(sources: readonly PufuSourceCandidate[]): string {
  const text = sourceText(sources);
  if (/オープンソースカンファレンス2026＠大阪|OSC2026.*大阪|OSC.*大阪/i.test(text)) {
    return 'オープンソースカンファレンス2026＠大阪';
  }
  if (/オープンソースカンファレンス|OSC/i.test(text)) {
    return 'オープンソースカンファレンス';
  }
  return '対外イベント';
}

function summarizeSourceState(sources: readonly PufuSourceCandidate[]): string {
  if (sources.length === 0) {
    return '活動領域や周辺状況は、データソースから継続して読み解く必要がある。';
  }
  const text = sourceText(sources);
  if (/出展|展示|カンファレンス|オープンソースカンファレンス|OSC/i.test(text)) {
    return '現在の認識: 対外イベントでプ譜や関連プロダクトを説明し、外部接点から反応を得ている。';
  }
  if (/リリース|公開|ローンチ|発表/i.test(text)) {
    return '現在の認識: 成果物を外部に出し、利用者や関係者からの反応を確認できる段階にある。';
  }
  return `現在の認識: ${sourceLabel(primarySource(sources))} から、プロジェクトの状況を読み解いている。`;
}

function summarizeSourceQuestion(sources: readonly PufuSourceCandidate[]): string {
  const text = sourceText(sources);
  if (/出展|展示|カンファレンス|OSC/i.test(text)) {
    return '成果や資源を取り合う相手よりも、来場者に何が伝わったか、次に誰へ届けるかが論点。';
  }
  return sources.length > 0
    ? 'データソースから読み取れる論点を、関係者の判断につながる問いへ変換する必要がある。'
    : '成果や資源を取り合う存在・対立論点は未判定。';
}

function summarizeSourceRisk(sources: readonly PufuSourceCandidate[]): string {
  const text = sourceText(sources);
  if (/投稿|レポート|記事|まとめ/i.test(text) && sources.length === 1) {
    return '目的達成を阻む外部要因は明確ではないが、単一の発信だけでは反応や学びを取りこぼす可能性がある。';
  }
  return sources.length > 0
    ? '目的達成を阻む外部要因は、データソースの偏りや不足を前提に確認する必要がある。'
    : '目的達成を阻む外部要因はまだ明確ではない。';
}

function sourceGoal(sources: readonly PufuSourceCandidate[]): string {
  return sources.length > 0
    ? 'データソースからプロジェクトの現在地を読み解き、次の判断に進める。'
    : 'プロジェクトの現在地を大局的に把握し、次の判断に進める。';
}

function sourceRephraseMeasure(sources: readonly PufuSourceCandidate[]): string {
  const text = sourceText(sources);
  if (/出展|展示|カンファレンス|OSC/i.test(text)) {
    return '出展レポートから、来場者の反応や説明で伝わった点を整理する。';
  }
  return sources.length > 0
    ? `${sourceLabel(primarySource(sources))} を、現在の状況として言い換える。`
    : '収集情報を単なる引用ではなく、現在の状況として言い換える。';
}

function sourceEvidenceMeasure(sources: readonly PufuSourceCandidate[]): string {
  return sources.length > 0
    ? `根拠資料 ${sourceLabel(primarySource(sources))} を確認し、関係者間で同じ前提を持つ。`
    : '根拠資料を確認し、関係者間で同じ前提を持つ。';
}

function sourceMovementMeasure(sources: readonly PufuSourceCandidate[]): string {
  const text = sourceText(sources);
  if (/プ譜エディター|プ譜|ProjectScore/i.test(text)) {
    return 'プ譜やプ譜エディターの利用場面を、関係者が共有できる言葉にする。';
  }
  return '目指す状態に近づいているかを、タスク数ではなくデータソース上の状況変化で見る。';
}

function sourceQuestionMeasure(sources: readonly PufuSourceCandidate[]): string {
  const text = sourceText(sources);
  if (/出展|展示|カンファレンス|OSC/i.test(text)) {
    return '出展で得た接点を、次に検証したい相手・場・問いに分けて確認する。';
  }
  return '次に明らかにすべき論点を、データソースの根拠とともに関係者に確認する。';
}

function sourceRiskMeasure(sources: readonly PufuSourceCandidate[]): string {
  return sources.length > 0
    ? 'データソースから見えていることと、まだ見えていないことを分けて検証する。'
    : '単一データソースからの解釈に偏りがないか、追加で確認すべき材料を決める。';
}

function sourceText(sources: readonly PufuSourceCandidate[]): string {
  return sources.map((source) => `${source.title} ${source.snippet}`).join('\n');
}

function sourceLabel(source: PufuSourceCandidate): string {
  return truncateText(source.title || source.snippet || source.document_id, 80);
}

function primarySource(sources: readonly PufuSourceCandidate[]): PufuSourceCandidate {
  const source = sources[0];
  if (!source) {
    throw new Error('Expected at least one pufu source.');
  }
  return source;
}

function sourceTitleFromSnippet(snippet: string): string {
  const normalized = snippet.replace(/\s+/g, ' ').trim();
  const [title] = normalized.split(/[:：]/);
  return title && title.length < normalized.length ? truncateText(title, 120) : '';
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function objective(text: string) {
  return { comment: emptyComment, text, uuid: generateUUID() };
}

function purpose(text: string, measures: PufuMeasureModel[]) {
  return { comment: emptyComment, measures, text, uuid: generateUUID() };
}

function measure(text: string, color: PufuMeasureModel['color']) {
  return {
    color,
    comment: emptyComment,
    text,
    uuid: generateUUID(),
  };
}

function element(text: string) {
  return { comment: emptyComment, text, uuid: generateUUID() };
}
