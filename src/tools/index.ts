// Tool registry. The canvas view routes pointer events here with document-space
// coordinates; each tool mutates the store and bumps ticks to trigger re-render.

import type { ToolId } from '../core/store';

export interface ToolEvent {
  doc: { x: number; y: number };
  screen: { x: number; y: number };
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  original: PointerEvent | WheelEvent;
}

export interface Tool {
  id: ToolId;
  cursor?: string;
  onDown?(e: ToolEvent): void;
  onDrag?(e: ToolEvent): void;   // pointermove while a stroke is active
  onHover?(e: ToolEvent): void;  // pointermove with no button
  onUp?(e: ToolEvent): void;
  onDoubleClick?(e: ToolEvent): void;
}

export const tools: Partial<Record<ToolId, Tool>> = {};

function register(tool: Tool) {
  tools[tool.id] = tool;
}

import { moveTool } from './move';
import { marqueeTool, lassoTool, wandTool } from './select';
import { brushTool, eraserTool, cloneTool } from './paint';
import { cropTool } from './crop';
import { shapeTool, gradientTool, textTool, eyedropperTool } from './create';
import { penTool } from './pen';
import { healTool } from './heal';
import { dodgeTool } from './dodge';
import { patchTool } from './patch';
import { camoveTool } from './camove';

[moveTool, marqueeTool, lassoTool, wandTool, brushTool, eraserTool, cloneTool,
  cropTool, shapeTool, gradientTool, textTool, eyedropperTool, penTool, healTool,
  dodgeTool, patchTool, camoveTool].forEach(register);

export function toolFor(id: ToolId): Tool | null {
  return tools[id] ?? null;
}
