import assert from 'node:assert/strict';
import {
  parseCustomReportAssetRow,
  parseCustomReportTemplateRow,
  parseReportTemplateRunRow,
} from './custom-report-repository.ts';
import {
  CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
  CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION,
  CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION,
  CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
  validateCustomReportLayout,
  validateCustomReportSnapshot,
  validateCustomReportTemplateExport,
} from './custom-report-schema.ts';
import { validatePrivateReportJson } from './report-schema.ts';

const validLayout = {
  root: {
    children: [
      {
        id: 'title',
        text: '○○さんの転職戦略',
        type: 'title',
      },
      {
        columns: [
          {
            children: [
              {
                asset_ref: 'asset-logo',
                alt_text: 'ロゴ',
                id: 'logo',
                type: 'fixed_image',
              },
            ],
            width_fraction: 0.4,
          },
          {
            children: [
              {
                id: 'strategy-slider',
                left_label: '堅実的',
                prompt: '戦略の論理性を0-100で判定してください。',
                result_key: 'strategy_logic',
                right_label: '飛躍的',
                type: 'slider_judgement',
              },
              {
                categories: [
                  {
                    asset_ref: 'asset-cheetah',
                    description: '状況を突破する戦略性が高い。',
                    key: 'cheetah',
                    title: 'チーター',
                  },
                  {
                    description: '周囲との調和を優先する。',
                    key: 'harmonizer',
                    title: '調和型',
                  },
                ],
                id: 'thinking-type',
                prompt: '思考タイプを分類してください。',
                result_key: 'thinking_type',
                type: 'classification_result',
              },
            ],
          },
        ],
        id: 'main-columns',
        type: 'columns',
      },
    ],
    id: 'root',
    type: 'row',
  },
  schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
} as const;

validateCustomReportLayout(validLayout, { allowedAssetRefs: ['asset-logo', 'asset-cheetah'] });

assert.throws(
  () =>
    validateCustomReportLayout({
      root: { id: 'plugin', module: 'file:///tmp/plugin.js', type: 'plugin' },
      schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    }),
  /part type/,
);

assert.throws(
  () =>
    validateCustomReportLayout({
      root: {
        columns: [{ children: [{ id: 'title', text: 'title', type: 'title' }] }],
        id: 'columns',
        type: 'columns',
      },
      schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    }),
  /columns/,
);

assert.throws(
  () =>
    validateCustomReportLayout({
      root: {
        columns: [
          { children: [{ id: 'left-title', text: 'left', type: 'title' }], width_fraction: 0.7 },
          { children: [{ id: 'right-title', text: 'right', type: 'title' }], width_fraction: 0.6 },
        ],
        id: 'wide-columns',
        type: 'columns',
      },
      schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    }),
  /width_fraction sum/,
);

assert.throws(
  () =>
    validateCustomReportLayout({
      root: {
        columns: [
          { children: [{ id: 'left-finite', text: 'left', type: 'title' }], width_fraction: NaN },
          {
            children: [{ id: 'right-finite', text: 'right', type: 'title' }],
            width_fraction: 0.5,
          },
        ],
        id: 'finite-columns',
        type: 'columns',
      },
      schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    }),
  /width_fraction/,
);

assert.throws(
  () => validateCustomReportLayout(validLayout, { allowedAssetRefs: ['asset-logo'] }),
  /asset reference/,
);

assert.throws(
  () =>
    validateCustomReportLayout({
      root: {
        id: 'slider',
        left_label: 'left',
        prompt: 'x'.repeat(8001),
        result_key: 'too_long',
        right_label: 'right',
        type: 'slider_judgement',
      },
      schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    }),
  /slider_judgement/,
);

const validExport = {
  assets: [
    {
      byte_size: 1024,
      content_type: 'image/png',
      display_name: 'logo.png',
      export_asset_key: 'asset-logo',
      requires_upload: true,
    },
    {
      byte_size: 2048,
      content_type: 'image/webp',
      display_name: 'cheetah.webp',
      export_asset_key: 'asset-cheetah',
      requires_upload: true,
    },
  ],
  exported_at: '2026-06-30T09:00:00.000Z',
  schema_version: CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION,
  template: {
    layout: validLayout,
    name: '転職戦略レポート',
    schema_version: CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
  },
} as const;

validateCustomReportTemplateExport(validExport);

assert.throws(
  () =>
    validateCustomReportTemplateExport({
      ...validExport,
      assets: [
        {
          byte_size: 1,
          content_type: 'text/html',
          display_name: 'x.html',
          export_asset_key: 'asset-logo',
          requires_upload: true,
        },
      ],
    }),
  /asset manifest/,
);

assert.throws(
  () =>
    validateCustomReportTemplateExport({
      ...validExport,
      assets: [
        {
          byte_size: 1,
          content_type: null,
          display_name: 'missing-content-type',
          export_asset_key: 'asset-logo',
          requires_upload: true,
        },
      ],
    }),
  /asset manifest/,
);

