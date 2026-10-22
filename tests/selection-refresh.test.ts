/** 真实编辑门面同时覆盖控制柄刷新与数值会话，避免只约束几何规划或快照阶段。 */
import { expect, it, vi } from 'vitest';
import { createEmptyCanvasDocument } from '@skynote/core';
import { SkyNoteEditor } from '../src';

it.each([
  [200, true],
  [400, true],
  [200, false],
  [400, false]
] as const)('%s层共享父链，多选嵌套=%s时选区及连续角度输入读取保持线性', (depth, nested) => {
  const doc = createEmptyCanvasDocument();
  const chain = Array.from({ length: depth }, (_, i) => `f${i}`);
  const leaves = Array.from({ length: 100 }, (_, i) => `leaf${i}`);
  for (const [i, id] of chain.entries())
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: chain[i - 1] } : {})
    };
  if (!nested)
    for (const id of leaves)
      doc.content.nodes[id] = {
        id,
        type: 'node',
        nodeType: 'frame',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        zIndex: 'a0',
        locked: false,
        parentId: chain.at(-1)
      };
  const ids = nested ? chain : leaves;
  const editor = new SkyNoteEditor({
    initialDoc: doc,
    renderer: {
      fonts: { measureWidth: () => 0 },
      mount() {
        return { destroy() {} };
      }
    }
  });
  const ancestors = vi.spyOn(editor.engine.entityStore, 'getAncestorIds');
  const reads = vi.spyOn(editor.engine.entityStore, 'getNode');
  const verify = (): void => {
    expect(ancestors).not.toHaveBeenCalled();
    expect(reads.mock.calls.length).toBeLessThan((depth + ids.length) * 24);
    ancestors.mockClear();
    reads.mockClear();
  };
  try {
    editor.select(ids);
    verify();
    editor.setNodeRotation(ids, 1, { groupId: 'angle' });
    verify();
    editor.setNodeRotation(ids, 2, { groupId: 'angle' });
    verify();
    for (const id of ids) expect(editor.engine.documentStore.getNode(id)!.rotation).toBe(2);
    expect(editor.engine.documentStore.undo()).toBe(true);
    for (const id of ids) expect(editor.engine.documentStore.getNode(id)!.rotation).toBe(0);
    expect(editor.engine.documentStore.redo()).toBe(true);
    for (const id of ids) expect(editor.engine.documentStore.getNode(id)!.rotation).toBe(2);
  } finally {
    ancestors.mockRestore();
    reads.mockRestore();
    editor.destroy();
  }
});
