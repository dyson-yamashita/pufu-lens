'use client';

import cytoscape, {
  type Core,
  type EdgeSingular,
  type NodeSingular,
  type StylesheetJson,
} from 'cytoscape';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
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
  const [isLoading, setIsLoading] = useState(false);
  const selectedPreset = presets.find((preset) => preset.id === queryId) ?? presets[0];

  const runQuery = useCallback(async () => {
    if (!selectedPreset) {
      return;
    }
    setError(undefined);
    setSelection(undefined);
    setIsLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectSlug}/graph`, {
        body: JSON.stringify({ queryId: selectedPreset.id }),
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
  }, [projectSlug, selectedPreset]);

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
            onChange={(event) => setQueryId(event.target.value as GraphPresetId)}
            value={queryId}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
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
          <div className="panel-heading">
            <div>
              <h2>Raw Result</h2>
              <p className="mono">{result ? `${result.rawRows.length} rows` : 'empty'}</p>
            </div>
          </div>
        </summary>
        <div className="graph-raw-content">
          {result?.rawRows.length ? (
            <pre className="json-preview" data-testid="graph-raw-json">
              {JSON.stringify(result.rawRows, null, 2)}
            </pre>
          ) : (
            <p className="notice">まだ query は実行されていません。</p>
          )}
        </div>
      </details>
    </div>
  );
}

function GraphCanvas({
  edges,
  nodes,
  onSelect,
}: {
  readonly edges: readonly GraphViewerEdge[];
  readonly nodes: readonly GraphViewerNode[];
  readonly onSelect: (selection: GraphSelection | undefined) => void;
}) {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const cytoscapeRef = useRef<Core | null>(null);
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
      layout: {
        name: 'cose',
        animate: false,
        componentSpacing: 260,
        fit: true,
        gravity: 30,
        idealEdgeLength: 300,
        nodeDimensionsIncludeLabels: true,
        nodeOverlap: 64,
        nodeRepulsion: 220000,
        numIter: 2000,
        padding: 56,
      },
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

  return (
    <div className="graph-canvas-wrap">
      {nodes.length ? (
        <>
          <div className="graph-canvas" data-testid="graph-canvas" ref={setContainerElement} />
          <div
            className="graph-viewport-controls"
            aria-label="Graph viewport controls"
            role="toolbar"
          >
            <button
              aria-label="拡大"
              className="graph-viewport-button"
              onClick={() => zoomGraph(1.25)}
              title="拡大"
              type="button"
            >
              <ZoomIn aria-hidden="true" size={16} />
            </button>
            <button
              aria-label="縮小"
              className="graph-viewport-button"
              onClick={() => zoomGraph(0.8)}
              title="縮小"
              type="button"
            >
              <ZoomOut aria-hidden="true" size={16} />
            </button>
            <button
              aria-label="初期表示位置に戻す"
              className="graph-viewport-button"
              onClick={resetGraphView}
              title="初期表示位置に戻す"
              type="button"
            >
              <RotateCcw aria-hidden="true" size={16} />
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
