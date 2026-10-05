/**
 * @file index.ts
 * @description @skynote/editor 统一导出入口与常用类型重导出
 */

export * from './editor';

export type {
  CanvasTheme,
  CreateNodeRequest,
  HistoryChangeListener,
  LayerMove,
  NodeEntity,
  NodeStyle,
  Point,
  ViewportState
} from '@skynote/core';
