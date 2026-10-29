import { describe, expect, it, vi } from 'vitest';
import type { CanvasExportRequest, CanvasRenderer } from '@skynote/core';
import { SkyNoteEditor } from '../src';

const result = { data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' as const, width: 132, height: 132 };

function setup(exportImage: NonNullable<CanvasRenderer['export']>, formats: readonly string[] = ['png']) {
  const renderer = {
    fonts: { measureWidth: () => 0 },
    mount: () => ({ destroy() {}, export: exportImage, exportFormats: formats })
  };
  const editor = new SkyNoteEditor({ renderer });
  editor.createNode({ nodeType: 'shape', x: -100, y: -200, width: 100, height: 100 });
  editor.mount({});
  return editor;
}

describe('图片导出门面', () => {
  it('通用导出能力未声明PNG时，不开放PNG便捷入口', async () => {
    const exporting = vi.fn(async () => result);
    const editor = setup(exporting, ['jpeg']);
    try {
      expect(editor.canExportPng).toBe(false);
      await expect(editor.exportPng()).rejects.toThrow('不支持PNG');
      expect(exporting).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });
  it('包含离屏实体，保留会话与历史，导出期间拒绝写入，完成后释放', async () => {
    let finish!: () => void;
    const exportPng = vi.fn((request: CanvasExportRequest) => {
      expect(request.format).toBe('png');
      expect(request.bounds).toEqual({ left: -116, top: -216, right: 10066, bottom: 10066 });
      return new Promise<typeof result>((resolve) => (finish = () => resolve(result)));
    });
    const editor = setup(exportPng);
    editor.createNode({ nodeType: 'shape', x: 10000, y: 10000, width: 50, height: 50 });
    const document = editor.exportDocument();
    const viewport = { ...editor.viewport };
    const history = editor.getHistorySnapshot();
    try {
      // 大范围通过降低倍率控制输出像素预算。
      const saving = editor.exportPng({ scale: 0.25 });
      await vi.waitFor(() => expect(exportPng).toHaveBeenCalled());
      expect(editor.createNode({ nodeType: 'shape', x: 0, y: 0 })).toBeNull();
      await expect(editor.exportPng()).rejects.toThrow('正在导出');
      finish();
      await expect(saving).resolves.toEqual(result);
      expect(editor.exportDocument()).toEqual(document);
      expect(editor.viewport).toEqual(viewport);
      expect(editor.getHistorySnapshot()).toEqual(history);
      expect(editor.createNode({ nodeType: 'shape', x: 0, y: 0 })).toBeTruthy();
    } finally {
      editor.destroy();
    }
  });

  it('空选区和超大尺寸提前拒绝，失败后恢复写入', async () => {
    const exportPng = vi.fn(async () => {
      throw new Error('图片无法解码');
    });
    const editor = setup(exportPng);
    try {
      editor.select([]);
      await expect(editor.exportPng({ scope: 'selection' })).rejects.toThrow('请先选择');
      await expect(editor.exportPng({ scale: Number.NaN })).rejects.toThrow('尺寸过大');
      expect(exportPng).not.toHaveBeenCalled();
      await expect(editor.exportPng()).rejects.toThrow('图片无法解码');
      expect(editor.createNode({ nodeType: 'shape', x: 0, y: 0 })).toBeTruthy();
    } finally {
      editor.destroy();
    }
  });

  it('取消和卸载会传递取消信号，恢复写入且不返回过期结果', async () => {
    let signal!: AbortSignal;
    const editor = setup((request) => {
      signal = request.signal;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('取消')), { once: true })
      );
    });
    try {
      const saving = editor.exportPng();
      const rejected = expect(saving).rejects.toThrow('取消');
      await vi.waitFor(() => expect(signal).toBeDefined());
      editor.unmount();
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(editor.createNode({ nodeType: 'shape', x: 0, y: 0 })).toBeTruthy();
    } finally {
      editor.destroy();
    }
  });
});
