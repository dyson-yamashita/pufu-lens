'use client';

import { useMemo, useState } from 'react';
import type {
  ClassificationCategory,
  CustomReportLayoutV1,
  CustomReportPart,
  CustomReportPartType,
} from './custom-report-schema.ts';
import {
  addChildToColumn,
  addChildToRow,
  addColumn,
  collectPartIds,
  collectResultKeys,
  createDefaultPart,
  layoutToJson,
  moveChildInColumn,
  moveChildInRow,
  type PartPath,
  removeChildFromColumn,
  removeChildFromRow,
  removeColumn,
  replacePartAtPath,
  updateColumnWidthFraction,
  updateLayoutRoot,
} from './custom-report-template-editor-utils.ts';

const PART_TYPE_LABELS: Record<CustomReportPartType, string> = {
  title: '見出し',
  pufu_board: 'Pufu Board',
  fixed_text: '固定テキスト',
  fixed_image: '固定画像',
  slider_judgement: 'スライダー判定',
  classification_result: '分類結果',
  row: '行',
  columns: '列',
  divider: '区切り線',
  copyright: '著作権',
};

const ADDABLE_PART_TYPES: readonly CustomReportPartType[] = [
  'title',
  'pufu_board',
  'fixed_text',
  'fixed_image',
  'slider_judgement',
  'classification_result',
  'row',
  'columns',
  'divider',
  'copyright',
];

export function CustomReportTemplateEditor({
  initialLayout,
  testIdPrefix,
}: {
  readonly initialLayout: CustomReportLayoutV1;
  readonly testIdPrefix: string;
}) {
  const [layout, setLayout] = useState(initialLayout);
  const layoutJson = useMemo(() => layoutToJson(layout), [layout]);

  const updateRoot = (nextRoot: CustomReportPart): void => {
    setLayout((current) => updateLayoutRoot(current, nextRoot));
  };

  return (
    <div className="custom-report-layout-editor" data-testid={`${testIdPrefix}-layout-editor`}>
      <input name="layoutJson" type="hidden" value={layoutJson} />
      <div className="custom-report-layout-editor-body">
        <p className="custom-report-layout-editor-label">Layout</p>
        <PartEditor
          depth={0}
          isRoot
          layout={layout}
          onRootChange={updateRoot}
          part={layout.root}
          path={[]}
          testIdPrefix={testIdPrefix}
        />
      </div>
      <details className="custom-report-layout-json-preview">
        <summary data-testid={`${testIdPrefix}-layout-json-preview-toggle`}>JSON preview</summary>
        <textarea
          className="mono"
          data-testid={`${testIdPrefix}-layout-json-preview`}
          readOnly
          rows={12}
          value={layoutJson}
        />
      </details>
    </div>
  );
}

function PartEditor({
  depth,
  isRoot = false,
  layout,
  onRootChange,
  part,
  path,
  testIdPrefix,
}: {
  readonly depth: number;
  readonly isRoot?: boolean;
  readonly layout: CustomReportLayoutV1;
  readonly onRootChange: (root: CustomReportPart) => void;
  readonly part: CustomReportPart;
  readonly path: PartPath;
  readonly testIdPrefix: string;
}) {
  const partTestId = `${testIdPrefix}-part-${part.id}`;

  const replaceSelf = (nextPart: CustomReportPart): void => {
    onRootChange(replacePartAtPath(layout.root, path, nextPart));
  };

  const updateSelf = (updater: (current: CustomReportPart) => CustomReportPart): void => {
    replaceSelf(updater(part));
  };

  return (
    <article
      className="custom-report-part-card"
      data-part-type={part.type}
      data-testid={partTestId}
      style={{ marginInlineStart: `${Math.min(depth, 4) * 12}px` }}
    >
      <header className="custom-report-part-header">
        <span className="custom-report-part-type">{PART_TYPE_LABELS[part.type]}</span>
        <span className="custom-report-part-id mono">{part.id}</span>
      </header>

      <PartFields part={part} testIdPrefix={partTestId} updateSelf={updateSelf} />

      {part.type === 'row' ? (
        <ContainerChildrenEditor
          canRemoveChild={(childCount) => !isRoot || childCount > 1}
          childrenParts={part.children}
          depth={depth}
          layout={layout}
          onAdd={(type) => {
            const ids = collectPartIds(layout);
            const resultKeys = collectResultKeys(layout);
            const child = createDefaultPart(type, ids, resultKeys);
            onRootChange(addChildToRow(layout.root, path, child));
          }}
          onMove={(childIndex, direction) => {
            onRootChange(moveChildInRow(layout.root, path, childIndex, direction));
          }}
          onRemove={(childIndex) => {
            onRootChange(removeChildFromRow(layout.root, path, childIndex));
          }}
          onRootChange={onRootChange}
          parentPath={path}
          testIdPrefix={partTestId}
        />
      ) : null}

      {part.type === 'columns' ? (
        <ColumnsEditor
          depth={depth}
          layout={layout}
          onRootChange={onRootChange}
          parentPath={path}
          part={part}
          testIdPrefix={partTestId}
        />
      ) : null}
    </article>
  );
}

