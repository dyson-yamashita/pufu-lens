export type TopicCandidateSource =
  | 'hashtag'
  | 'title'
  | 'meta_keywords'
  | 'quoted_phrase'
  | 'title_lexical'
  | 'body_lexical';

/** One ranked prompt candidate with stable ID, display text, and compact evidence metadata. */
export interface TopicCandidateRecord {
  readonly evidence: string;
  readonly frequency: number;
  readonly id: string;
  readonly sectionIndices: ReadonlySet<number>;
  readonly sourcePriority: number;
  readonly sources: ReadonlySet<TopicCandidateSource>;
  readonly target: string;
}

/** Minimal lexicon used to resolve Gemini `selectedCandidateIds` back to local candidates. */
export interface TopicCandidateLexicon {
  readonly candidates: readonly TopicCandidateRecord[];
  readonly idToTarget: ReadonlyMap<string, string>;
}

interface MutableTopicCandidateRecord {
  frequency: number;
  sectionIndices: Set<number>;
  sourcePriority: number;
  sources: Set<TopicCandidateSource>;
  target: string;
}

interface RankedTopicCandidate {
  readonly record: MutableTopicCandidateRecord;
  readonly score: number;
}

const BODY_SECTION_SIZE = 2000;
const MAX_CANDIDATE_EVIDENCE_LENGTH = 80;
const MMR_RELEVANCE_WEIGHT = 0.55;
const SECTION_NOVELTY_WEIGHT = 0.35;
const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.55;

/**
 * Splits document body text into bounded sections for document-wide sampling.
 *
 * Paragraph boundaries are preserved when possible, but every oversized paragraph
 * is further split into fixed-size chunks so only a prefix/suffix is never inspected.
 */
export function splitBodyIntoSections(bodyText: string, sectionSize = BODY_SECTION_SIZE): string[] {
  if (!bodyText) {
    return [];
  }
  const paragraphs = bodyText.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
  const mergedSections: string[] = [];
  if (paragraphs.length > 1) {
    let current = '';
    for (const paragraph of paragraphs) {
      if (current.length + paragraph.length + 2 > sectionSize && current.length > 0) {
        mergedSections.push(current);
        current = paragraph;
      } else {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
      }
    }
    if (current) {
      mergedSections.push(current);
    }
  } else {
    mergedSections.push(bodyText);
  }
  const sections: string[] = [];
  for (const section of mergedSections) {
    if (section.length <= sectionSize) {
      sections.push(section);
      continue;
    }
    for (let index = 0; index < section.length; index += sectionSize) {
      sections.push(section.slice(index, index + sectionSize));
    }
  }
  return sections;
}

/**
 * Selects representative body sections across the full document within a character budget.
 *
 * @param sections - Bounded body sections in document order.
 * @param maxCharacters - Total analysis budget across returned section slices.
 * @returns Empty when `maxCharacters <= 0` or when no sections are provided.
 */
export function selectSectionsAcrossDocument(
  sections: readonly string[],
  maxCharacters: number,
): readonly string[] {
  if (maxCharacters <= 0 || sections.length === 0) {
    return [];
  }
  const totalLength = sections.reduce((sum, section) => sum + section.length, 0);
  if (totalLength <= maxCharacters) {
    return [...sections];
  }
  if (sections.length === 1) {
    const [onlySection] = sections;
    if (onlySection === undefined) {
      return [];
    }
    return [onlySection.slice(0, maxCharacters)];
  }

  const averageSectionLength = totalLength / sections.length;
  const desiredSectionCount = Math.ceil(
    maxCharacters / Math.min(averageSectionLength, BODY_SECTION_SIZE),
  );
  const targetSectionCount = Math.max(
    1,
    Math.min(sections.length, maxCharacters, desiredSectionCount),
  );

  if (targetSectionCount === 1) {
    const tailSection = sections[sections.length - 1];
    if (tailSection === undefined) {
      return [];
    }
    return [tailSection.slice(-maxCharacters)];
  }

  const uniqueIndices = selectEvenlySpacedSectionIndices(sections.length, targetSectionCount);
  const sectionBudgets = distributeCharacterBudget(maxCharacters, uniqueIndices.length);

  const slices: string[] = [];
  for (let sliceIndex = 0; sliceIndex < uniqueIndices.length; sliceIndex += 1) {
    const sectionIndex = uniqueIndices[sliceIndex];
    if (sectionIndex === undefined) {
      continue;
    }
    const section = sections[sectionIndex];
    if (section === undefined) {
      continue;
    }
    const sliceBudget = sectionBudgets[sliceIndex] ?? 0;
    if (sliceBudget <= 0) {
      continue;
    }
    const sliceLength = Math.min(section.length, sliceBudget);
    const slice =
      sectionIndex === sections.length - 1 && section.length > sliceLength
        ? section.slice(-sliceLength)
        : section.slice(0, sliceLength);
    slices.push(slice);
  }
  return slices;
}

