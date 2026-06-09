'use client';

import cytoscape, { type Core, type EdgeSingular, type NodeSingular } from 'cytoscape';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphPresetId,
  GraphPresetSummary,
  GraphQueryResult,
  GraphViewerEdge,
  GraphViewerNode
} from './graph-viewer';

type GraphSelection =
  | { readonly item: GraphViewerEdge; readonly type: 'edge' }
  | { readonly item: GraphViewerNode; readonly type: 'node' };

export function GraphViewerPanel({
  initialPresetId,
  presets,
  projectSlug
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

  async function runQuery() {
    setError(undefined);
    setSelection(undefined);
    setIsLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectSlug}/graph`, {
        body: JSON.stringify({ queryId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST'
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
  }

  return (
    <div className="graph-workspace" data-testid="graph-viewer-panel">
      <section className="panel graph-control-panel" data-testid="graph-control-panel">
        <div className="panel-heading">
          <div>
            <h2>Graph Query</h2>
            <p className="mono">project: {projectSlug}</p>
          </div>
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
            <pre>{selectedPreset.preview}</pre>
          </div>
        ) : null}
        <button
          className="primary-button"
          data-testid="graph-run-button"
          disabled={isLoading}
          onClick={runQuery}
          type="button"
        >
          {isLoading ? 'Running...' : 'Run'}
        </button>
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
            <p className="mono">{result?.graphName ?? 'Run a preset to render graph.'}</p>
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

      <section className="panel graph-raw-panel" data-testid="graph-raw-panel">
        <div className="panel-heading">
          <div>
            <h2>Raw Result</h2>
            <p className="mono">{result ? `${result.rawRows.length} rows` : 'empty'}</p>
          </div>
        </div>
        {result?.rawRows.length ? (
          <pre className="json-preview" data-testid="graph-raw-json">
            {JSON.stringify(result.rawRows, null, 2)}
          </pre>
        ) : (
          <p className="notice">まだ query は実行されていません。</p>
        )}
      </section>
    </div>
  );
}

function GraphCanvas({
  edges,
  nodes,
  onSelect
}: {
  readonly edges: readonly GraphViewerEdge[];
  readonly nodes: readonly GraphViewerNode[];
  readonly onSelect: (selection: GraphSelection | undefined) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edgesById = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const cy = cytoscape({
      container,
      elements: [
        ...nodes.map((node) => ({
          data: { id: node.id, label: node.label, type: node.labels[0] ?? 'Node' }
        })),
        ...edges
          .filter((edge) => nodesById.has(edge.source) && nodesById.has(edge.target))
          .map((edge) => ({
            data: { id: edge.id, label: edge.label, source: edge.source, target: edge.target }
          }))
      ],
      layout: { name: 'cose', animate: false, fit: true, padding: 24 },
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#4edea3',
            color: '#dae2fd',
            'font-size': '11px',
            label: 'data(label)',
            'text-background-color': '#0b1326',
            'text-background-opacity': 0.8,
            'text-background-padding': '3px',
            'text-valign': 'bottom',
            'text-wrap': 'wrap',
            width: '34px',
            height: '34px'
          }
        },
        {
          selector: 'node[type = "Document"]',
          style: { 'background-color': '#0066ff' }
        },
        {
          selector: 'node[type = "Actor"]',
          style: { 'background-color': '#d8b9ff' }
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'font-size': '10px',
            label: 'data(label)',
            'line-color': '#8c90a1',
            'target-arrow-color': '#8c90a1',
            'target-arrow-shape': 'triangle',
            width: '1.5px'
          }
        },
        {
          selector: ':selected',
          style: {
            'background-color': '#ffb4ab',
            'line-color': '#ffb4ab',
            'target-arrow-color': '#ffb4ab'
          }
        }
      ]
    });
    cyRef.current = cy;
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
      cy.destroy();
      cyRef.current = undefined;
    };
  }, [edges, edgesById, nodes, nodesById, onSelect]);

  return (
    <div className="graph-canvas-wrap">
      {nodes.length ? (
        <div className="graph-canvas" data-testid="graph-canvas" ref={containerRef} />
      ) : (
        <div className="graph-empty" data-testid="graph-empty">
          Run a preset to render nodes and edges.
        </div>
      )}
    </div>
  );
}

function PropertyList({ item }: { readonly item: GraphViewerEdge | GraphViewerNode }) {
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
          <pre className="json-preview">{JSON.stringify(item.properties, null, 2)}</pre>
        </dd>
      </div>
    </dl>
  );
}

type GraphErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};
