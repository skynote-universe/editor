/** 数值连续编辑必须使用起始数据，而不是依赖撤销合并来消除取整误差。 */
import { describe, expect, it, vi } from 'vitest';
import { computeWorldFrame, createEmptyCanvasDocument, DocumentStore } from '@skynote/core';
import { SkyNoteEditor } from '../src';

function setup(grouped = false) {
  const doc = createEmptyCanvasDocument();
  for (const [id, x] of [
    ['a', grouped ? 0 : 25],
    ['b', grouped ? 150 : 65]
  ] as const)
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: grouped ? 'frame' : 'rect',
      x,
      y: grouped ? 0 : 40,
      width: grouped ? 50 : 10,
      height: grouped ? 50 : 10,
      rotation: 0,
      zIndex: id === 'a' ? 'a0' : 'a1',
      locked: false,
      ...(grouped ? { textBlocks: [{ id: 'title', runs: [{ text: '文字', fontSize: 18 }] }] } : { parentId: 'f' })
    };
  if (!grouped)
    doc.content.nodes.f = {
      id: 'f',
      type: 'node',
      nodeType: 'frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
  const editor = new SkyNoteEditor({
    initialDoc: doc,
    renderer: {
      fonts: { measureWidth: () => 0 },
      mount() {
        return { destroy() {} };
      }
    }
  });
  const store = editor.engine.documentStore;
  const root = grouped ? store.groupNodes(['a', 'b'])! : 'f';
  const link = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
  store.updateConnector(link, { controlPoints: [{ x: 60, y: 50 }] });
  editor.select([root]);
  store.clearHistory();
  return { editor, store, root, link };
}