function selectEvenlySpacedSectionIndices(
  sectionCount: number,
  targetSectionCount: number,
): number[] {
  if (targetSectionCount <= 1) {
    return [sectionCount - 1];
  }
  const selectedIndices: number[] = [];
  const seenIndices = new Set<number>();
  for (let pick = 0; pick < targetSectionCount; pick += 1) {
    const index = Math.round((pick * (sectionCount - 1)) / (targetSectionCount - 1));
    if (!seenIndices.has(index)) {
      seenIndices.add(index);
      selectedIndices.push(index);
    }
  }
  if (!seenIndices.has(sectionCount - 1)) {
    if (selectedIndices.length >= targetSectionCount) {
      selectedIndices[selectedIndices.length - 1] = sectionCount - 1;
    } else {
      selectedIndices.push(sectionCount - 1);
    }
  }
  return [...new Set(selectedIndices)]
    .sort((left, right) => left - right)
    .slice(0, targetSectionCount);
}

function distributeCharacterBudget(maxCharacters: number, sectionCount: number): number[] {
  if (sectionCount <= 0) {
    return [];
  }
  const budgets = Array.from({ length: sectionCount }, () => 1);
  let remaining = maxCharacters - sectionCount;
  let index = 0;
  while (remaining > 0) {
    const budgetIndex = index % sectionCount;
    const currentBudget = budgets[budgetIndex];
    if (currentBudget !== undefined) {
      budgets[budgetIndex] = currentBudget + 1;
    }
    remaining -= 1;
    index += 1;
  }
  return budgets;
}

/** Collects per-target frequency, source priority, and section coverage before final ranking. */
export class TopicCandidateAccumulator {
  private readonly records = new Map<string, MutableTopicCandidateRecord>();

  /** Merges duplicate targets and tracks the strongest source plus section coverage. */
  addCandidate(target: string, source: TopicCandidateSource, sectionIndex?: number): void {
    const key = target.toLowerCase();
    const existing = this.records.get(key);
    if (existing) {
      existing.frequency += 1;
      existing.sources.add(source);
      existing.sourcePriority = Math.max(existing.sourcePriority, sourcePriority(source));
      if (sectionIndex !== undefined) {
        existing.sectionIndices.add(sectionIndex);
      }
      return;
    }
    this.records.set(key, {
      frequency: 1,
      sectionIndices: sectionIndex === undefined ? new Set<number>() : new Set([sectionIndex]),
      sourcePriority: sourcePriority(source),
      sources: new Set([source]),
      target,
    });
  }

  /** Returns accumulated candidate records for ranking and lexicon construction. */
  values(): MutableTopicCandidateRecord[] {
    return [...this.records.values()];
  }
}

/**
 * Ranks accumulated observations and returns a capped, section-balanced, diversified lexicon.
 *
 * @param maxCandidates - Final prompt candidate cap. Returns an empty lexicon when `<= 0`.
 */
export function buildTopicCandidateLexicon(
  records: readonly MutableTopicCandidateRecord[],
  maxCandidates: number,
  sampledSectionIndices: readonly number[],
): TopicCandidateLexicon {
  if (maxCandidates <= 0) {
    return emptyTopicCandidateLexicon();
  }
  const rankedCandidates = rankTopicCandidates(records);
  const diversifiedCandidates = selectBalancedTopicCandidates(
    rankedCandidates,
    maxCandidates,
    sampledSectionIndices,
  );
  return finalizeTopicCandidateLexicon(diversifiedCandidates);
}

function emptyTopicCandidateLexicon(): TopicCandidateLexicon {
  return { candidates: [], idToTarget: new Map() };
}

function sourcePriority(source: TopicCandidateSource): number {
  switch (source) {
    case 'hashtag':
      return 100;
    case 'meta_keywords':
      return 90;
    case 'title':
      return 80;
    case 'quoted_phrase':
      return 70;
    case 'title_lexical':
      return 60;
    case 'body_lexical':
      return 50;
  }
}

