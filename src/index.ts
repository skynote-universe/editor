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
  CanvasAssetMeta,
  CanvasPatch,
  AssetAdapter,
  AssetResolveOptions,
  AssetUploadResult,
  CanvasTheme,
  CanvasThemeConfig,
  CanvasThemeSeed,
  ConnectorEntity,
  ConnectorStyle,
  CornerRadius,
  CreateNodeRequest,
  DocumentChangeSet,
  EntityIds,
  EntityRefs,
  HistoryChangeListener,
  InputScope,
  ImageFit,
  ImageLoadState,
  ImageLoadFailure,
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
export type {
  ConnectNodeRequest,
  ConnectorDropEvent,
  StickyColor,
  ImageCreateOptions,
  ImageNodeFields,
  TextEditPlugin,
  TextFormat,
  TextFormatState
} from '@skynote/plugins-basic';
export { ImageNodeType } from '@skynote/plugins-basic';
