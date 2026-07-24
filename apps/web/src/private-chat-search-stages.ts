/** User-visible labels for each private chat search workflow stage. */
export const PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS = {
  preparing: { id: 'preparing', label: '検索条件を準備しています' },
  classifying: { id: 'classifying', label: '質問の見方を整理しています' },
  expanding: { id: 'expanding', label: '検索語を展開しています' },
  retrieving: { id: 'retrieving', label: '関連資料を検索しています' },
  retrying: { id: 'retrying', label: '検索語を広げて再検索しています' },
  relating: { id: 'relating', label: '関連資料を確認しています' },
  timeline: { id: 'timeline', label: '時系列を確認しています' },
  reasoning: { id: 'reasoning', label: '根拠を整理して回答を生成しています' },
} as const;

export type PrivateChatSearchStageId = keyof typeof PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS;

/** Returns the localized label for a private chat search workflow stage. */
export function privateChatSearchStageLabel(stage: PrivateChatSearchStageId): string {
  return PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS[stage].label;
}