function PartFields({
  part,
  testIdPrefix,
  updateSelf,
}: {
  readonly part: CustomReportPart;
  readonly testIdPrefix: string;
  readonly updateSelf: (updater: (current: CustomReportPart) => CustomReportPart) => void;
}) {
  switch (part.type) {
    case 'title':
      return (
        <div className="custom-report-part-fields">
          <label>
            <span>Text</span>
            <input
              data-testid={`${testIdPrefix}-text-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'title' ? { ...current, text: event.target.value } : current,
                )
              }
              type="text"
              value={part.text}
            />
          </label>
          <label>
            <span>Level</span>
            <select
              data-testid={`${testIdPrefix}-level-select`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'title'
                    ? {
                        ...current,
                        level: Number(event.target.value) as 1 | 2 | 3,
                      }
                    : current,
                )
              }
              value={part.level ?? 2}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
        </div>
      );
    case 'pufu_board':
      return (
        <div className="custom-report-part-fields">
          <label>
            <span>Source</span>
            <select
              data-testid={`${testIdPrefix}-source-select`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'pufu_board'
                    ? {
                        ...current,
                        source: event.target.value as 'report_pufu_sources' | 'report_sections',
                      }
                    : current,
                )
              }
              value={part.source ?? 'report_pufu_sources'}
            >
              <option value="report_pufu_sources">report_pufu_sources</option>
              <option value="report_sections">report_sections</option>
            </select>
          </label>
        </div>
      );
    case 'fixed_text':
      return (
        <div className="custom-report-part-fields">
          <label className="custom-report-field-wide">
            <span>Text</span>
            <textarea
              data-testid={`${testIdPrefix}-text-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'fixed_text'
                    ? { ...current, text: event.target.value }
                    : current,
                )
              }
              rows={3}
              value={part.text}
            />
          </label>
          <label className="custom-report-checkbox-field">
            <input
              checked={part.markdown ?? false}
              data-testid={`${testIdPrefix}-markdown-checkbox`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'fixed_text'
                    ? { ...current, markdown: event.target.checked }
                    : current,
                )
              }
              type="checkbox"
            />
            <span>Markdown</span>
          </label>
        </div>
      );
    case 'fixed_image':
      return (
        <div className="custom-report-part-fields">
          <label>
            <span>Asset ref</span>
            <input
              data-testid={`${testIdPrefix}-asset-ref-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'fixed_image'
                    ? { ...current, asset_ref: event.target.value }
                    : current,
                )
              }
              type="text"
              value={part.asset_ref}
            />
          </label>
          <label>
            <span>Alt text</span>
            <input
              data-testid={`${testIdPrefix}-alt-text-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'fixed_image'
                    ? { ...current, alt_text: event.target.value }
                    : current,
                )
              }
              type="text"
              value={part.alt_text}
            />
          </label>
          <label>
            <span>Caption</span>
            <input
              data-testid={`${testIdPrefix}-caption-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'fixed_image'
                    ? { ...current, caption: event.target.value || undefined }
                    : current,
                )
              }
              type="text"
              value={part.caption ?? ''}
            />
          </label>
        </div>
      );
    case 'slider_judgement':
      return (
        <div className="custom-report-part-fields">
          <label>
            <span>Result key</span>
            <input
              data-testid={`${testIdPrefix}-result-key-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'slider_judgement'
                    ? { ...current, result_key: event.target.value }
                    : current,
                )
              }
              type="text"
              value={part.result_key}
            />
          </label>
          <label>
            <span>Left label</span>
            <input
              data-testid={`${testIdPrefix}-left-label-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'slider_judgement'
                    ? { ...current, left_label: event.target.value }
                    : current,
                )
              }
              type="text"
              value={part.left_label}
            />
          </label>
          <label>
            <span>Right label</span>
            <input
              data-testid={`${testIdPrefix}-right-label-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'slider_judgement'
                    ? { ...current, right_label: event.target.value }
                    : current,
                )
              }
              type="text"
              value={part.right_label}
            />
          </label>
          <label className="custom-report-field-wide">
            <span>Prompt</span>
            <textarea
              data-testid={`${testIdPrefix}-prompt-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'slider_judgement'
                    ? { ...current, prompt: event.target.value }
                    : current,
                )
              }
              rows={3}
              value={part.prompt}
            />
          </label>
        </div>
      );
    case 'classification_result':
      return (
        <ClassificationEditor part={part} testIdPrefix={testIdPrefix} updateSelf={updateSelf} />
      );
    case 'copyright':
      return (
        <div className="custom-report-part-fields">
          <label>
            <span>Text</span>
            <input
              data-testid={`${testIdPrefix}-text-input`}
              onChange={(event) =>
                updateSelf((current) =>
                  current.type === 'copyright' ? { ...current, text: event.target.value } : current,
                )
              }
              type="text"
              value={part.text}
            />
          </label>
        </div>
      );
    case 'divider':
      return <p className="custom-report-part-empty-note">区切り線（追加設定なし）</p>;
    case 'row':
    case 'columns':
      return null;
  }
}

function ClassificationEditor({
  part,
  testIdPrefix,
  updateSelf,
}: {
  readonly part: Extract<CustomReportPart, { type: 'classification_result' }>;
  readonly testIdPrefix: string;
  readonly updateSelf: (updater: (current: CustomReportPart) => CustomReportPart) => void;
}) {
  const updateCategory = (
    index: number,
    updater: (category: ClassificationCategory) => ClassificationCategory,
  ): void => {
    updateSelf((current) => {
      if (current.type !== 'classification_result') {
        return current;
      }
      const categories = current.categories.map((category, idx) =>
        idx === index ? updater(category) : category,
      );
      return { ...current, categories };
    });
  };

  const addCategory = (): void => {
    updateSelf((current) => {
      if (current.type !== 'classification_result') {
        return current;
      }
      const nextIndex = current.categories.length + 1;
      const key = nextCategoryKey(current.categories);
      return {
        ...current,
        categories: [
          ...current.categories,
          {
            key,
            title: `カテゴリ ${nextIndex}`,
            description: '',
          },
        ],
      };
    });
  };

  const removeCategory = (index: number): void => {
    updateSelf((current) => {
      if (current.type !== 'classification_result' || current.categories.length <= 2) {
        return current;
      }
      return {
        ...current,
        categories: current.categories.filter((_, idx) => idx !== index),
      };
    });
  };

  return (
    <div className="custom-report-part-fields">
      <label>
        <span>Result key</span>
        <input
          data-testid={`${testIdPrefix}-result-key-input`}
          onChange={(event) =>
            updateSelf((current) =>
              current.type === 'classification_result'
                ? { ...current, result_key: event.target.value }
                : current,
            )
          }
          type="text"
          value={part.result_key}
        />
      </label>
      <label className="custom-report-field-wide">
        <span>Prompt</span>
        <textarea
          data-testid={`${testIdPrefix}-prompt-input`}
          onChange={(event) =>
            updateSelf((current) =>
              current.type === 'classification_result'
                ? { ...current, prompt: event.target.value }
                : current,
            )
          }
          rows={3}
          value={part.prompt}
        />
      </label>
      <div className="custom-report-category-list">
        <p className="custom-report-category-list-title">Categories</p>
        {part.categories.map((category, index) => (
          <div
            className="custom-report-category-card"
            data-testid={`${testIdPrefix}-category-${index}`}
            key={positionKey('category', index)}
          >
            <div className="custom-report-category-header">
              <span>Category {index + 1}</span>
              <button
                className="secondary-button custom-report-icon-button"
                data-testid={`${testIdPrefix}-remove-category-${index}-button`}
                disabled={part.categories.length <= 2}
                onClick={() => removeCategory(index)}
                type="button"
              >
                Remove
              </button>
            </div>
            <label>
              <span>Key</span>
              <input
                data-testid={`${testIdPrefix}-category-${index}-key-input`}
                onChange={(event) =>
                  updateCategory(index, (current) => ({ ...current, key: event.target.value }))
                }
                type="text"
                value={category.key}
              />
            </label>
            <label>
              <span>Title</span>
              <input
                data-testid={`${testIdPrefix}-category-${index}-title-input`}
                onChange={(event) =>
                  updateCategory(index, (current) => ({ ...current, title: event.target.value }))
                }
                type="text"
                value={category.title}
              />
            </label>
            <label className="custom-report-field-wide">
              <span>Description</span>
              <textarea
                data-testid={`${testIdPrefix}-category-${index}-description-input`}
                onChange={(event) =>
                  updateCategory(index, (current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                rows={2}
                value={category.description}
              />
            </label>
            <label>
              <span>Asset ref (optional)</span>
              <input
                data-testid={`${testIdPrefix}-category-${index}-asset-ref-input`}
                onChange={(event) =>
                  updateCategory(index, (current) => ({
                    ...current,
                    asset_ref: event.target.value || undefined,
                  }))
                }
                type="text"
                value={category.asset_ref ?? ''}
              />
            </label>
          </div>
        ))}
        <button
          className="secondary-button"
          data-testid={`${testIdPrefix}-add-category-button`}
          onClick={addCategory}
          type="button"
        >
          Add category
        </button>
      </div>
    </div>
  );
}

function ColumnsEditor({
  depth,
  layout,
  onRootChange,
  parentPath,
  part,
  testIdPrefix,
}: {
  readonly depth: number;
  readonly layout: CustomReportLayoutV1;
  readonly onRootChange: (root: CustomReportPart) => void;
  readonly parentPath: PartPath;
  readonly part: Extract<CustomReportPart, { type: 'columns' }>;
  readonly testIdPrefix: string;
}) {
  return (
    <div className="custom-report-columns-editor">
      <div className="custom-report-columns-toolbar">
        <button
          className="secondary-button"
          data-testid={`${testIdPrefix}-add-column-button`}
          disabled={part.columns.length >= 4}
          onClick={() => onRootChange(addColumn(layout.root, parentPath, layout))}
          type="button"
        >
          Add column
        </button>
      </div>
      <div className="custom-report-columns-grid">
        {part.columns.map((column, columnIndex) => (
          <div
            className="custom-report-column-card"
            data-testid={`${testIdPrefix}-column-${columnIndex}`}
            key={positionKey('column', columnIndex)}
          >
            <header className="custom-report-column-header">
              <span>Column {columnIndex + 1}</span>
              <button
                className="secondary-button custom-report-icon-button"
                data-testid={`${testIdPrefix}-remove-column-${columnIndex}-button`}
                disabled={part.columns.length <= 2}
                onClick={() => onRootChange(removeColumn(layout.root, parentPath, columnIndex))}
                type="button"
              >
                Remove column
              </button>
            </header>
            <label>
              <span>Width fraction</span>
              <input
                data-testid={`${testIdPrefix}-column-${columnIndex}-width-input`}
                max={1}
                min={0.01}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (!raw) {
                    onRootChange(
                      updateColumnWidthFraction(layout.root, parentPath, columnIndex, undefined),
                    );
                    return;
                  }
                  const widthFraction = Number(raw);
                  if (!Number.isFinite(widthFraction)) {
                    return;
                  }
                  const clampedWidthFraction = Math.min(1, Math.max(0.01, widthFraction));
                  onRootChange(
                    updateColumnWidthFraction(
                      layout.root,
                      parentPath,
                      columnIndex,
                      clampedWidthFraction,
                    ),
                  );
                }}
                step={0.05}
                type="number"
                value={column.width_fraction ?? ''}
              />
            </label>
            <ContainerChildrenEditor
              canRemoveChild={() => column.children.length > 1}
              childrenParts={column.children}
              columnIndex={columnIndex}
              depth={depth + 1}
              layout={layout}
              onAdd={(type) => {
                const ids = collectPartIds(layout);
                const resultKeys = collectResultKeys(layout);
                const child = createDefaultPart(type, ids, resultKeys);
                onRootChange(addChildToColumn(layout.root, parentPath, columnIndex, child));
              }}
              onMove={(childIndex, direction) => {
                onRootChange(
                  moveChildInColumn(layout.root, parentPath, columnIndex, childIndex, direction),
                );
              }}
              onRemove={(childIndex) => {
                onRootChange(
                  removeChildFromColumn(layout.root, parentPath, columnIndex, childIndex),
                );
              }}
              onRootChange={onRootChange}
              parentPath={parentPath}
              testIdPrefix={`${testIdPrefix}-column-${columnIndex}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function nextCategoryKey(categories: readonly ClassificationCategory[]): string {
  const keys = new Set(categories.map((category) => category.key));
  for (let index = categories.length + 1; index < categories.length + 100; index += 1) {
    const key = `category_${index}`;
    if (!keys.has(key)) {
      return key;
    }
  }
  return `category_${Date.now()}`;
}

function positionKey(prefix: 'category' | 'column', position: number): string {
  return `${prefix}-${position}`;
}

function ContainerChildrenEditor({
  canRemoveChild,
  childrenParts,
  columnIndex,
  depth,
  layout,
  onAdd,
  onMove,
  onRemove,
  onRootChange,
  parentPath,
  testIdPrefix,
}: {
  readonly canRemoveChild: (childCount: number) => boolean;
  readonly childrenParts: readonly CustomReportPart[];
  readonly columnIndex?: number;
  readonly depth: number;
  readonly layout: CustomReportLayoutV1;
  readonly onAdd: (type: CustomReportPartType) => void;
  readonly onMove: (childIndex: number, direction: -1 | 1) => void;
  readonly onRemove: (childIndex: number) => void;
  readonly onRootChange: (root: CustomReportPart) => void;
  readonly parentPath: PartPath;
  readonly testIdPrefix: string;
}) {
  return (
    <div className="custom-report-children-editor">
      <div className="custom-report-add-part-toolbar">
        {ADDABLE_PART_TYPES.map((type) => (
          <button
            className="secondary-button custom-report-add-part-button"
            data-testid={`${testIdPrefix}-add-${type.replaceAll('_', '-')}-button`}
            key={type}
            onClick={() => onAdd(type)}
            type="button"
          >
            + {PART_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <div className="custom-report-children-list">
        {childrenParts.map((child, childIndex) => {
          const childPath =
            columnIndex === undefined
              ? ([...parentPath, 'children', childIndex] as PartPath)
              : ([...parentPath, 'columns', columnIndex, 'children', childIndex] as PartPath);
          return (
            <div className="custom-report-child-wrap" key={child.id}>
              <div className="custom-report-child-actions">
                <button
                  aria-label="Move part up"
                  className="secondary-button custom-report-icon-button"
                  data-testid={`${testIdPrefix}-move-up-${childIndex}-button`}
                  disabled={childIndex === 0}
                  onClick={() => onMove(childIndex, -1)}
                  title="Move part up"
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label="Move part down"
                  className="secondary-button custom-report-icon-button"
                  data-testid={`${testIdPrefix}-move-down-${childIndex}-button`}
                  disabled={childIndex === childrenParts.length - 1}
                  onClick={() => onMove(childIndex, 1)}
                  title="Move part down"
                  type="button"
                >
                  ↓
                </button>
                <button
                  className="secondary-button custom-report-icon-button"
                  data-testid={`${testIdPrefix}-remove-${childIndex}-button`}
                  disabled={!canRemoveChild(childrenParts.length)}
                  onClick={() => onRemove(childIndex)}
                  type="button"
                >
                  Remove
                </button>
              </div>
              <PartEditor
                depth={depth + 1}
                layout={layout}
                onRootChange={onRootChange}
                part={child}
                path={childPath}
                testIdPrefix={testIdPrefix}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
