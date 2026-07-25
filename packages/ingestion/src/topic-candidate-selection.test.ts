import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTopicCandidateLexicon,
  selectSectionsAcrossDocument,
  splitBodyIntoSections,
  TopicCandidateAccumulator,
} from './topic-candidate-selection.js';

test('splitBodyIntoSections splits oversized paragraphs into fixed-size chunks', () => {
  const paragraphA = 'a'.repeat(2500);
  const paragraphB = 'b'.repeat(2500);
  const sections = splitBodyIntoSections(`${paragraphA}\n\n${paragraphB}`, 1000);
  assert.ok(sections.length >= 5);
  assert.ok(sections.every((section) => section.length <= 1000));
  assert.equal(sections.at(-1)?.includes('b'), true);
});

test('selectBalancedTopicCandidates keeps a tail-section candidate when early sections overflow the cap', () => {
  const accumulator = new TopicCandidateAccumulator();
  for (let index = 0; index < 8; index += 1) {
    accumulator.addCandidate(`early-term-${index}`, 'body_lexical', 0);
  }
  accumulator.addCandidate('tail-priority-term', 'body_lexical', 1);
  const lexicon = buildTopicCandidateLexicon(accumulator.values(), 3, [0, 1]);
  assert.ok(candidateTexts(lexicon).includes('tail-priority-term'));
});

test('ensureSampledSectionCoverage swaps in a tail candidate without losing covered sections', () => {
  const accumulator = new TopicCandidateAccumulator();
  const leader = 'shared-tail-topic';
  const alternative = 'different-early-topic';
  const tail = 'shared-tail-topics';
  for (let index = 0; index < 100; index += 1) {
    accumulator.addCandidate(leader, 'body_lexical', 0);
  }
  accumulator.addCandidate(alternative, 'body_lexical', 0);
  accumulator.addCandidate(tail, 'body_lexical', 1);
  const lexicon = buildTopicCandidateLexicon(accumulator.values(), 2, [0, 1]);
  const texts = candidateTexts(lexicon);
  assert.ok(texts.includes(leader));
  assert.ok(texts.includes(tail));
  assert.equal(texts.includes(alternative), false);
});

test('buildCandidateEvidence uses the highest-priority source for merged candidates', () => {
  const accumulator = new TopicCandidateAccumulator();
  accumulator.addCandidate('AI', 'body_lexical', 0);
  accumulator.addCandidate('AI', 'hashtag');
  const lexicon = buildTopicCandidateLexicon(accumulator.values(), 1, [0]);
  assert.match(lexicon.candidates[0]?.evidence ?? '', /source=hashtag/);
});

test('buildTopicCandidateLexicon returns an empty lexicon when maxCandidates is zero', () => {
  const accumulator = new TopicCandidateAccumulator();
  accumulator.addCandidate('AI', 'hashtag');
  const lexicon = buildTopicCandidateLexicon(accumulator.values(), 0, [0]);
  assert.deepEqual(lexicon.candidates, []);
  assert.equal(lexicon.idToTarget.size, 0);
});

test('selectSectionsAcrossDocument returns no sections when maxCharacters is zero', () => {
  const sections = splitBodyIntoSections('head'.repeat(3000), 1000);
  assert.deepEqual(selectSectionsAcrossDocument(sections, 0), []);
});

test('selectSectionsAcrossDocument returns one tail slice when maxCharacters is 1', () => {
  const sections = ['head-section', 'middle-section', 'tail-section'];
  const sampled = selectSectionsAcrossDocument(sections, 1);
  assert.deepEqual(sampled, ['n']);
  assert.equal(
    sampled.reduce((sum, section) => sum + section.length, 0),
    1,
  );
});

test('selectSectionsAcrossDocument keeps total returned length within maxCharacters', () => {
  const sections = splitBodyIntoSections(
    `${'head'.repeat(3000)}\n\n${'tail-marker'.repeat(300)}`,
    1000,
  );
  for (const budget of [1, 2, 7, 1200]) {
    const sampled = selectSectionsAcrossDocument(sections, budget);
    const totalLength = sampled.reduce((sum, section) => sum + section.length, 0);
    assert.ok(totalLength <= budget, `expected <= ${budget}, got ${totalLength}`);
  }
});

test('selectSectionsAcrossDocument samples about six sections from a large document within budget', () => {
  const sections = Array.from({ length: 100 }, (_value, index) => {
    const headMarker = index === 0 ? 'HEAD-' : '';
    const tailMarker = index === 99 ? '-TAIL' : '';
    const fillerLength = 2000 - headMarker.length - tailMarker.length;
    return `${headMarker}${'x'.repeat(fillerLength)}${tailMarker}`;
  });
  const sampled = selectSectionsAcrossDocument(sections, 12000);
  assert.ok(sampled.length < 100);
  assert.ok(sampled.length >= 5 && sampled.length <= 7);
  assert.equal(sampled[0]?.startsWith('HEAD-'), true);
  assert.ok(sampled.at(-1)?.endsWith('-TAIL'));
  assert.ok(sampled.reduce((sum, section) => sum + section.length, 0) <= 12000);
});

function candidateTexts(lexicon: { candidates: readonly { target: string }[] }): string[] {
  return lexicon.candidates.map((candidate) => candidate.target);
}

test('selectSectionsAcrossDocument includes tail slices within the analysis budget', () => {
  const sections = splitBodyIntoSections(
    `${'head'.repeat(3000)}\n\n${'tail-marker'.repeat(300)}`,
    1000,
  );
  const sampled = selectSectionsAcrossDocument(sections, 1200);
  assert.ok(sampled.some((section) => section.includes('tail-marker')));
});
