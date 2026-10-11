// Cross-module UI modal state consumed by the canvas view. transformHandles
// switches the canvas into free-transform mode (8 handles + rotation, one
// history entry per gesture); editingTextLayerId marks the layer whose text is
// being edited by the in-canvas InlineTextEditor; showRulers toggles the ruler
// overlay around the document. All are toggled from anywhere (toolbars,
// commands, panels) that imports this module.

import { reactive } from 'vue';

export const uiFlags = reactive({
  transformHandles: false,
  editingTextLayerId: null as string | null,
  showRulers: true,
});
