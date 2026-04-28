// Migration shim. Workers converting input.js DELETE this file.
import type { OverlayManager } from './overlay.js';
import type { Viewer } from './viewer.js';

export const TOOL_MOVE: 'move';
export const TOOL_POI: 'poi';

export type Tool = typeof TOOL_MOVE | typeof TOOL_POI;

export interface InputController {
  setTool(newTool: Tool): void;
  getTool(): Tool;
  onToolChange(cb: (tool: Tool) => void): void;
}

export function attachInput(options: {
  viewer: Viewer;
  overlays: OverlayManager;
  onChange: () => void;
}): InputController;