for (const displayName of [
  '../logo.png',
  'nested/logo.png',
  '..\\logo.png',
  'nested\\logo.png',
  'gs://bucket/logo.png',
  'logo\u0000.png',
]) {
  assert.throws(
    () =>
      validateCustomReportTemplateExport({
        ...validExport,
        assets: [
          {
            byte_size: 1,
            content_type: 'image/png',
            display_name: displayName,
            export_asset_key: 'asset-logo',
            requires_upload: true,
          },
        ],
      }),
    /asset manifest/,
  );
}

const validSnapshot = {
  layout: validLayout,
  results: {
    strategy_logic: {
      left_label: '堅実的',
      part_id: 'strategy-slider',
      reason: '根拠を比較しているため。',
      right_label: '飛躍的',
      score: 72,
      type: 'slider_judgement',
    },
    thinking_type: {
      asset_ref: 'asset-cheetah',
      category_key: 'cheetah',
      description: '状況を突破する戦略性が高い。',
      part_id: 'thinking-type',
      reason: '既成概念にとらわれない選択が多いため。',
      title: 'チーター',
      type: 'classification_result',
    },
  },
  schema_version: CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION,
  template_id: 'template-1',
  template_snapshot_hash: 'sha256:abc',
  template_version: 1,
} as const;

validateCustomReportSnapshot(validSnapshot);

assert.throws(
  () =>
    validateCustomReportSnapshot({
      ...validSnapshot,
      results: {
        strategy_logic: {
          left_label: '堅実的',
          part_id: 'strategy-slider',
          reason: 'reason',
          right_label: '飛躍的',
          score: NaN,
          type: 'slider_judgement',
        },
      },
    }),
  /slider result/,
);

assert.throws(
  () =>
    validateCustomReportSnapshot({
      ...validSnapshot,
      results: {
        thinking_type: {
          asset_ref: '',
          category_key: 'cheetah',
          description: '状況を突破する戦略性が高い。',
          part_id: 'thinking-type',
          reason: 'reason',
          title: 'チーター',
          type: 'classification_result',
        },
      },
    }),
  /asset_ref/,
);

validatePrivateReportJson({
  custom_layout: validSnapshot,
  generated_at: '2026-06-30T09:00:00.000Z',
  period: { end: '2026-06-30', start: '2026-06-24' },
  project_id: 'project-a',
  report_id: 'report-a',
  schema_version: 'v1',
  sections: [{ id: 'activity', markdown: 'body', title: '概況' }],
  summary: 'summary',
  title: 'title',
});

assert.deepEqual(
  parseCustomReportAssetRow({
    byte_size: '1024',
    content_type: 'image/png',
    created_at: '2026-06-30T09:00:00.000Z',
    created_by_user_id: null,
    display_name: 'logo.png',
    id: 'asset-1',
    object_storage_uri: 'projects/a/assets/logo.png',
    project_id: 'project-a',
    status: 'active',
    updated_at: '2026-06-30T09:00:00.000Z',
  }).status,
  'active',
);

assert.throws(
  () =>
    parseCustomReportAssetRow({
      byte_size: 1024,
      content_type: 'text/html',
      created_at: '2026-06-30T09:00:00.000Z',
      created_by_user_id: null,
      display_name: 'x.html',
      id: 'asset-1',
      object_storage_uri: 'projects/a/assets/x.html',
      project_id: 'project-a',
      status: 'active',
      updated_at: '2026-06-30T09:00:00.000Z',
    }),
  /content type/,
);

assert.equal(
  parseCustomReportTemplateRow({
    created_at: '2026-06-30T09:00:00.000Z',
    created_by_user_id: null,
    description: null,
    id: 'template-1',
    is_active: true,
    layout: validLayout,
    name: '転職戦略レポート',
    project_id: 'project-a',
    schema_version: CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
    template_version: 1,
    updated_at: '2026-06-30T09:00:00.000Z',
    updated_by_user_id: null,
  }).name,
  '転職戦略レポート',
);

assert.equal(
  parseReportTemplateRunRow({
    created_at: '2026-06-30T09:00:00.000Z',
    id: 'run-1',
    judgement_summary: {},
    layout_snapshot: validLayout,
    project_id: 'project-a',
    report_id: 'report-a',
    template_id: 'template-1',
    template_snapshot_hash: 'sha256:abc',
    template_version: 1,
  }).template_snapshot_hash,
  'sha256:abc',
);

assert.throws(
  () =>
    parseReportTemplateRunRow({
      created_at: '2026-06-30T09:00:00.000Z',
      id: 'run-1',
      judgement_summary: [],
      layout_snapshot: validLayout,
      project_id: 'project-a',
      report_id: 'report-a',
      template_id: 'template-1',
      template_snapshot_hash: 'sha256:abc',
      template_version: 1,
    }),
  /judgement_summary/,
);

console.log('web custom report schema tests passed');
