import {
  type ClassificationCategory,
  CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
  type CustomReportColumn,
  type CustomReportLayoutV1,
  type CustomReportPart,
  type CustomReportPartType,
} from './custom-report-schema.ts';

let idCounter = 0;

export function resetEditorIdCounter(): void {
  idCounter = 0;
}

export function generateSafeId(existingIds: ReadonlySet<string>, prefix = 'part'): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    idCounter += 1;
    const candidate = `${prefix}-${idCounter}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to generate a unique part id.');
}

export function generateSafeResultKey(
  existingKeys: ReadonlySet<string>,
  prefix = 'result',
): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    idCounter += 1;
    const candidate = `${prefix}_${idCounter}`;
    if (!existingKeys.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to generate a unique result key.');
}

export function collectPartIds(layout: CustomReportLayoutV1): Set<string> {
  const ids = new Set<string>();
  walkParts(layout.root, (part) => {
    ids.add(part.id);
  });
  return ids;
}

export function collectResultKeys(layout: CustomReportLayoutV1): Set<string> {
  const keys = new Set<string>();
  walkParts(layout.root, (part) => {
    if (part.type === 'slider_judgement' || part.type === 'classification_result') {
      keys.add(part.result_key);
    }
  });
  return keys;
}

export function createDefaultPart(
  type: CustomReportPartType,
  existingIds: ReadonlySet<string>,
  existingResultKeys: ReadonlySet<string>,
): CustomReportPart {
  const id = generateSafeId(existingIds);
  switch (type) {
    case 'title':
      return { id, type: 'title', level: 2, text: '見出し' };
    case 'pufu_board':
      return { id, type: 'pufu_board', source: 'report_pufu_sources' };
    case 'fixed_text':
      return { id, type: 'fixed_text', text: '固定テキスト', markdown: false };
    case 'fixed_image':
      return {
        id,
        type: 'fixed_image',
        asset_ref: 'asset-example',
        alt_text: '画像',
      };
    case 'slider_judgement':
      return {
        id,
        type: 'slider_judgement',
        result_key: generateSafeResultKey(existingResultKeys),
        left_label: '左',
        right_label: '右',
        prompt: '判定プロンプトを入力してください。',
      };
    case 'classification_result':
      return {
        id,
        type: 'classification_result',
        result_key: generateSafeResultKey(existingResultKeys),
        prompt: '分類プロンプトを入力してください。',
        categories: [
          createDefaultCategory('category_a', 'カテゴリ A'),
          createDefaultCategory('category_b', 'カテゴリ B'),
        ],
      };
    case 'row':
      return {
        id,
        type: 'row',
        children: [createDefaultPart('title', existingIds, existingResultKeys)],
      };
    case 'columns':
      return {
        id,
        type: 'columns',
        columns: [
          {
            width_fraction: 0.5,
            children: [createDefaultPart('fixed_text', existingIds, existingResultKeys)],
          },
          {
            width_fraction: 0.5,
            children: [createDefaultPart('fixed_text', existingIds, existingResultKeys)],
          },
        ],
      };
    case 'divider':
      return { id, type: 'divider' };
    case 'copyright':
      return { id, type: 'copyright', text: '© Pufu Lens' };
  }
}

function createDefaultCategory(key: string, title: string): ClassificationCategory {
  return { key, title, description: '' };
}

export function createDefaultLayout(): CustomReportLayoutV1 {
  resetEditorIdCounter();
  const ids = new Set<string>();
  const resultKeys = new Set<string>();
  return {
    schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    root: createDefaultPart('row', ids, resultKeys) as CustomReportLayoutV1['root'],
  };
}

export type PartPath = readonly (string | number)[];

export function updateLayoutRoot(
  layout: CustomReportLayoutV1,
  root: CustomReportPart,
): CustomReportLayoutV1 {
  return { ...layout, root };
}

export function updatePartAtPath(
  root: CustomReportPart,
  path: PartPath,
  updater: (part: CustomReportPart) => CustomReportPart,
): CustomReportPart {
  if (path.length === 0) {
    return updater(root);
  }
  const [head, ...tail] = path;
  if (head === 'children' && root.type === 'row') {
    const index = tail[0] as number;
    const rest = tail.slice(1);
    const child = root.children[index];
    if (!child) {
      throw new Error(`Missing row child at index ${index}.`);
    }
    const children = [...root.children];
    children[index] = updatePartAtPath(child, rest, updater);
    return { ...root, children };
  }
  if (head === 'columns' && root.type === 'columns') {
    if (tail.length < 3 || tail[1] !== 'children') {
      throw new Error(
        `Invalid column path: expected columns.<index>.children.<index>, got ${path.join('.')}`,
      );
    }
    const columnIndex = tail[0];
    if (typeof columnIndex !== 'number' || columnIndex < 0 || columnIndex >= root.columns.length) {
      throw new Error(`Missing column at index ${columnIndex}.`);
    }
    const childIndex = tail[2] as number;
    const rest = tail.slice(3);
    const columns = root.columns.map((column, idx) => {
      if (idx !== columnIndex) {
        return column;
      }
      const columnChild = column.children[childIndex];
      if (!columnChild) {
        throw new Error(`Missing column child at index ${childIndex}.`);
      }
      const children = [...column.children];
      children[childIndex] = updatePartAtPath(columnChild, rest, updater);
      return { ...column, children };
    });
    return { ...root, columns };
  }
  throw new Error(`Invalid part path: ${path.join('.')}`);
}

export function replacePartAtPath(
  root: CustomReportPart,
  path: PartPath,
  nextPart: CustomReportPart,
): CustomReportPart {
  if (path.length === 0) {
    return nextPart;
  }
  const [head, ...tail] = path;
  if (head === 'children' && root.type === 'row') {
    const index = tail[0] as number;
    const rest = tail.slice(1);
    const child = root.children[index];
    if (!child) {
      throw new Error(`Missing row child at index ${index}.`);
    }
    const children = [...root.children];
    children[index] = rest.length === 0 ? nextPart : replacePartAtPath(child, rest, nextPart);
    return { ...root, children };
  }
  if (head === 'columns' && root.type === 'columns') {
    const columnIndex = tail[0];
    if (typeof columnIndex !== 'number' || columnIndex < 0 || columnIndex >= root.columns.length) {
      throw new Error(`Missing column at index ${columnIndex}.`);
    }
    if (tail[1] === 'children') {
      const childIndex = tail[2] as number;
      const rest = tail.slice(3);
      const columns = root.columns.map((column, idx) => {
        if (idx !== columnIndex) {
          return column;
        }
        const columnChild = column.children[childIndex];
        if (!columnChild) {
          throw new Error(`Missing column child at index ${childIndex}.`);
        }
        const children = [...column.children];
        children[childIndex] =
          rest.length === 0 ? nextPart : replacePartAtPath(columnChild, rest, nextPart);
        return { ...column, children };
      });
      return { ...root, columns };
    }
  }
  throw new Error(`Invalid part path: ${path.join('.')}`);
}

export function addChildToRow(
  root: CustomReportPart,
  path: PartPath,
  child: CustomReportPart,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'row') {
      throw new Error('Expected row container.');
    }
    return { ...part, children: [...part.children, child] };
  });
}

export function addChildToColumn(
  root: CustomReportPart,
  path: PartPath,
  columnIndex: number,
  child: CustomReportPart,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'columns') {
      throw new Error('Expected columns container.');
    }
    const columns = part.columns.map((column, idx) =>
      idx === columnIndex ? { ...column, children: [...column.children, child] } : column,
    );
    return { ...part, columns };
  });
}

export function removeChildFromRow(
  root: CustomReportPart,
  path: PartPath,
  childIndex: number,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'row') {
      throw new Error('Expected row container.');
    }
    if (part.children.length <= 1) {
      return part;
    }
    return { ...part, children: part.children.filter((_, idx) => idx !== childIndex) };
  });
}

export function removeChildFromColumn(
  root: CustomReportPart,
  path: PartPath,
  columnIndex: number,
  childIndex: number,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'columns') {
      throw new Error('Expected columns container.');
    }
    const columns = part.columns.map((column, idx) => {
      if (idx !== columnIndex) {
        return column;
      }
      if (column.children.length <= 1) {
        return column;
      }
      return { ...column, children: column.children.filter((_, i) => i !== childIndex) };
    });
    return { ...part, columns };
  });
}

export function moveChildInRow(
  root: CustomReportPart,
  path: PartPath,
  childIndex: number,
  direction: -1 | 1,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'row') {
      throw new Error('Expected row container.');
    }
    const targetIndex = childIndex + direction;
    if (targetIndex < 0 || targetIndex >= part.children.length) {
      return part;
    }
    const children = [...part.children];
    const moved = children[childIndex];
    if (!moved) {
      return part;
    }
    children.splice(childIndex, 1);
    children.splice(targetIndex, 0, moved);
    return { ...part, children };
  });
}

export function moveChildInColumn(
  root: CustomReportPart,
  path: PartPath,
  columnIndex: number,
  childIndex: number,
  direction: -1 | 1,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'columns') {
      throw new Error('Expected columns container.');
    }
    const columns = part.columns.map((column, idx) => {
      if (idx !== columnIndex) {
        return column;
      }
      const targetIndex = childIndex + direction;
      if (targetIndex < 0 || targetIndex >= column.children.length) {
        return column;
      }
      const children = [...column.children];
      const moved = children[childIndex];
      if (!moved) {
        return column;
      }
      children.splice(childIndex, 1);
      children.splice(targetIndex, 0, moved);
      return { ...column, children };
    });
    return { ...part, columns };
  });
}

export function addColumn(
  root: CustomReportPart,
  path: PartPath,
  layout: CustomReportLayoutV1,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'columns') {
      throw new Error('Expected columns container.');
    }
    if (part.columns.length >= 4) {
      return part;
    }
    const ids = collectPartIds(layout);
    const resultKeys = collectResultKeys(layout);
    const nextColumns = [
      ...part.columns,
      {
        children: [createDefaultPart('fixed_text', ids, resultKeys)],
      },
    ];
    return {
      ...part,
      columns: withEqualColumnWidths(nextColumns),
    };
  });
}

export function removeColumn(
  root: CustomReportPart,
  path: PartPath,
  columnIndex: number,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'columns') {
      throw new Error('Expected columns container.');
    }
    if (part.columns.length <= 2) {
      return part;
    }
    if (columnIndex < 0 || columnIndex >= part.columns.length) {
      return part;
    }
    const nextColumns = part.columns.filter((_, idx) => idx !== columnIndex);
    return {
      ...part,
      columns: withEqualColumnWidths(nextColumns),
    };
  });
}

function withEqualColumnWidths(
  columns: readonly Omit<CustomReportColumn, 'width_fraction'>[],
): readonly CustomReportColumn[] {
  const width_fraction = 1 / columns.length;
  return columns.map((column) => ({ ...column, width_fraction }));
}

export function updateColumnWidthFraction(
  root: CustomReportPart,
  path: PartPath,
  columnIndex: number,
  widthFraction: number | undefined,
): CustomReportPart {
  return updatePartAtPath(root, path, (part) => {
    if (part.type !== 'columns') {
      throw new Error('Expected columns container.');
    }
    const columns = part.columns.map((column, idx) =>
      idx === columnIndex ? { ...column, width_fraction: widthFraction } : column,
    );
    return { ...part, columns };
  });
}

export function layoutToJson(layout: CustomReportLayoutV1): string {
  return JSON.stringify(layout, null, 2);
}

export type ContainerRef =
  | {
      readonly columnIndex?: undefined;
      readonly containerPath: PartPath;
      readonly kind: 'row';
    }
  | {
      readonly columnIndex: number;
      readonly containerPath: PartPath;
      readonly kind: 'column';
    };

export type PartRef = ContainerRef & {
  readonly childIndex: number;
};

const DRAG_MIME = 'application/x-custom-report-part';

export function encodePartRef(ref: PartRef): string {
  return JSON.stringify(ref);
}

export function decodePartRef(value: string): PartRef | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as PartRef;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed.kind !== 'row' && parsed.kind !== 'column') ||
      !Array.isArray(parsed.containerPath) ||
      typeof parsed.childIndex !== 'number'
    ) {
      return null;
    }
    if (parsed.kind === 'column' && typeof parsed.columnIndex !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getDragMimeType(): string {
  return DRAG_MIME;
}

export function getPartAtPath(
  root: CustomReportPart,
  path: PartPath,
): CustomReportPart | undefined {
  if (path.length === 0) {
    return root;
  }
  let current: CustomReportPart = root;
  let index = 0;
  while (index < path.length) {
    const segment = path[index];
    if (segment === 'children' && current.type === 'row') {
      const childIndex = path[index + 1];
      if (typeof childIndex !== 'number') {
        return undefined;
      }
      const next = current.children[childIndex];
      if (!next) {
        return undefined;
      }
      current = next;
      index += 2;
      continue;
    }
    if (segment === 'columns' && current.type === 'columns') {
      const columnIndex = path[index + 1];
      if (typeof columnIndex !== 'number' || path[index + 2] !== 'children') {
        return undefined;
      }
      const childIndex = path[index + 3];
      if (typeof childIndex !== 'number') {
        return undefined;
      }
      const next = current.columns[columnIndex]?.children[childIndex];
      if (!next) {
        return undefined;
      }
      current = next;
      index += 4;
      continue;
    }
    return undefined;
  }
  return current;
}

export function containerRefKey(ref: ContainerRef): string {
  if (ref.kind === 'row') {
    return `row:${ref.containerPath.join('.')}`;
  }
  return `column:${ref.containerPath.join('.')}:${ref.columnIndex}`;
}

export function containerRefsEqual(a: ContainerRef, b: ContainerRef): boolean {
  return containerRefKey(a) === containerRefKey(b);
}

export function getContainerChildCount(root: CustomReportPart, ref: ContainerRef): number {
  const container = getPartAtPath(root, ref.containerPath);
  if (!container) {
    return 0;
  }
  if (ref.kind === 'row' && container.type === 'row') {
    return container.children.length;
  }
  if (ref.kind === 'column' && container.type === 'columns') {
    return container.columns[ref.columnIndex]?.children.length ?? 0;
  }
  return 0;
}

export function moveLayoutPart(
  root: CustomReportPart,
  from: PartRef,
  toContainer: ContainerRef,
  toIndex: number,
): CustomReportPart {
  const sourceCount = getContainerChildCount(root, from);
  if (sourceCount <= 0) {
    return root;
  }
  const sameContainer = containerRefsEqual(from, toContainer);
  if (sourceCount <= 1 && !sameContainer) {
    return root;
  }

  const partToMove = getPartRefChild(root, from);
  if (!partToMove) {
    return root;
  }
  const sourcePartPath = partRefPath(from);
  if (isSameOrDescendantPath(toContainer.containerPath, sourcePartPath)) {
    return root;
  }

  if (sameContainer) {
    if (from.childIndex === toIndex || from.childIndex + 1 === toIndex) {
      return root;
    }
  }

  let nextRoot = removePartFromContainer(root, from);
  let insertIndex = toIndex;
  if (sameContainer && from.childIndex < toIndex) {
    insertIndex -= 1;
  }
  nextRoot = insertPartIntoContainer(nextRoot, toContainer, insertIndex, partToMove);
  return nextRoot;
}

function partRefPath(ref: PartRef): PartPath {
  if (ref.kind === 'row') {
    return [...ref.containerPath, 'children', ref.childIndex];
  }
  return [...ref.containerPath, 'columns', ref.columnIndex, 'children', ref.childIndex];
}

function isSameOrDescendantPath(path: PartPath, ancestorPath: PartPath): boolean {
  if (path.length < ancestorPath.length) {
    return false;
  }
  return ancestorPath.every((segment, index) => path[index] === segment);
}

function getPartRefChild(root: CustomReportPart, ref: PartRef): CustomReportPart | undefined {
  const container = getPartAtPath(root, ref.containerPath);
  if (!container) {
    return undefined;
  }
  if (ref.kind === 'row' && container.type === 'row') {
    return container.children[ref.childIndex];
  }
  if (ref.kind === 'column' && container.type === 'columns') {
    return container.columns[ref.columnIndex]?.children[ref.childIndex];
  }
  return undefined;
}

function removePartFromContainer(root: CustomReportPart, from: PartRef): CustomReportPart {
  return updatePartAtPath(root, from.containerPath, (part) => {
    if (from.kind === 'row' && part.type === 'row') {
      return {
        ...part,
        children: part.children.filter((_, index) => index !== from.childIndex),
      };
    }
    if (from.kind === 'column' && part.type === 'columns') {
      return {
        ...part,
        columns: part.columns.map((column, index) =>
          index === from.columnIndex
            ? {
                ...column,
                children: column.children.filter((_, childIndex) => childIndex !== from.childIndex),
              }
            : column,
        ),
      };
    }
    return part;
  });
}

function insertPartIntoContainer(
  root: CustomReportPart,
  toContainer: ContainerRef,
  toIndex: number,
  child: CustomReportPart,
): CustomReportPart {
  return updatePartAtPath(root, toContainer.containerPath, (part) => {
    if (toContainer.kind === 'row' && part.type === 'row') {
      const children = [...part.children];
      children.splice(clampIndex(toIndex, children.length), 0, child);
      return { ...part, children };
    }
    if (toContainer.kind === 'column' && part.type === 'columns') {
      return {
        ...part,
        columns: part.columns.map((column, index) => {
          if (index !== toContainer.columnIndex) {
            return column;
          }
          const children = [...column.children];
          children.splice(clampIndex(toIndex, children.length), 0, child);
          return { ...column, children };
        }),
      };
    }
    return part;
  });
}

function clampIndex(index: number, length: number): number {
  if (index < 0) {
    return 0;
  }
  if (index > length) {
    return length;
  }
  return index;
}

function walkParts(part: CustomReportPart, visit: (part: CustomReportPart) => void): void {
  visit(part);
  if (part.type === 'row') {
    for (const child of part.children) {
      walkParts(child, visit);
    }
  } else if (part.type === 'columns') {
    for (const column of part.columns) {
      for (const child of column.children) {
        walkParts(child, visit);
      }
    }
  }
}
