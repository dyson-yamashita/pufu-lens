import type { GraphViewerEdge, GraphViewerNode } from './graph-viewer';

/**
 * Renders the property list for a graph node or edge.
 *
 * @param item - The selected graph node or edge.
 */
export function PropertyList({ item }: { readonly item: GraphViewerEdge | GraphViewerNode }) {
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
