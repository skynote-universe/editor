/**
 * @file index.ts
 * @description @skynote/editor 统一导出入口：编辑器门面，以及界面会用到的类型与纯函数 (界面不必直接依赖内核与插件包)
 */

export * from './editor';

export {
  CANVAS_PALETTE,
  applyPatches,
  expandCornerRadius,
  generateId,
  mixHexColors,
  parseCanvasDocument
} from '@skynote/core';
export type {
  CanvasDocument,
  CanvasPatch,
  CanvasTheme,
  CanvasThemeConfig,
  CanvasThemeSeed,
  CornerRadius,
  CreateNodeRequest,
  DocumentChangeSet,
  HistoryChangeListener,
  InputScope,
  LayerMove,
  NodeEntity,
  NodeStyle,
  ParseResult,
  Point,
  RadiusCorner,
  RectBounds,
  RichTextStylePatch,
  TextAlign,
  VerticalAlign,
  ViewportState
} from '@skynote/core';
export { STICKY_COLORS, STICKY_DEFAULT_SIZE, isFormatActive } from '@skynote/plugins-basic';
export type { StickyColor, TextEditPlugin, TextFormat, TextFormatState } from '@skynote/plugins-basic';