function rankTopicCandidates(
  records: readonly MutableTopicCandidateRecord[],
): RankedTopicCandidate[] {
  return records
    .map((record) => ({
      record,
      score:
        record.sourcePriority * 1_000_000 +
        record.sectionIndices.size * 10_000 +
        record.frequency * 100,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.record.target.localeCompare(right.record.target, 'ja');
    });
}

function selectBalancedTopicCandidates(
  rankedCandidates: readonly RankedTopicCandidate[],
  maxCandidates: number,
  sampledSectionIndices: readonly number[],
): MutableTopicCandidateRecord[] {
  const diversified = applyMmrDiversityReranking(rankedCandidates, maxCandidates);
  return ensureSampledSectionCoverage(
    diversified,
    rankedCandidates,
    maxCandidates,
    sampledSectionIndices,
  );
}

function applyMmrDiversityReranking(
  rankedCandidates: readonly RankedTopicCandidate[],
  maxCandidates: number,
): MutableTopicCandidateRecord[] {
  if (rankedCandidates.length === 0 || maxCandidates <= 0) {
    return [];
  }
  const maxScore = rankedCandidates[0]?.score ?? 1;
  const selected: MutableTopicCandidateRecord[] = [];
  const coveredSections = new Set<number>();
  const remaining = [...rankedCandidates];
  while (selected.length < maxCandidates && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) {
        continue;
      }
      const relevance = candidate.score / maxScore;
      const maxSimilarity =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((entry) => lexicalSimilarity(candidate.record.target, entry.target)),
            );
      if (
        selected.length > 0 &&
        maxSimilarity >= NEAR_DUPLICATE_SIMILARITY_THRESHOLD &&
        remaining.some(
          (other) =>
            other &&
            lexicalSimilarity(candidate.record.target, other.record.target) <
              NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
        )
      ) {
        continue;
      }
      const sectionNovelty = sectionCoverageNovelty(candidate.record, coveredSections);
      const mmrScore =
        MMR_RELEVANCE_WEIGHT * relevance +
        SECTION_NOVELTY_WEIGHT * sectionNovelty -
        (1 - MMR_RELEVANCE_WEIGHT) * maxSimilarity;
      if (
        mmrScore > bestScore ||
        (mmrScore === bestScore &&
          candidate.record.target.localeCompare(remaining[bestIndex]?.record.target ?? '', 'ja') <
            0)
      ) {
        bestScore = mmrScore;
        bestIndex = index;
      }
    }
    if (bestScore === Number.NEGATIVE_INFINITY) {
      break;
    }
    const next = remaining[bestIndex];
    if (!next) {
      break;
    }
    const maxSimilarityToSelected =
      selected.length === 0
        ? 0
        : Math.max(...selected.map((entry) => lexicalSimilarity(next.record.target, entry.target)));
    const hasDiverseAlternative = remaining.some(
      (alternative, index) =>
        index !== bestIndex &&
        lexicalSimilarity(next.record.target, alternative.record.target) <
          NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );
    if (
      selected.length > 0 &&
      maxSimilarityToSelected >= NEAR_DUPLICATE_SIMILARITY_THRESHOLD &&
      !hasDiverseAlternative
    ) {
      break;
    }
    remaining.splice(bestIndex, 1);
    selected.push(next.record);
    for (const sectionIndex of next.record.sectionIndices) {
      coveredSections.add(sectionIndex);
    }
  }
  return selected;
}

function ensureSampledSectionCoverage(
  selected: readonly MutableTopicCandidateRecord[],
  rankedCandidates: readonly RankedTopicCandidate[],
  maxCandidates: number,
  sampledSectionIndices: readonly number[],
): MutableTopicCandidateRecord[] {
  if (sampledSectionIndices.length === 0 || maxCandidates <= 0) {
    return [...selected];
  }
  const output = [...selected];
  let coveredSections = rebuildCoveredSections(output);
  for (const sectionIndex of sampledSectionIndices) {
    if (coveredSections.has(sectionIndex)) {
      continue;
    }
    const replacement = rankedCandidates.find(
      (candidate) =>
        candidate.record.sectionIndices.has(sectionIndex) &&
        !output.some(
          (existing) => existing.target.toLowerCase() === candidate.record.target.toLowerCase(),
        ),
    );
    if (!replacement) {
      continue;
    }
    if (output.length < maxCandidates) {
      output.push(replacement.record);
      coveredSections = rebuildCoveredSections(output);
      continue;
    }
    const swapIndex = findLowestPrioritySwappableIndex(output, rankedCandidates);
    const swapTarget = swapIndex < 0 ? undefined : output[swapIndex];
    if (swapTarget === undefined || isProtectedExplicitCandidate(swapTarget)) {
      continue;
    }
    output[swapIndex] = replacement.record;
    coveredSections = rebuildCoveredSections(output);
  }
  return output.slice(0, maxCandidates);
}

function rebuildCoveredSections(records: readonly MutableTopicCandidateRecord[]): Set<number> {
  const coveredSections = new Set<number>();
  for (const record of records) {
    for (const sectionIndex of record.sectionIndices) {
      coveredSections.add(sectionIndex);
    }
  }
  return coveredSections;
}

