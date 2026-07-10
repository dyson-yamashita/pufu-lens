export type FloatingPanelBounds = {
  readonly panelHeight: number;
  readonly panelWidth: number;
  readonly wrapperHeight: number;
  readonly wrapperWidth: number;
};

export type FloatingPanelPosition = {
  readonly x: number;
  readonly y: number;
};

/**
 * Returns the selection that should be shown in the fullscreen-only floating Details dialog.
 *
 * @param isMaximized - Whether the graph is using native or fallback fullscreen.
 * @param selection - The node or edge selected by the user.
 */
export function graphDetailsModalSelection<T>(
  isMaximized: boolean,
  selection: T | undefined,
): T | undefined {
  return isMaximized ? selection : undefined;
}

/**
 * Clamps a floating panel position so it stays within the graph wrapper.
 *
 * @param position - The desired top-left position in wrapper coordinates.
 * @param bounds - The wrapper and panel dimensions used for clamping.
 * @param margin - The minimum inset from each wrapper edge.
 */
export function clampFloatingPanelPosition(
  position: FloatingPanelPosition,
  bounds: FloatingPanelBounds,
  margin = 8,
): FloatingPanelPosition {
  const maxX = Math.max(margin, bounds.wrapperWidth - bounds.panelWidth - margin);
  const maxY = Math.max(margin, bounds.wrapperHeight - bounds.panelHeight - margin);
  return {
    x: Math.min(Math.max(margin, position.x), maxX),
    y: Math.min(Math.max(margin, position.y), maxY),
  };
}

/**
 * Returns the default top-right position for a floating Details panel.
 *
 * @param bounds - The wrapper and panel dimensions used for placement.
 * @param margin - The inset from the top and right wrapper edges.
 */
export function defaultFloatingPanelPosition(
  bounds: FloatingPanelBounds,
  margin = 16,
): FloatingPanelPosition {
  return clampFloatingPanelPosition(
    {
      x: bounds.wrapperWidth - bounds.panelWidth - margin,
      y: margin,
    },
    bounds,
    margin,
  );
}
