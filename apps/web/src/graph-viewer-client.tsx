'use client';

import cytoscape, {
  type Core,
  type EdgeSingular,
  type NodeSingular,
  type StylesheetJson,
} from 'cytoscape';
import { Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphPresetId,
  GraphPresetSummary,
  GraphQueryResult,
  GraphViewerEdge,
  GraphViewerNode,
} from './graph-viewer';

type GraphSelection =
  | { readonly item: GraphViewerEdge; readonly type: 'edge' }
  | { readonly item: GraphViewerNode; readonly type: 'node' };

type GraphLayoutId = 'force' | 'grid' | 'timeline';

const GRAPH_VIEWER_DEFAULT_LIMIT = 100;
const GRAPH_LIMIT_OPTIONS = [50, 100, 200, 500] as const;
const GRAPH_LAYOUT_OPTIONS: readonly { readonly id: GraphLayoutId; readonly label: string }[] = [
  { id: 'force', label: 'Force' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'grid', label: 'Grid' },
];
const TIMELINE_COLUMN_WIDTH = 180;
const TIMELINE_MIN_COLUMNS = 4;
const TIMELINE_MAX_COLUMNS = 24;
const TIMELINE_ROW_HEIGHT = 170;
const TIMELINE_ALTERNATE_OFFSET = 48;
const TIMELINE_HORIZONTAL_PADDING = 112;