function isProtectedExplicitCandidate(record: MutableTopicCandidateRecord): boolean {
  return [...record.sources].some(
    (source) =>
      source === 'hashtag' ||
      source === 'meta_keywords' ||
      source === 'title' ||
      source === 'quoted_phrase',
  );
}

function findLowestPrioritySwappableIndex(
  selected: readonly MutableTopicCandidateRecord[],
  rankedCandidates: readonly RankedTopicCandidate[],
): number {
  let swapIndex = -1;
  let lowestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < selected.length; index += 1) {
    const record = selected[index];
    if (!record || isProtectedExplicitCandidate(record)) {
      continue;
    }
    if (!canSwapWithoutLosingCoverage(selected, index)) {
      continue;
    }
    const score = rankedCandidates.find(
      (candidate) => candidate.record.target === record.target,
    )?.score;
    if (score === undefined || score >= lowestScore) {
      continue;
    }
    lowestScore = score;
    swapIndex = index;
  }
  return swapIndex;
}

function canSwapWithoutLosingCoverage(
  selected: readonly MutableTopicCandidateRecord[],
  swapIndex: number,
): boolean {
  const record = selected[swapIndex];
  if (!record) {
    return false;
  }
  if (record.sectionIndices.size === 0) {
    return true;
  }
  for (const sectionIndex of record.sectionIndices) {
    const stillCovered = selected.some(
      (other, otherIndex) => otherIndex !== swapIndex && other.sectionIndices.has(sectionIndex),
    );
    if (!stillCovered) {
      return false;
    }
  }
  return true;
}

function sectionCoverageNovelty(
  record: MutableTopicCandidateRecord,
  coveredSections: ReadonlySet<number>,
): number {
  if (record.sectionIndices.size === 0) {
    return 0;
  }
  let novelty = 0;
  for (const sectionIndex of record.sectionIndices) {
    if (!coveredSections.has(sectionIndex)) {
      novelty += 1;
    }
  }
  return novelty / record.sectionIndices.size;
}

function finalizeTopicCandidateLexicon(
  records: readonly MutableTopicCandidateRecord[],
): TopicCandidateLexicon {
  const candidates: TopicCandidateRecord[] = [];
  const idToTarget = new Map<string, string>();
  for (const [index, record] of records.entries()) {
    const id = `topic-${index + 1}`;
    const evidence = buildCandidateEvidence(record);
    const candidate: TopicCandidateRecord = {
      evidence,
      frequency: record.frequency,
      id,
      sectionIndices: record.sectionIndices,
      sourcePriority: record.sourcePriority,
      sources: record.sources,
      target: record.target,
    };
    candidates.push(candidate);
    idToTarget.set(id, record.target);
  }
  return { candidates, idToTarget };
}

function buildCandidateEvidence(record: MutableTopicCandidateRecord): string {
  const source = highestPrioritySource(record.sources);
  const sections = record.sectionIndices.size;
  const evidence = `source=${source};sections=${sections};freq=${record.frequency}`;
  return evidence.length <= MAX_CANDIDATE_EVIDENCE_LENGTH
    ? evidence
    : evidence.slice(0, MAX_CANDIDATE_EVIDENCE_LENGTH);
}

function highestPrioritySource(sources: ReadonlySet<TopicCandidateSource>): TopicCandidateSource {
  let bestSource: TopicCandidateSource = 'body_lexical';
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const source of sources) {
    const priority = sourcePriority(source);
    if (priority > bestPriority) {
      bestPriority = priority;
      bestSource = source;
    }
  }
  return bestSource;
}

function lexicalSimilarity(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft === normalizedRight) {
    return 1;
  }
  const prefixSimilarity = commonPrefixSimilarity(normalizedLeft, normalizedRight);
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    const shorter = Math.min(normalizedLeft.length, normalizedRight.length);
    const longer = Math.max(normalizedLeft.length, normalizedRight.length);
    return Math.max(prefixSimilarity, shorter / longer);
  }
  const leftBigrams = characterBigrams(normalizedLeft);
  const rightBigrams = characterBigrams(normalizedRight);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) {
    return prefixSimilarity;
  }
  let intersection = 0;
  for (const bigram of leftBigrams) {
    if (rightBigrams.has(bigram)) {
      intersection += 1;
    }
  }
  const bigramSimilarity = intersection / (leftBigrams.size + rightBigrams.size - intersection);
  return Math.max(prefixSimilarity, bigramSimilarity);
}

function commonPrefixSimilarity(left: string, right: string): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left.charAt(index) === right.charAt(index)
  ) {
    index += 1;
  }
  if (index < 4) {
    return 0;
  }
  return index / Math.max(left.length, right.length);
}

function characterBigrams(value: string): Set<string> {
  const bigrams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    bigrams.add(value.slice(index, index + 2));
  }
  return bigrams;
}
