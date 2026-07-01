import {
  type ClassificationCategory,
  CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
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
    const columnIndex = tail[0] as number;
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
    const columnIndex = tail[0] as number;
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
    return {
      ...part,
      columns: [
        ...part.columns,
        {
          width_fraction: 1 / (part.columns.length + 1),
          children: [createDefaultPart('fixed_text', ids, resultKeys)],
        },
      ],
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
    return { ...part, columns: part.columns.filter((_, idx) => idx !== columnIndex) };
  });
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
