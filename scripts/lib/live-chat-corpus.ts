/** Synthetic facts for opt-in live Chat evaluation; never copy production data here. */
export const liveChatDocuments = [
  {
    key: 'release',
    title: 'release 42 build 17 承認記録',
    content: 'release 42 build 17 は架空担当者の青葉ミナが承認した。承認コードは SYNTH-AOBA-4217。',
    date: '2026-08-01',
  },
  {
    key: 'neighbor',
    title: 'release 420 build 17 承認記録',
    content:
      'release 420 build 17 は架空担当者の赤石ユウが承認した。承認コードは SYNTH-AKAISHI-42017。',
    date: '2026-08-02',
  },
  {
    key: 'glass',
    title: 'ガラス保管手順',
    content: 'ガラス試料は遮光箱に保管する。架空の保管庫の識別番号は SYNTH-GLASS-73。',
    date: '2026-08-03',
  },
  {
    key: 'percent',
    title: '80% 警告設定',
    content:
      'ストレージ使用率が80%に達したら架空の監視担当「若葉班」へ通知する。識別コードは SYNTH-PERCENT-80。',
    date: '2026-08-04',
  },
  {
    key: 'timeline-one',
    title: '合成移行テスト 初期決定',
    content: '合成移行テストは2026年8月5日に開始を決定した。この時点では方式Aを採用した。',
    date: '2026-08-05',
  },
  {
    key: 'timeline-two',
    title: '合成移行テスト 方針変更',
    content:
      '合成移行テストは2026年8月6日に方式Aから方式Bへ変更した。識別コードは SYNTH-MIGRATION-B。',
    date: '2026-08-06',
  },
] as const;

/** Required answer facts and sources are fixed before either provider runs. */
export const liveChatCases = [
  {
    id: 'numeric',
    question: 'release 42 build 17 の承認者と承認コードを資料に基づいて教えてください。',
    requiredTitles: ['release 42 build 17 承認記録'],
    requiredFacts: ['青葉ミナ', 'SYNTH-AOBA-4217'],
  },
  {
    id: 'japanese-typo',
    question: 'ガラズ試料の保管方法と保管庫の識別番号を資料に基づいて教えてください。',
    requiredTitles: ['ガラス保管手順'],
    requiredFacts: ['遮光箱', 'SYNTH-GLASS-73'],
  },
  {
    id: 'literal-percent',
    question: 'ストレージ使用率80%の通知先と識別コードを資料に基づいて教えてください。',
    requiredTitles: ['80% 警告設定'],
    requiredFacts: ['若葉班', 'SYNTH-PERCENT-80'],
  },
  {
    id: 'timeline',
    question:
      '2026年8月5日から2026年8月6日までの合成移行テストの方針変更を時系列で説明してください。',
    requiredTitles: ['合成移行テスト 初期決定', '合成移行テスト 方針変更'],
    requiredFacts: ['方式A', '方式B'],
  },
] as const;
