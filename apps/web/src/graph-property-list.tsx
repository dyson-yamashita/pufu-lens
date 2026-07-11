'use client';

import { useEffect, useState } from 'react';
import type { GraphViewerDocumentChunk, GraphViewerEdge, GraphViewerNode } from './graph-viewer';

type GraphDocumentChunksResponse =
  | { readonly chunks: readonly GraphViewerDocumentChunk[] }
  | { readonly error: { readonly code: string; readonly message: string } };

/**
 * Displays graph item properties and loads document chunks when a document node is selected.
 *
 * @param item - The graph node or edge whose details are displayed.
 * @param projectSlug - The project used to load document chunks for document nodes.
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
  const [chunks, setChunks] = useState<readonly GraphViewerDocumentChunk[] | undefined>();
  const [chunksError, setChunksError] = useState<string | undefined>();
  const [isLoadingChunks, setIsLoadingChunks] = useState(false);
  const propertyRows = Object.entries(item.properties).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const documentId = 'source' in item ? undefined : readGraphNodeDocumentId(item);
  const selectedChunk =
    selectedChunkState?.itemId === item.id ? selectedChunkState.chunk : undefined;

  useEffect(() => {
    setSelectedChunkState(undefined);
    if (!documentId) {
      setChunks(undefined);
      setChunksError(undefined);
      setIsLoadingChunks(false);
      return;
    }

    let cancelled = false;
    setChunks(undefined);
    setChunksError(undefined);
    setIsLoadingChunks(true);

    void (async () => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectSlug)}/graph/document-chunks?documentId=${encodeURIComponent(documentId)}`,
        );
        const body = (await response.json()) as GraphDocumentChunksResponse;
        if (cancelled) {
          return;
        }
        if (!response.ok || 'error' in body) {
          throw new Error('error' in body ? body.error.message : 'Failed to load document chunks.');
        }
        setChunks(body.chunks);
      } catch (caught) {
        if (!cancelled) {
          setChunks(undefined);
          setChunksError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingChunks(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
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
            {isLoadingChunks ? (
              <span className="mono">Loading...</span>
            ) : chunks ? (
              <span className="mono">{chunks.length} chunks</span>
            ) : null}
          </div>
          {chunksError ? (
            <p className="action-error" data-testid="graph-chunk-error">
              {chunksError}
            </p>
          ) : isLoadingChunks ? (
            <p className="notice">チャンクを読み込んでいます。</p>
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
                    // biome-ignore lint/a11y/useSemanticElements: table row layout requires tr; role conveys interactivity to assistive tech
                    <tr
                      aria-label={`Chunk ${chunk.chunkIndex} の詳細を表示`}
                      data-testid="graph-chunk-row"
                      key={chunk.id}
                      onClick={() => setSelectedChunkState({ chunk, itemId: item.id })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedChunkState({ chunk, itemId: item.id });
                        }
                      }}
                      role="button"
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

function readGraphNodeDocumentId(node: GraphViewerNode): string | undefined {
  const documentId = node.properties.documentId;
  return typeof documentId === 'string' && documentId ? documentId : undefined;
}

function truncateChunkPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  let preview = '';
  let count = 0;
  for (const character of normalized) {
    if (count >= 120) {
      return `${preview}…`;
    }
    preview += character;
    count += 1;
  }
  return preview;
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
