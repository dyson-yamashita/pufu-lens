'use client';

import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PropertyList } from './graph-property-list';
import type { GraphViewerEdge, GraphViewerNode } from './graph-viewer';
import {
  clampFloatingPanelPosition,
  defaultFloatingPanelPosition,
  type FloatingPanelPosition,
} from './graph-viewer-interactions';

export type GraphDetailsSelection =
  | { readonly item: GraphViewerEdge; readonly type: 'edge' }
  | { readonly item: GraphViewerNode; readonly type: 'node' };

type DragState = {
  readonly originX: number;
  readonly originY: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
};

/**
 * Renders a non-blocking, draggable floating Details dialog inside the graph wrapper.
 *
 * @param onClose - Called when the user closes the dialog.
 * @param selection - The selected node or edge to display.
 * @param wrapperElement - The fullscreen graph wrapper used for positioning and clamping.
 */
export function GraphDetailsDialog({
  onClose,
  selection,
  wrapperElement,
}: {
  readonly onClose: () => void;
  readonly selection: GraphDetailsSelection;
  readonly wrapperElement: HTMLElement | null;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [position, setPosition] = useState<FloatingPanelPosition | null>(null);

  const measureBounds = useCallback(() => {
    const wrapper = wrapperElement;
    const panel = panelRef.current;
    if (!wrapper || !panel) {
      return undefined;
    }
    return {
      panelHeight: panel.offsetHeight,
      panelWidth: panel.offsetWidth,
      wrapperHeight: wrapper.clientHeight,
      wrapperWidth: wrapper.clientWidth,
    };
  }, [wrapperElement]);

  const clampPosition = useCallback(
    (next: FloatingPanelPosition) => {
      const bounds = measureBounds();
      if (!bounds) {
        return next;
      }
      return clampFloatingPanelPosition(next, bounds);
    },
    [measureBounds],
  );

  const fitPositionToBounds = useCallback(() => {
    const bounds = measureBounds();
    if (!bounds) {
      return;
    }
    setPosition((current) => {
      const next = current
        ? clampFloatingPanelPosition(current, bounds)
        : defaultFloatingPanelPosition(bounds);
      return current && current.x === next.x && current.y === next.y ? current : next;
    });
  }, [measureBounds]);

  useEffect(() => {
    const wrapper = wrapperElement;
    const panel = panelRef.current;
    if (!wrapper || !panel) {
      return;
    }
    fitPositionToBounds();
    const observer = new ResizeObserver(fitPositionToBounds);
    observer.observe(wrapper);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [fitPositionToBounds, wrapperElement]);

  const handleHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !position) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      originX: position.x,
      originY: position.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  const handleHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPosition(
      clampPosition({
        x: drag.originX + (event.clientX - drag.startX),
        y: drag.originY + (event.clientY - drag.startY),
      }),
    );
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.stopPropagation();
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="false"
      className="graph-details-floating-dialog"
      data-testid="graph-details-dialog"
      onPointerDown={(event) => event.stopPropagation()}
      role="dialog"
      style={
        position
          ? {
              left: `${position.x}px`,
              top: `${position.y}px`,
            }
          : { visibility: 'hidden' }
      }
    >
      <div className="graph-details-floating-card" ref={panelRef}>
        <button
          aria-label="Detailsを閉じる"
          className="modal-close-button"
          data-testid="graph-details-dialog-close-button"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
        <div
          className="graph-details-floating-header"
          onPointerCancel={finishDrag}
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={finishDrag}
        >
          <h2 id={titleId}>Details</h2>
          <p className="mono">{selection.type}</p>
        </div>
        <div className="graph-details-floating-scroll">
          <PropertyList item={selection.item} />
        </div>
      </div>
    </div>
  );
}
