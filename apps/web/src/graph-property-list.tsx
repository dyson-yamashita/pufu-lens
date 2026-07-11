import { useState } from 'react';
import type { GraphViewerDocumentChunk, GraphViewerEdge, GraphViewerNode } from './graph-viewer';

/**
 * Renders the property list for a graph node or edge.
 *
 * @param item - The selected graph node or edge.
 */
export function PropertyList({ item }: { readonly item: GraphViewerEdge | GraphViewerNode }) {
  const [selectedChunkState, setSelectedChunkState] = useState<
    | {
        readonly chunk: GraphViewerDocumentChunk;
        readonly itemId: string;
      }
    | undefined
  >();
  const propertyRows = Object.entries(item.properties).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const chunks = 'chunks' in item ? item.chunks : undefined;
  const selectedChunk =
    selectedChunkState?.itemId === item.id ? selectedChunkState.chunk : undefined;

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
      {chunks ? (
        <section className="graph-chunk-list" data-testid="graph-chunk-list">
          <div className="graph-chunk-list-heading">
            <h3>Chunks</h3>
            <span className="mono">{chunks.length} chunks</span>
          </div>
          {chunks.length ? (
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
