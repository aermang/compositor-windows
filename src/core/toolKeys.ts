// Tool-specific key routing. CanvasView's keydown handler forwards here after
// its built-in handlers (lasso/crop keys, Escape/Enter for floating…), so tools
// that need keys (pen: Enter closes, Esc cancels) register a handler instead of
// editing CanvasView. A handler returns true when it consumed the event.

type ToolKeyHandler = (e: KeyboardEvent) => boolean;

const handlers = new Set<ToolKeyHandler>();

export function onToolKey(fn: ToolKeyHandler): () => void {
  handlers.add(fn);
  return () => { handlers.delete(fn); };
}

export function routeToolKey(e: KeyboardEvent): boolean {
  for (const h of handlers) if (h(e)) return true;
  return false;
}
