'use client';

import cytoscape, {
  type Core,
  type EdgeSingular,
  type NodeSingular,
  type StylesheetJson,
} from 'cytoscape';
import { Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraphDetailsDialog } from './graph-details-dialog';
import { PropertyList } from './graph-property-list';
import type {
  GraphPresetId,
  GraphPresetSummary,
  GraphQueryResult,
  GraphViewerEdge,
  GraphViewerNode,
} from './graph-viewer';
import { graphDetailsModalSelection } from './graph-viewer-interactions';
import { buildTimelinePositions } from './graph-viewer-layout';

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

/**
 * Renders the graph query workspace.
 *
 * @param initialPresetId - The preset selected on first render.
 * @param presets - The available graph presets.
 * @param projectSlug - The project identifier used to load graph data.
 */
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
          projectSlug={projectSlug}
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
          <PropertyList item={selection.item} projectSlug={projectSlug} />
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

/**
 * Renders an interactive graph canvas with selection, zoom, and fullscreen controls.
 *
 * @param edges - Graph edges to display.
 * @param layoutId - Layout used to arrange the graph.
 * @param nodes - Graph nodes to display.
 * @param onSelect - Called when a node, edge, or empty space is selected.
 */
function GraphCanvas({
  edges,
  layoutId,
  nodes,
  onSelect,
  projectSlug,
}: {
  readonly edges: readonly GraphViewerEdge[];
  readonly layoutId: GraphLayoutId;
  readonly nodes: readonly GraphViewerNode[];
  readonly onSelect: (selection: GraphSelection | undefined) => void;
  readonly projectSlug: string;
}) {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [canvasWrapElement, setCanvasWrapElement] = useState<HTMLDivElement | null>(null);
  const cytoscapeRef = useRef<Core | null>(null);
  const isMaximizedRef = useRef(false);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const [floatingSelection, setFloatingSelection] = useState<GraphSelection | undefined>();
  const [containerWidth, setContainerWidth] = useState(0);
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

  const setCanvasWrap = useCallback((element: HTMLDivElement | null) => {
    canvasWrapRef.current = element;
    setCanvasWrapElement(element);
  }, []);

  const selectGraphItem = useCallback(
    (selection: GraphSelection | undefined) => {
      onSelect(selection);
      setFloatingSelection(graphDetailsModalSelection(isMaximizedRef.current, selection));
    },
    [onSelect],
  );

  const closeFloatingDetails = useCallback(() => {
    setFloatingSelection(undefined);
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
    return () => {
      document.body.classList.remove('graph-fallback-fullscreen-active');
    };
  }, [isFallbackFullscreen, resizeGraph]);

  useEffect(() => {
    if (!isMaximized) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (floatingSelection) {
        event.preventDefault();
        setFloatingSelection(undefined);
        return;
      }
      if (isFallbackFullscreen) {
        setIsFallbackFullscreen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [floatingSelection, isFallbackFullscreen, isMaximized]);

  useEffect(() => {
    isMaximizedRef.current = isMaximized;
    if (!isMaximized) {
      setFloatingSelection(undefined);
    }
  }, [isMaximized]);

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
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(Math.round(entry?.contentRect.width ?? container.clientWidth));
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);
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
      layout: buildGraphLayoutOptions('force', nodes, edges),
      maxZoom: 4,
      minZoom: 0.08,
      style: buildGraphStyles(graphTheme),
    });
    cytoscapeRef.current = cy;
    cy.on('tap', 'node', (event) => {
      const node = nodesById.get((event.target as NodeSingular).id());
      selectGraphItem(node ? { item: node, type: 'node' } : undefined);
    });
    cy.on('tap', 'edge', (event) => {
      const edge = edgesById.get((event.target as EdgeSingular).id());
      selectGraphItem(edge ? { item: edge, type: 'edge' } : undefined);
    });
    cy.on('tap', (event) => {
      if (event.target === cy) {
        selectGraphItem(undefined);
      }
    });
    return () => {
      cytoscapeRef.current = null;
      cy.destroy();
    };
  }, [containerElement, edges, edgesById, nodes, nodesById, selectGraphItem]);

  useEffect(() => {
    const container = containerElement;
    const cy = cytoscapeRef.current;
    if (!container || !cy) {
      return;
    }
    cy.layout(
      buildGraphLayoutOptions(layoutId, nodes, edges, containerWidth || container.clientWidth),
    ).run();
  }, [containerElement, containerWidth, edges, layoutId, nodes]);

  return (
    <div
      className={
        isFallbackFullscreen
          ? 'graph-canvas-wrap graph-canvas-wrap-fallback-fullscreen'
          : 'graph-canvas-wrap'
      }
      data-testid="graph-canvas-wrap"
      ref={setCanvasWrap}
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
          {floatingSelection ? (
            <GraphDetailsDialog
              onClose={closeFloatingDetails}
              projectSlug={projectSlug}
              selection={floatingSelection}
              wrapperElement={canvasWrapElement}
            />
          ) : null}
        </>
      ) : (
        <div className="graph-empty" data-testid="graph-empty">
          Loading graph nodes and edges.
        </div>
      )}
    </div>
  );
}

/**
 * Builds Cytoscape layout options for the selected graph layout.
 *
 * @param layoutId - The layout to apply.
 * @param nodes - The graph nodes used to compute layout positions.
 * @param edges - The graph edges used to compute layout positions.
 * @param fit - Whether Cytoscape should fit the graph to the viewport.
 * @returns The Cytoscape layout configuration.
 */
function buildGraphLayoutOptions(
  layoutId: GraphLayoutId,
  nodes: readonly GraphViewerNode[],
  edges: readonly GraphViewerEdge[],
  containerWidth = 0,
  fit = true,
) {
  const padding = Math.max(40, Math.min(72, Math.round(containerWidth * 0.05) || 56));
  if (layoutId === 'grid') {
    return {
      name: 'grid',
      animate: false,
      fit,
      nodeDimensionsIncludeLabels: true,
      padding,
    };
  }
  if (layoutId === 'timeline') {
    const positions = buildTimelinePositions(nodes, edges);
    return {
      name: 'preset',
      fit,
      padding,
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
    padding,
  };
}

/**
 * Builds the available row limit options for a graph preset.
 *
 * @param preset - The preset used to derive the maximum and default limits
 * @returns The sorted unique limit values available for selection
 */
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

/**
 * Truncates a graph label for display.
 *
 * @param value - The label text to truncate
 * @returns The original label when it is 16 characters or fewer, otherwise the first 8 characters, an ellipsis, and the last 8 characters
 */
function truncateGraphLabel(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 16) {
    return value;
  }
  return `${characters.slice(0, 8).join('')}...${characters.slice(-8).join('')}`;
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