describe('数值编辑起始快照', () => {
  it.each([200, 400])('%s层嵌套多选带分组只保存成员并集及所属连线，复用后结束释放', (depth) => {
    const doc = createEmptyCanvasDocument();
    const ids = Array.from({ length: depth }, (_, i) => `frame-${i}`);
    for (const [i, id] of ids.entries())
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
        ...(i ? { parentId: ids[i - 1] } : {})
      };
    const editor = new SkyNoteEditor({
      initialDoc: doc,
      renderer: {
        fonts: { measureWidth: () => 0 },
        mount() {
          return { destroy() {} };
        }
      }
    });
    const store = editor.engine.documentStore;
    const a = store.createNode({ nodeType: 'frame', parentId: ids.at(-1), x: 10, y: 40, width: 10, height: 10 })!;
    const b = store.createNode({ nodeType: 'frame', parentId: ids.at(-1), x: 70, y: 40, width: 10, height: 10 })!;
    const link = store.createConnector({ from: { nodeId: a }, to: { nodeId: b } })!;
    store.updateConnector(link, { controlPoints: [{ x: 60, y: 50 }] });
    editor.select(ids);
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    const capture = store.captureConnectorTransformSnapshot.bind(store);
    let memberEntries = 0;
    let connectorEntries = 0;
    let captureAncestorQueries = 0;
    const ancestors = vi.spyOn(editor.engine.entityStore, 'getAncestorIds');
    const captures = vi
      .spyOn(store, 'captureConnectorTransformSnapshot')
      .mockImplementation((targets, frame, excluded) => {
        const beforeQueries = ancestors.mock.calls.length;
        const snapshot = capture(targets, frame, excluded);
        captureAncestorQueries += ancestors.mock.calls.length - beforeQueries;
        memberEntries += snapshot.nodeIds.length;
        connectorEntries += snapshot.controlPoints.size;
        return snapshot;
      });
    editor.setNodeRotation(ids, 1, { groupId: 'nested' });
    expect(memberEntries).toBe(depth + 2);
    expect(connectorEntries).toBe(1);
    expect(captureAncestorQueries).toBe(0);
    expect(captures).toHaveBeenCalledTimes(depth);
    editor.setNodeRotation(ids, 2, { groupId: 'nested' });
    expect(captures).toHaveBeenCalledTimes(depth);
    const radians = (depth * 2 * Math.PI) / 180;
    expect(store.getConnector(link)!.controlPoints).toEqual([
      { x: Math.round(50 + 10 * Math.cos(radians)), y: Math.round(50 + 10 * Math.sin(radians)) }
    ]);
    editor.setNodeRotation(ids, 0, { groupId: 'nested' });
    expect(store.getView().content).toEqual(before);
    editor.endGeometryEdit('nested');
    editor.setNodeRotation(ids, 1, { groupId: 'nested' });
    expect(captures).toHaveBeenCalledTimes(depth * 2);
    captures.mockRestore();
    ancestors.mockRestore();
    editor.destroy();
  });

  it('未被独立作用域捕获的跨目标连线发生外部修改时仍中断会话', () => {
    const { editor, store, root } = setup();
    const outer = store.createNode({ nodeType: 'frame', x: 0, y: 0, width: 100, height: 100 })!;
    store.updateNode(root, { parentId: outer });
    const cross = store.createConnector({ from: { nodeId: outer }, to: { nodeId: 'a' } })!;
    store.updateConnector(cross, { controlPoints: [{ x: 70, y: 70 }] });
    editor.select([outer, root]);
    const capture = vi.spyOn(store, 'captureConnectorTransformSnapshot');
    editor.setNodeRotation([outer, root], 1, { groupId: 'cross' });
    expect(capture).toHaveBeenCalledTimes(2);
    store.updateConnector(cross, { controlPoints: [{ x: 80, y: 80 }] });
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation([outer, root], 2, { groupId: 'cross' });
    expect(capture).toHaveBeenCalledTimes(4);
    store.undo();
    expect(store.getView().content).toEqual(before);
    capture.mockRestore();
    editor.destroy();
  });

  it.each([
    ['f', 'a'],
    ['a', 'f']
  ])('父子同时选中按局部角度设置，目标顺序%s/%s不影响结果', (first, second) => {
    const { editor, store } = setup();
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation([first, second], 30);
    expect(store.getNode('f')!.rotation).toBe(30);
    expect(store.getNode('a')!.rotation).toBe(30);
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getNode('a')!.rotation).toBe(30);
    editor.destroy();
  });

  it('子节点已是目标角度也必须换算选中祖先变化', () => {
    const { editor, store } = setup();
    store.updateNode('a', { rotation: 30 });
    editor.setNodeRotation(['f', 'a'], 30);
    expect(store.getNode('f')!.rotation).toBe(30);
    expect(store.getNode('a')!.rotation).toBe(30);
    editor.destroy();
  });

  it('组合与其画框成员同时设角度后，局部角度及单步撤销保持', () => {
    const { editor, store, root } = setup(true);
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation([root, 'a'], 30, { groupId: 'group-angle' });
    expect(store.getNode(root)!.rotation).toBe(30);
    expect(store.getNode('a')!.rotation).toBe(30);
    store.undo();
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('隔代与多层选中支持非零起始角，未选中的中间祖先保持局部角度', () => {
    const { editor, store } = setup();
    const middle = store.createNode({ nodeType: 'frame', x: 10, y: 10, width: 100, height: 100, parentId: 'f' })!;
    store.updateNode(middle, { rotation: 15 });
    store.updateNode('f', { rotation: 10 });
    store.updateNode('a', { parentId: middle, rotation: 20 });
    store.updateNode('b', { parentId: 'a', rotation: 30 });
    const ids = ['b', 'f', 'a'];
    const centers = ids.map((id) =>
      computeWorldFrame(store.getNode(id)!, editor.engine.entityStore.getWorldTransform(id)!)
    );
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation(ids, 60, { groupId: 'nested' });
    for (const [i, id] of ids.entries()) {
      expect(store.getNode(id)!.rotation).toBe(60);
      const frame = computeWorldFrame(store.getNode(id)!, editor.engine.entityStore.getWorldTransform(id)!);
      expect(Math.abs(frame.cx - centers[i].cx)).toBeLessThan(1);
      expect(Math.abs(frame.cy - centers[i].cy)).toBeLessThan(1);
    }
    expect(store.getNode(middle)!.rotation).toBe(15);
    store.undo();
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('父子细步、往返及完整历史恢复保持内部连线的累计世界旋转', () => {
    const { editor, store, link } = setup();
    const outer = store.createNode({ nodeType: 'frame', x: 0, y: 0, width: 100, height: 100 })!;
    store.updateNode('f', { parentId: outer });
    editor.select([outer, 'f']);
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation([outer, 'f'], 90);
    const expected = structuredClone(store.getView().content);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 40, y: 50 }]);
    store.undo();
    store.clearHistory();
    for (let angle = 1; angle <= 90; angle++) editor.setNodeRotation([outer, 'f'], angle, { groupId: 'nested' });
    expect(store.getView().content).toEqual(expected);
    const recovered = new DocumentStore();
    expect(
      recovered.restoreRecovery(
        JSON.parse(JSON.stringify(store.getView())),
        JSON.parse(JSON.stringify(store.getHistorySnapshot()))
      )
    ).toEqual({ ok: true });
    expect(recovered.undo()).toBe(true);
    expect(recovered.getView().content).toEqual(before);
    expect(recovered.redo()).toBe(true);
    expect(recovered.getView().content).toEqual(expected);
    for (let angle = 89; angle >= 0; angle--) editor.setNodeRotation([outer, 'f'], angle, { groupId: 'nested' });
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('共享深层祖先按并集求解，避免每个目标重复遍历父链', () => {
    const { editor, store } = setup();
    let parentId = 'f';
    for (let i = 0; i < 200; i++)
      parentId = store.createNode({ nodeType: 'frame', parentId, x: 0, y: 0, width: 100, height: 100 })!;
    const ids = Array.from({ length: 100 }, (_, i) =>
      store.createNode({ nodeType: 'frame', parentId, x: i * 2, y: 0, width: 10, height: 10 })!
    );
    const reads = vi.spyOn(store, 'getNode');
    editor.setNodeRotation(ids, 30);
    expect(reads.mock.calls.length).toBeLessThan(1000);
    reads.mockRestore();
    for (const id of ids) expect(store.getNode(id)!.rotation).toBe(30);
    editor.destroy();
  });

  it('角度90次细步、往返及撤销重做保持内部拐点', () => {
    const { editor, store, root, link } = setup();
    const before = structuredClone(store.getView().content);
    for (let angle = 1; angle <= 90; angle++) editor.setNodeRotation([root], angle, { groupId: 'angle' });
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 60 }]);
    const after = structuredClone(store.getView().content);
    for (let angle = 89; angle >= 0; angle--) editor.setNodeRotation([root], angle, { groupId: 'angle' });
    expect(store.getView().content).toEqual(before);
    editor.setNodeRotation([root], 90, { groupId: 'angle' });
    editor.endGeometryEdit('angle');
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    editor.destroy();
  });

  it('组合宽度细步加倍与一次加倍完全一致，并恢复起始字号', () => {
    const { editor, store, root } = setup(true);
    const width = store.getNode(root)!.width;
    const before = structuredClone(store.getView().content);
    editor.setNodeSize([root], { width: width * 2 });
    const expected = structuredClone(store.getView().content);
    store.undo();
    store.clearHistory();
    for (let next = width + 1; next <= width * 2; next++)
      editor.setNodeSize([root], { width: next }, { groupId: 'size' });
    expect(store.getView().content).toEqual(expected);
    expect(store.getNode('a')!.textBlocks![0].runs[0].fontSize).toBe(36);
    editor.setNodeSize([root], { width }, { groupId: 'size' });
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('结束分组后重新起算，新撤销只恢复到本次开始', () => {
    const { editor, store, root, link } = setup();
    editor.setNodeRotation([root], 30, { groupId: 'same' });
    editor.endGeometryEdit('same');
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation([root], 90, { groupId: 'same' });
    expect(store.getConnector(link)!.controlPoints).not.toEqual(before.connectors[link].controlPoints);
    store.undo();
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('相关外部修改结束会话，下一次修改和撤销不覆盖外部结果', () => {
    const { editor, store, root, link } = setup();
    editor.setNodeRotation([root], 30, { groupId: 'angle' });
    store.updateConnector(link, { controlPoints: [{ x: 75, y: 75 }] });
    const before = structuredClone(store.getView().content);
    editor.setNodeRotation([root], 60, { groupId: 'angle' });
    store.undo();
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('无关事务不重置角度起点', () => {
    const { editor, store, root, link } = setup();
    editor.setNodeRotation([root], 1, { groupId: 'angle' });
    store.createNode({ nodeType: 'frame', x: 500, y: 500 });
    for (let angle = 2; angle <= 90; angle++) editor.setNodeRotation([root], angle, { groupId: 'angle' });
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 60 }]);
    editor.destroy();
  });

  it('多选绝对角度维持各自中心，不发生整体公转', () => {
    const { editor, store, root } = setup();
    const other = store.createNode({ nodeType: 'frame', x: 300, y: 0, width: 100, height: 100 })!;
    editor.select([root, other]);
    for (let angle = 1; angle <= 90; angle++) editor.setNodeRotation([root, other], angle, { groupId: 'multi-angle' });
    expect(store.getNode(root)).toMatchObject({ x: 0, y: 0, rotation: 90 });
    expect(store.getNode(other)).toMatchObject({ x: 300, y: 0, rotation: 90 });
    editor.destroy();
  });

  it.each(['selection', 'readonly', 'unmount'] as const)('%s 结束旧编辑，复用调用分组仍另起撤销步骤', (boundary) => {
    const { editor, store, root } = setup();
    editor.setNodeRotation([root], 30, { groupId: 'angle' });
    const before = structuredClone(store.getView().content);
    if (boundary === 'selection') {
      editor.select([]);
      editor.select([root]);
    } else if (boundary === 'readonly') {
      editor.setReadOnly(true);
      editor.setReadOnly(false);
    } else editor.unmount();
    editor.setNodeRotation([root], 60, { groupId: 'angle' });
    store.undo();
    expect(store.getView().content).toEqual(before);
    editor.destroy();
  });

  it('旧分组结束通知不会清除正在进行的另一个分组', () => {
    const { editor, store, root, link } = setup();
    editor.setNodeRotation([root], 1, { groupId: 'active' });
    editor.endGeometryEdit('old');
    for (let angle = 2; angle <= 90; angle++) editor.setNodeRotation([root], angle, { groupId: 'active' });
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 60 }]);
    editor.destroy();
  });

  it('尺寸往返恢复起始文本继承，相关类型替换会重新起算', () => {
    const { editor, store, root } = setup(true);
    store.updateNodes(['a', 'b'], {
      textStyle: { fontSize: 18 },
      textBlocks: [{ id: 'title', runs: [{ text: '文字' }] }]
    });
    const before = structuredClone(store.getView().content);
    const width = store.getNode(root)!.width;
    editor.setNodeSize([root], { width: width * 2 }, { groupId: 'size' });
    editor.setNodeSize([root], { width }, { groupId: 'size' });
    expect(store.getView().content).toEqual(before);
    const definition = editor.engine.nodeTypes.get('frame')!;
    editor.engine.nodeTypes.register({ ...definition });
    const baseline = structuredClone(store.getView().content);
    editor.setNodeSize([root], { width: width * 2 }, { groupId: 'size' });
    store.undo();
    expect(store.getView().content).toEqual(baseline);
    editor.destroy();
  });
});
