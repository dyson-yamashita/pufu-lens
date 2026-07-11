import { useEffect, useState } from 'react';
import type { GraphViewerDocumentChunk, GraphViewerEdge, GraphViewerNode } from './graph-viewer';

/**
 * Renders the property list for a graph node or edge.
 *
 * @param item - The selected graph node or edge.
 */
export function PropertyList({
  item,
  projectSlug,
}: {
  readonly item: GraphViewerEdge | GraphViewerNode;
  readonly projectSlug: string;
}) {
  const [selectedChunkState, setSelectedChunkState] = useState<
    | {
        readonly chunk: GraphViewerDocumentChunk;
        readonly itemId: string;
      }
    | undefined
  >();
  const [chunksState, setChunksState] = useState<GraphDocumentChunksState>({ status: 'idle' });
  const propertyRows = Object.entries(item.properties).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const documentId = 'source' in item ? undefined : propertyString(item.properties, 'documentId');
  const chunks = chunksState.status === 'loaded' ? chunksState.chunks : undefined;
  const selectedChunk =
    selectedChunkState?.itemId === item.id ? selectedChunkState.chunk : undefined;

  useEffect(() => {
    if (!documentId) {
      setChunksState({ status: 'idle' });
      return;
    }
    const abortController = new AbortController();
    setChunksState({ status: 'loading' });
    void fetch(
      `/api/projects/${encodeURIComponent(projectSlug)}/graph/document-chunks?documentId=${encodeURIComponent(
        documentId,
      )}`,
      { signal: abortController.signal },
    )
      .then(async (response) => {
        const body = (await response.json()) as GraphDocumentChunksResponse;
        if (!response.ok || 'error' in body) {
          throw new Error('error' in body ? body.error.message : 'チャンクの取得に失敗しました。');
        }
        setChunksState({ chunks: body.chunks, status: 'loaded' });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setChunksState({
          message: error instanceof Error ? error.message : String(error),
          status: 'error',
        });
      });
    return () => abortController.abort();
  }, [documentId, projectSlug]);

  if (selectedChunk) {
    return (
      <div className="graph-chunk-detail" data-testid="graph-chunk-detail">
        <button
          className="secondary-button"
          data-testid="graph-chunk-detail-back-button"
          onClick={() => setSelectedChunkState(undefined)}
          type="button"
        >
          チャンク一覧に戻る
        </button>
        <dl className="detail-list stacked">
          <div>
            <dt>Chunk ID</dt>
            <dd className="mono">{selectedChunk.id}</dd>
          </div>
          <div>
            <dt>Index</dt>
            <dd className="mono">{selectedChunk.chunkIndex}</dd>
          </div>
          <div>
            <dt>Content hash</dt>
            <dd className="mono">{selectedChunk.contentHash}</dd>
          </div>
          <div>
            <dt>Created at</dt>
            <dd className="mono">{selectedChunk.createdAt}</dd>
          </div>
          <div>
            <dt>Metadata</dt>
            <dd className="mono">{formatPropertyValue(selectedChunk.metadata)}</dd>
          </div>
          <div>
            <dt>Content</dt>
            <dd className="graph-chunk-content">{selectedChunk.content}</dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <>
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
      {documentId ? (
        <section className="graph-chunk-list" data-testid="graph-chunk-list">
          <div className="graph-chunk-list-heading">
            <h3>Chunks</h3>
            <span className="mono">
              {chunksState.status === 'loaded' ? `${chunksState.chunks.length} chunks` : 'loading'}
            </span>
          </div>
          {chunksState.status === 'loading' ? (
            <p className="notice" data-testid="graph-chunk-loading">
              チャンクを取得しています。
            </p>
          ) : chunksState.status === 'error' ? (
            <p className="action-error" data-testid="graph-chunk-error">
              {chunksState.message}
            </p>
          ) : chunks?.length ? (
            <div className="graph-property-table-frame">
              <table className="graph-property-table graph-chunk-table">
                <thead>
                  <tr>
                    <th scope="col">Index</th>
                    <th scope="col">Preview</th>
                    <th scope="col">Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {chunks.map((chunk) => (
                    <tr
                      data-testid="graph-chunk-row"
                      key={chunk.id}
                      onClick={() => setSelectedChunkState({ chunk, itemId: item.id })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedChunkState({ chunk, itemId: item.id });
                        }
                      }}
                      tabIndex={0}
                    >
                      <th className="mono" scope="row">
                        {chunk.chunkIndex}
                      </th>
                      <td>{truncateChunkPreview(chunk.content)}</td>
                      <td className="mono">{chunk.contentHash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">チャンクはありません。</p>
          )}
        </section>
      ) : null}
    </>
  );
}

function truncateChunkPreview(value: string): string {
  const characters = Array.from(value.replace(/\s+/g, ' ').trim());
  return characters.length <= 120 ? characters.join('') : `${characters.slice(0, 120).join('')}…`;
}

type GraphDocumentChunksState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly chunks: readonly GraphViewerDocumentChunk[]; readonly status: 'loaded' }
  | { readonly message: string; readonly status: 'error' };

type GraphDocumentChunksResponse =
  | { readonly chunks: readonly GraphViewerDocumentChunk[] }
  | { readonly error: { readonly message: string } };

function propertyString(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value ? value : undefined;
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
