/**
 * Returns the selection that should be shown in the fullscreen-only Details modal.
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
