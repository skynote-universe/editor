import { describe, expect, it, vi } from 'vitest';
import { DETACHED_CANVAS_HOST } from '@skynote/core';
import { SkyNoteEditor } from '../src';

function setup() {
  const editor = new SkyNoteEditor({
    renderer: {
      fonts: { measureWidth: () => 0 },
      mount(engine) {
        engine.session.setViewportSize({ width: 1000, height: 800 });
        return { destroy() {} };
      }
    }
  });
  const id = editor.createNode({ nodeType: 'shape', x: 1500, y: 1000, width: 100, height: 100 })!;
  editor.mount({});
  return { editor, id };
}

describe('内容导航', () => {
  it('保留缩放，在面板之外居中，已经可见的目标不再次平移', () => {
    const { editor, id } = setup();
    const history = editor.getHistorySnapshot();
    editor.applyInitialView('preserve', { x: 0, y: 0, zoom: 0.5 });
    try {
      editor.revealEntities({ nodeIds: [id] }, { center: true, insets: { left: 300 } });
      expect(editor.viewport.zoom).toBe(0.5);
      expect(editor.worldToScreen({ x: 1550, y: 1050 })).toEqual({ x: 650, y: 400 });
      const changed = vi.fn();
      const stop = editor.onViewportChange(changed);
      editor.revealEntities({ nodeIds: [id] }, { insets: { left: 300 } });
      expect(changed).not.toHaveBeenCalled();
      expect(editor.getHistorySnapshot()).toEqual(history);
      stop();
    } finally {
      editor.destroy();
    }
  });

  it('预览与选区/文档分离，随位置更新并在释放后停止绘制', () => {
    const { editor, id } = setup();
    const draw = vi.fn();
    const clear = vi.fn();
    const detach = editor.engine.attachHost({ ...DETACHED_CANVAS_HOST, overlay: { setPrimitives: draw, clear } });
    editor.select([]);
    const document = editor.exportDocument();
    try {
      const release = editor.previewEntities({ nodeIds: [id] });
      expect(draw).toHaveBeenCalledOnce();
      expect(editor.selectedNodeIds.size).toBe(0);
      expect(editor.exportDocument()).toEqual(document);
      editor.engine.documentStore.moveEntities({ nodeIds: [id] }, { x: 50 });
      expect(draw).toHaveBeenCalledTimes(2);
      release();
      expect(clear).toHaveBeenCalled();
      draw.mockClear();
      editor.zoomAt(1.2);
      expect(draw.mock.calls.filter(([channel]) => String(channel).startsWith('editor:preview:'))).toHaveLength(0);
    } finally {
      detach();
      editor.destroy();
    }
  });
});