export function GraphViewerPanel({
  initialPresetId,
  presets,
  projectSlug,
}: {
  readonly initialPresetId: GraphPresetId;
  readonly presets: readonly GraphPresetSummary[];
  readonly projectSlug: string;
}) {
  const [queryId, setQueryId] = useState<GraphPresetId>(initialPresetId);
  const [result, setResult] = useState<GraphQueryResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [selection, setSelection] = useState<GraphSelection | undefined>();
  const [limit, setLimit] = useState(
    () =>
      presets.find((preset) => preset.id === initialPresetId)?.defaultLimit ??
      GRAPH_VIEWER_DEFAULT_LIMIT,
  );
  const [layoutId, setLayoutId] = useState<GraphLayoutId>('force');
  const [isLoading, setIsLoading] = useState(false);
  const selectedPreset = presets.find((preset) => preset.id === queryId) ?? presets[0];
  const limitOptions = useMemo(() => buildLimitOptions(selectedPreset), [selectedPreset]);

  const runQuery = useCallback(async () => {
    if (!selectedPreset) {
      return;
    }
    setError(undefined);
    setSelection(undefined);
    setIsLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectSlug}/graph`, {
        body: JSON.stringify({ limit, queryId: selectedPreset.id }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = (await response.json()) as GraphQueryResult | GraphErrorBody;
      if (!response.ok || 'error' in body) {
        throw new Error('error' in body ? body.error.message : 'Graph query failed.');
      }
      setResult(body);
    } catch (caught) {
      setResult(undefined);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, [limit, projectSlug, selectedPreset]);

  useEffect(() => {
    void runQuery();
  }, [runQuery]);

  return (
    <div className="graph-workspace" data-testid="graph-viewer-panel">
      <section className="panel graph-control-panel" data-testid="graph-control-panel">
        <div className="panel-heading">
          <div>
            <h2>Graph Query</h2>
            <p className="mono">project: {projectSlug}</p>
          </div>
          {isLoading ? <span className="status-badge status-held">Running</span> : null}
          {result ? (
            <span className="status-badge status-healthy" data-testid="graph-result-count">
              {result.rowCount} rows
            </span>
          ) : null}
        </div>
        <label className="form-field" htmlFor="graph-preset-select">
          <span>Preset</span>
          <select
            data-testid="graph-preset-select"
            disabled={isLoading}
            id="graph-preset-select"
            onChange={(event) => {
              const nextQueryId = event.target.value as GraphPresetId;
              const nextPreset = presets.find((preset) => preset.id === nextQueryId);
              setQueryId(nextQueryId);
              setLimit(nextPreset?.defaultLimit ?? GRAPH_VIEWER_DEFAULT_LIMIT);
            }}
            value={queryId}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <div className="graph-control-grid">
          <label className="form-field" htmlFor="graph-limit-select">
            <span>Rows</span>
            <select
              data-testid="graph-limit-select"
              disabled={isLoading}
              id="graph-limit-select"
              onChange={(event) => setLimit(Number(event.target.value))}
              value={limit}
            >
              {limitOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field" htmlFor="graph-layout-select">
            <span>Layout</span>
            <select
              data-testid="graph-layout-select"
              id="graph-layout-select"
              onChange={(event) => setLayoutId(event.target.value as GraphLayoutId)}
              value={layoutId}
            >
              {GRAPH_LAYOUT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {selectedPreset ? (
          <div className="graph-preset-detail" data-testid="graph-preset-detail">
            <p>{selectedPreset.description}</p>
          </div>
        ) : null}
        {error ? (
          <p className="action-error" data-testid="graph-error">
            {error}
          </p>
        ) : null}
      </section>

      <section className="panel graph-canvas-panel" data-testid="graph-canvas-panel">
        <div className="panel-heading">
          <div>
            <h2>Graph</h2>
            <p className="mono">{result?.graphName ?? 'Loading project graph.'}</p>
          </div>
          {result?.truncated ? <span className="status-badge status-held">Limited</span> : null}
        </div>
        <GraphCanvas
          edges={result?.edges ?? []}
          layoutId={layoutId}
          nodes={result?.nodes ?? []}
          onSelect={setSelection}
        />
      </section>

      <section className="panel graph-detail-panel" data-testid="graph-detail-panel">
        <div className="panel-heading">
          <div>
            <h2>Details</h2>
            <p className="mono">{selection ? selection.type : 'none'}</p>
          </div>
        </div>
        {selection ? (
          <PropertyList item={selection.item} />
        ) : (
          <p className="notice">Node or edge を選択すると property を確認できます。</p>
        )}
      </section>

      <details className="panel graph-raw-panel" data-testid="graph-raw-panel">
        <summary className="graph-raw-summary">
          <span className="graph-raw-summary-title">Raw Result</span>
          <span className="mono">{result ? `${result.rawRows.length} rows` : 'empty'}</span>
        </summary>
        <div className="graph-raw-content">
          {!result ? (
            <p className="notice">まだ query は実行されていません。</p>
          ) : result.rawRows.length ? (
            <pre className="json-preview" data-testid="graph-raw-json">
              {JSON.stringify(result.rawRows, null, 2)}
            </pre>
          ) : (
            <p className="notice" data-testid="graph-raw-empty">
              Raw rows はありません。
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function GraphCanvas({
  edges,
  layoutId,
  nodes,
  onSelect,
}: {
  readonly edges: readonly GraphViewerEdge[];
  readonly layoutId: GraphLayoutId;
  readonly nodes: readonly GraphViewerNode[];
  readonly onSelect: (selection: GraphSelection | undefined) => void;
}) {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const cytoscapeRef = useRef<Core | null>(null);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const isMaximized = isNativeFullscreen || isFallbackFullscreen;
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edgesById = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);

  const zoomGraph = useCallback((factor: number) => {
    const cy = cytoscapeRef.current;
    if (!cy) {
      return;
    }
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    });
  }, []);

  const resetGraphView = useCallback(() => {
    const cy = cytoscapeRef.current;
    if (!cy) {
      return;
    }
    cy.fit(undefined, 56);
  }, []);

  const resizeGraph = useCallback(() => {
    window.setTimeout(() => {
      const cy = cytoscapeRef.current;
      if (cy) {
        cy.resize();
      }
    }, 0);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const canvasWrap = canvasWrapRef.current;
    if (!canvasWrap) {
      return;
    }

    if (document.fullscreenElement === canvasWrap) {
      try {
        await document.exitFullscreen();
      } catch {
        return;
      }
      return;
    }

    if (isFallbackFullscreen) {
      setIsFallbackFullscreen(false);
      resizeGraph();
      return;
    }

    try {
      if (document.fullscreenEnabled && canvasWrap.requestFullscreen) {
        await canvasWrap.requestFullscreen();
        return;
      }
    } catch {
      // Some mobile browsers expose the API but reject fullscreen requests.
    }
    setIsFallbackFullscreen(true);
    resizeGraph();
  }, [isFallbackFullscreen, resizeGraph]);

  useEffect(() => {
    const updateFullscreenState = () => {
      const nextIsNativeFullscreen = document.fullscreenElement === canvasWrapRef.current;
      setIsNativeFullscreen(nextIsNativeFullscreen);
      if (nextIsNativeFullscreen) {
        setIsFallbackFullscreen(false);
      }
      resizeGraph();
    };

    document.addEventListener('fullscreenchange', updateFullscreenState);
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, [resizeGraph]);

  useEffect(() => {
    document.body.classList.toggle('graph-fallback-fullscreen-active', isFallbackFullscreen);
    resizeGraph();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFallbackFullscreen(false);
      }
    };

    if (isFallbackFullscreen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.body.classList.remove('graph-fallback-fullscreen-active');
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFallbackFullscreen, resizeGraph]);

  useEffect(() => {
    const container = containerElement;
    if (!container) {
      return;
    }

    const root = document.documentElement;
    const updateTheme = () => {
      const cy = cytoscapeRef.current;
      if (cy) {
        cy.style(buildGraphStyles(readGraphTheme(container))).update();
      }
    };

    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributeFilter: ['data-theme'], attributes: true });
    return () => observer.disconnect();
  }, [containerElement]);

  useEffect(() => {
    const container = containerElement;
    if (!container) {
      return;
    }
    const graphTheme = readGraphTheme(container);
    const cy = cytoscape({
      container,
      elements: [
        ...nodes.map((node) => ({
          data: {
            fullLabel: node.label,
            id: node.id,
            label: truncateGraphLabel(node.label),
            type: node.labels[0] ?? 'Node',
          },
        })),
        ...edges
          .filter((edge) => nodesById.has(edge.source) && nodesById.has(edge.target))
          .map((edge) => ({
            data: { id: edge.id, label: edge.label, source: edge.source, target: edge.target },
          })),
      ],
      layout: buildGraphLayoutOptions('force', nodes, edges, container.clientWidth),
      maxZoom: 4,
      minZoom: 0.08,
      style: buildGraphStyles(graphTheme),
    });
    cytoscapeRef.current = cy;
    cy.on('tap', 'node', (event) => {
      const node = nodesById.get((event.target as NodeSingular).id());
      onSelect(node ? { item: node, type: 'node' } : undefined);
    });
    cy.on('tap', 'edge', (event) => {
      const edge = edgesById.get((event.target as EdgeSingular).id());
      onSelect(edge ? { item: edge, type: 'edge' } : undefined);
    });
    cy.on('tap', (event) => {
      if (event.target === cy) {
        onSelect(undefined);
      }
    });
    return () => {
      cytoscapeRef.current = null;
      cy.destroy();
    };
  }, [containerElement, edges, edgesById, nodes, nodesById, onSelect]);

  useEffect(() => {
    const container = containerElement;
    const cy = cytoscapeRef.current;
    if (!container || !cy) {
      return;
    }
    cy.layout(buildGraphLayoutOptions(layoutId, nodes, edges, container.clientWidth, false)).run();
  }, [containerElement, edges, layoutId, nodes]);

  return (
    <div
      className={
        isFallbackFullscreen
          ? 'graph-canvas-wrap graph-canvas-wrap-fallback-fullscreen'
          : 'graph-canvas-wrap'
      }
      data-testid="graph-canvas-wrap"
      ref={canvasWrapRef}
    >
      {nodes.length ? (
        <>
          <div className="graph-canvas" data-testid="graph-canvas" ref={setContainerElement} />
          <div
            className="graph-viewport-controls"
            aria-label="グラフ表示コントロール"
            role="toolbar"
          >
            <button
              aria-label="拡大"
              className="graph-viewport-button"
              data-testid="graph-zoom-in-button"
              onClick={() => zoomGraph(1.25)}
              title="拡大"
              type="button"
            >
              <ZoomIn aria-hidden="true" size={16} />
            </button>
            <button
              aria-label="縮小"
              className="graph-viewport-button"
              data-testid="graph-zoom-out-button"
              onClick={() => zoomGraph(0.8)}
              title="縮小"
              type="button"
            >
              <ZoomOut aria-hidden="true" size={16} />
            </button>
            <button
              aria-label="初期表示位置に戻す"
              className="graph-viewport-button"
              data-testid="graph-reset-view-button"
              onClick={resetGraphView}
              title="初期表示位置に戻す"
              type="button"
            >
              <RotateCcw aria-hidden="true" size={16} />
            </button>
            <button
              aria-label={isMaximized ? '最大化を解除' : '画面最大化'}
              className="graph-viewport-button"
              data-testid="graph-fullscreen-button"
              onClick={() => void toggleFullscreen()}
              title={isMaximized ? '最大化を解除' : '画面最大化'}
              type="button"
            >
              {isMaximized ? (
                <Minimize2 aria-hidden="true" size={16} />
              ) : (
                <Maximize2 aria-hidden="true" size={16} />
              )}
            </button>
          </div>
        </>
      ) : (
        <div className="graph-empty" data-testid="graph-empty">
          Loading graph nodes and edges.
        </div>
      )}
    </div>
  );
}

function buildGraphLayoutOptions(
  layoutId: GraphLayoutId,
  nodes: readonly GraphViewerNode[],
  edges: readonly GraphViewerEdge[],
  containerWidth: number,
  fit = true,
) {
  if (layoutId === 'grid') {
    return {
      name: 'grid',
      animate: false,
      fit,
      nodeDimensionsIncludeLabels: true,
      padding: 56,
    };
  }
  if (layoutId === 'timeline') {
    const positions = buildTimelinePositions(nodes, edges, containerWidth);
    return {
      name: 'preset',
      fit,
      padding: 56,
      positions: (node: NodeSingular) => positions.get(node.id()) ?? { x: 0, y: 0 },
    };
  }
  return {
    name: 'cose',
    animate: false,
    componentSpacing: 260,
    fit,
    gravity: 30,
    idealEdgeLength: 300,
    nodeDimensionsIncludeLabels: true,
    nodeOverlap: 64,
    nodeRepulsion: 220000,
    numIter: 2000,
    padding: 56,
  };
}

function buildTimelinePositions(
  nodes: readonly GraphViewerNode[],
  edges: readonly GraphViewerEdge[],
  containerWidth: number,
): Map<string, { readonly x: number; readonly y: number }> {
  const connectedCounts = new Map<string, number>();
  for (const edge of edges) {
    connectedCounts.set(edge.source, (connectedCounts.get(edge.source) ?? 0) + 1);
    connectedCounts.set(edge.target, (connectedCounts.get(edge.target) ?? 0) + 1);
  }
  const orderedNodes = nodes
    .map((node, index) => ({ index, node, sortValue: graphNodeSortValue(node) }))
    .sort((left, right) => {
      const leftSort = left.sortValue ?? Number.POSITIVE_INFINITY;
      const rightSort = right.sortValue ?? Number.POSITIVE_INFINITY;
      if (leftSort !== rightSort) {
        return leftSort - rightSort;
      }
      return left.node.label.localeCompare(right.node.label) || left.index - right.index;
    });
  const positions = new Map<string, { readonly x: number; readonly y: number }>();
  const columnCount = timelineColumnCount(containerWidth);
  orderedNodes.forEach(({ node }, index) => {
    const row = Math.floor(index / columnCount);
    const column = index % columnCount;
    const degreeOffset = Math.min(connectedCounts.get(node.id) ?? 0, 6) * 10;
    positions.set(node.id, {
      x: column * TIMELINE_COLUMN_WIDTH,
      y:
        row * TIMELINE_ROW_HEIGHT +
        (index % 2 === 0 ? 0 : TIMELINE_ALTERNATE_OFFSET) -
        degreeOffset,
    });
  });
  return positions;
}

function timelineColumnCount(containerWidth: number): number {
  const usableWidth = Math.max(containerWidth - TIMELINE_HORIZONTAL_PADDING, TIMELINE_COLUMN_WIDTH);
  return Math.max(
    TIMELINE_MIN_COLUMNS,
    Math.min(TIMELINE_MAX_COLUMNS, Math.floor(usableWidth / TIMELINE_COLUMN_WIDTH)),
  );
}

function buildLimitOptions(preset: GraphPresetSummary | undefined): readonly number[] {
  const maxLimit = preset?.maxLimit ?? GRAPH_VIEWER_DEFAULT_LIMIT;
  const defaultLimit = preset?.defaultLimit ?? GRAPH_VIEWER_DEFAULT_LIMIT;
  const options = new Set<number>();
  for (const option of GRAPH_LIMIT_OPTIONS) {
    if (option <= maxLimit) {
      options.add(option);
    }
  }
  if (defaultLimit <= maxLimit) {
    options.add(defaultLimit);
  }
  options.add(maxLimit);
  return [...options].sort((left, right) => left - right);
}

function graphNodeSortValue(node: GraphViewerNode): number | undefined {
  for (const key of [
    'createdAt',
    'created_at',
    'updatedAt',
    'updated_at',
    'publishedAt',
    'published_at',
    'collectedAt',
    'collected_at',
    'timestamp',
    'date',
  ]) {
    const value = node.properties[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) {
        return timestamp;
      }
    }
  }
  return undefined;
}

function truncateGraphLabel(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 16) {
    return value;
  }
  return `${characters.slice(0, 8).join('')}...${characters.slice(-8).join('')}`;
}

function PropertyList({ item }: { readonly item: GraphViewerEdge | GraphViewerNode }) {
  const propertyRows = Object.entries(item.properties).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <dl className="detail-list stacked">
      <div>
        <dt>ID</dt>
        <dd className="mono">{item.id}</dd>
      </div>
      <div>
        <dt>Label</dt>
        <dd>{item.label}</dd>
      </div>
      {'source' in item ? (
        <>
          <div>
            <dt>Source</dt>
            <dd className="mono">{item.source}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd className="mono">{item.target}</dd>
          </div>
        </>
      ) : null}
      <div>
        <dt>Properties</dt>
        <dd>
          {propertyRows.length ? (
            <div className="graph-property-table-frame">
              <table className="graph-property-table">
                <thead>
                  <tr>
                    <th scope="col">Property</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {propertyRows.map(([key, value]) => (
                    <tr key={key}>
                      <th className="mono" scope="row">
                        {key}
                      </th>
                      <td className="mono">{formatPropertyValue(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">property はありません。</p>
          )}
        </dd>
      </div>
    </dl>
  );
}

function formatPropertyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'undefined'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function readGraphTheme(container: HTMLElement) {
  const style = getComputedStyle(container);
  return {
    actor: readCssVariable(style, '--graph-actor', '#d8b9ff'),
    document: readCssVariable(style, '--graph-document', '#0066ff'),
    labelBackground: readCssVariable(style, '--graph-label-bg', '#0b1326'),
    line: readCssVariable(style, '--graph-line', '#8c90a1'),
    node: readCssVariable(style, '--graph-node', '#4edea3'),
    selected: readCssVariable(style, '--graph-selected', '#ffb4ab'),
    text: readCssVariable(style, '--text', '#e3e8f7'),
  };
}

function buildGraphStyles(graphTheme: ReturnType<typeof readGraphTheme>): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        'background-color': graphTheme.node,
        color: graphTheme.text,
        'font-size': '11px',
        label: 'data(label)',
        'text-background-color': graphTheme.labelBackground,
        'text-background-opacity': 0.8,
        'text-background-padding': '3px',
        'text-max-width': '132px',
        'text-valign': 'bottom',
        'text-wrap': 'wrap',
        width: '34px',
        height: '34px',
      },
    },
    {
      selector: 'node[type = "Document"]',
      style: { 'background-color': graphTheme.document },
    },
    {
      selector: 'node[type = "Actor"]',
      style: { 'background-color': graphTheme.actor },
    },
    {
      selector: 'node:selected',
      style: {
        label: 'data(fullLabel)',
      },
    },
    {
      selector: 'edge',
      style: {
        color: graphTheme.text,
        'curve-style': 'bezier',
        'font-size': '10px',
        label: 'data(label)',
        'line-color': graphTheme.line,
        'target-arrow-color': graphTheme.line,
        'target-arrow-shape': 'triangle',
        'text-background-color': graphTheme.labelBackground,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        width: '1.5px',
      },
    },
    {
      selector: ':selected',
      style: {
        'background-color': graphTheme.selected,
        'line-color': graphTheme.selected,
        'target-arrow-color': graphTheme.selected,
      },
    },
  ];
}

function readCssVariable(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback;
}

type GraphErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};
