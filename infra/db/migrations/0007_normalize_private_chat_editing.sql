-- Migration: 0007_normalize_private_chat_editing
-- Purpose: Normalize stored private chat editing metadata to the current JSON schema.
-- Existing DB notes:
--   - Backfills legacy keys such as inferred_mode / question_type to camelCase keys.
--   - Rows with unknown editing mode are kept, but editing metadata is cleared.
-- Fresh DB sync:
--   - No table shape change is required for fresh DB.
--   - Add this version to the schema_migrations baseline seed.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include real personal data, OAuth tokens, API keys, or secrets.

WITH editing_defaults AS (
  SELECT *
  FROM (
    VALUES
      (
        'default',
        'unknown',
        '["収集", "選択", "引用"]'::jsonb,
        '["質問意図を特定の編集方針に寄せず、通常の根拠確認を優先します。"]'::jsonb
      ),
      (
        'issue_mapping',
        'status',
        '["分類", "比較", "境界", "焦点化"]'::jsonb,
        '["論点の分類は根拠 source の範囲に限定します。"]'::jsonb
      ),
      (
        'next_actions',
        'planning',
        '["道筋", "脚本", "統御"]'::jsonb,
        '["推奨アクションは根拠と未確認事項を分けて扱います。"]'::jsonb
      ),
      (
        'risk_scan',
        'risk',
        '["競合", "推理", "構造", "生態"]'::jsonb,
        '["リスク判断は複数 source の一致や未確認事項を優先して扱います。"]'::jsonb
      ),
      (
        'structure',
        'status',
        '["地図", "図解", "構造", "模型"]'::jsonb,
        '["構造化は source 間の関係を説明する補助であり、根拠の代替ではありません。"]'::jsonb
      ),
      (
        'summary',
        'fact',
        '["要約", "凝縮", "引用"]'::jsonb,
        '["要約は根拠 source の内容を圧縮し、未確認情報を補いません。"]'::jsonb
      ),
      (
        'timeline',
        'timeline',
        '["系統", "順番", "注釈", "場面"]'::jsonb,
        '["時系列は日付や actor hint が確認できる範囲に限定します。"]'::jsonb
      )
  ) AS defaults(inferred_mode, question_type, operations, caveats)
),
normalized_rows AS (
  SELECT
    messages.id,
    jsonb_typeof(messages.editing) = 'object' AS editing_is_object,
    COALESCE(
      messages.editing ->> 'inferredMode',
      messages.editing ->> 'inferred_mode',
      messages.editing ->> 'mode'
    ) AS inferred_mode,
    messages.editing ->> 'confidence' AS confidence
  FROM public.private_chat_messages AS messages
  WHERE messages.editing IS NOT NULL
    AND (
      jsonb_typeof(messages.editing) <> 'object'
      OR NOT (messages.editing ? 'caveats')
      OR NOT (messages.editing ? 'confidence')
      OR NOT (messages.editing ? 'inferredMode')
      OR NOT (messages.editing ? 'operations')
      OR NOT (messages.editing ? 'questionType')
      OR messages.editing ->> 'confidence' NOT IN ('high', 'low', 'medium')
      OR messages.editing ->> 'inferredMode' NOT IN (
        'default',
        'issue_mapping',
        'next_actions',
        'risk_scan',
        'structure',
        'summary',
        'timeline'
      )
      OR messages.editing ->> 'questionType' NOT IN (
        'fact',
        'planning',
        'public_explanation',
        'risk',
        'status',
        'timeline',
        'unknown'
      )
      OR jsonb_typeof(messages.editing -> 'caveats') <> 'array'
      OR jsonb_typeof(messages.editing -> 'operations') <> 'array'
    )
)
UPDATE public.private_chat_messages AS messages
SET editing = CASE
  WHEN normalized.editing_is_object AND defaults.inferred_mode IS NOT NULL THEN
    jsonb_build_object(
      'caveats',
      defaults.caveats,
      'confidence',
      CASE
        WHEN normalized.confidence IN ('high', 'low', 'medium') THEN normalized.confidence
        ELSE 'low'
      END,
      'inferredMode',
      defaults.inferred_mode,
      'operations',
      defaults.operations,
      'questionType',
      defaults.question_type
    )
  ELSE NULL
END
FROM normalized_rows AS normalized
LEFT JOIN editing_defaults AS defaults
  ON defaults.inferred_mode = normalized.inferred_mode
WHERE messages.id = normalized.id;

DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT count(*)
  INTO invalid_count
  FROM public.private_chat_messages
  WHERE editing IS NOT NULL
    AND (
      jsonb_typeof(editing) <> 'object'
      OR NOT (editing ? 'caveats')
      OR NOT (editing ? 'confidence')
      OR NOT (editing ? 'inferredMode')
      OR NOT (editing ? 'operations')
      OR NOT (editing ? 'questionType')
      OR editing ->> 'confidence' NOT IN ('high', 'low', 'medium')
      OR editing ->> 'inferredMode' NOT IN (
        'default',
        'issue_mapping',
        'next_actions',
        'risk_scan',
        'structure',
        'summary',
        'timeline'
      )
      OR editing ->> 'questionType' NOT IN (
        'fact',
        'planning',
        'public_explanation',
        'risk',
        'status',
        'timeline',
        'unknown'
      )
      OR jsonb_typeof(editing -> 'caveats') <> 'array'
      OR jsonb_typeof(editing -> 'operations') <> 'array'
    );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'private_chat_messages.editing normalization left % invalid rows', invalid_count;
  END IF;
END $$;
