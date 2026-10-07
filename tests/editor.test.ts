/**
 * @file editor.test.ts
 * @description 编辑器标准装配：基础插件、渲染适配器生命周期与视口命令
 *
 * 用替身适配器测试：编辑器不依赖任何渲染引擎，只经 RenderAdapter 协议挂载与卸载。
 */

import { describe, it, expect } from 'vitest';
import {
  DETACHED_CANVAS_HOST,
  SyntheticPointerEvent,
  type CanvasRenderer,
  type RenderAdapter,
  type SkyNoteEngine,
  type SkyNotePlugin,
  type FontMeasurer
} from '@skynote/core';
import { SELECTION_PLUGIN_ID } from '@skynote/plugins-basic';
import { SkyNoteEditor } from '../src';

/** 替身容器：只有像素尺寸 */
interface FakeContainer {
  width: number;
  height: number;
}

/** 替身适配器：挂载时像真实渲染器一样挂宿主、上报视口尺寸，并记录生命周期 */
class FakeAdapter implements RenderAdapter<FakeContainer> {
  readonly fonts: FontMeasurer = { measureWidth: () => 0 };
  readonly mounted: FakeContainer[] = [];
  destroyed = 0;

  mount(engine: SkyNoteEngine, container: FakeContainer): CanvasRenderer {
    this.mounted.push(container);
    const detach = engine.attachHost({ ...DETACHED_CANVAS_HOST });
    engine.session.setViewportSize(container);
    return {
      destroy: () => {
        detach();
        this.destroyed++;
      }
    };
  }
}

describe('SkyNoteEditor', () => {
  it('创建即装好基础节点与交互插件并注入适配器的字体测量器，额外插件装在其后', () => {
    let installed = false;
    const extra: SkyNotePlugin = {
      id: 'extra',
      name: '额外插件',
      version: '1.0.0',
      install: () => {
        installed = true;
      }
    };
    const editor = new SkyNoteEditor({ renderer: new FakeAdapter(), plugins: [extra] });
    const { engine } = editor;

    expect(['sticky', 'free-text', 'shape'].every((type) => engine.nodeTypes.get(type))).toBe(true);
    expect(engine.plugins.get(SELECTION_PLUGIN_ID)).toBeDefined();
    expect(installed).toBe(true);
    editor.destroy();
  });

  it('经适配器挂载与卸载；重新挂载先卸载原渲染器，销毁时一并卸载', () => {
    const adapter = new FakeAdapter();
    const editor = new SkyNoteEditor({ renderer: adapter });
    const { engine } = editor;
    expect(editor.isMounted).toBe(false);

    editor.mount({ width: 1000, height: 800 });
    expect(editor.isMounted).toBe(true);
    expect(engine.host).not.toBe(DETACHED_CANVAS_HOST);
    expect(engine.session.viewportSize).toEqual({ width: 1000, height: 800 });

    editor.mount({ width: 600, height: 400 });
    expect(adapter.destroyed).toBe(1);
    expect(engine.session.viewportSize).toEqual({ width: 600, height: 400 });

    editor.unmount();
    expect(editor.isMounted).toBe(false);
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);

    editor.mount({ width: 800, height: 600 });
    editor.destroy();
    expect(adapter.destroyed).toBe(3);
  });

  it('在视口中心插入节点并选中，一步撤销；适配内容后节点位于视口中央', () => {
    const editor = new SkyNoteEditor({ renderer: new FakeAdapter() });
    const { engine } = editor;
    editor.mount({ width: 1000, height: 800 });
    engine.session.setViewport({ x: 100, y: 50, zoom: 1 });

    const id = editor.insertNodeAtViewportCenter({ nodeType: 'shape', options: { geometry: 'ellipse' } })!;
    const node = engine.documentStore.getNode(id)!;
    // 视口中心 (500, 400) 对应世界点 (400, 350)
    expect(node.x + node.width / 2).toBe(400);
    expect(node.y + node.height / 2).toBe(350);
    expect([...engine.session.selectedNodeIds]).toEqual([id]);

    engine.session.setViewport({ x: -5000, y: 3000 });
    editor.fitContent();
    const { x, y, zoom } = engine.session.viewport;
    expect((node.x + node.width / 2) * zoom + x).toBeCloseTo(500);
    expect((node.y + node.height / 2) * zoom + y).toBeCloseTo(400);

    engine.documentStore.undo();
    expect(engine.documentStore.getNode(id)).toBeUndefined();

    // 在指定世界坐标处插入节点
    const atId = editor.insertNodeAt({ nodeType: 'sticky' }, { x: 250, y: 180 })!;
    const atNode = engine.documentStore.getNode(atId)!;
    expect(atNode.x + atNode.width / 2).toBe(250);
    expect(atNode.y + atNode.height / 2).toBe(180);
    expect([...engine.session.selectedNodeIds]).toEqual([atId]);

    // 门面坐标与视口换算
    const worldP = editor.screenToWorld({ x: 500, y: 400 });
    const screenP = editor.worldToScreen(worldP);
    expect(screenP.x).toBeCloseTo(500);
    expect(screenP.y).toBeCloseTo(400);

    // 门面图元查询与修改
    expect(editor.nodeCount).toBe(1);
    expect(editor.getNode(atId)?.id).toBe(atId);

    editor.updateNodes([atId], { locked: true });
    expect(editor.getNode(atId)?.locked).toBe(true);

    // 带透明度的颜色与导入时一样拆开：界面显示的不透明度即实际效果
    editor.updateNodeStyle([atId], { fill: 'rgba(255, 0, 0, 0.5)', stroke: '#0000FF80' });
    expect(editor.getNode(atId)!.style).toMatchObject({ fill: '#FF0000', fillOpacity: 0.5, stroke: '#0000FF' });
    expect(editor.getNode(atId)!.style!.strokeOpacity).toBeCloseTo(0.5, 2);

    editor.setLocked({ nodeIds: [atId] }, false);
    expect(editor.getNode(atId)?.locked).toBe(false);

    // 门面尺寸、圆角与旋转
    editor.setNodeSize([atId], { width: 300, height: 200 });
    expect(editor.getNode(atId)?.width).toBe(300);
    expect(editor.getNode(atId)?.height).toBe(200);

    editor.setNodeRadius([atId], 16);
    expect(editor.getNode(atId)?.style?.radius).toBe(16);
    // 只改右上角、保留其余三角；四角重新一致时存回单值
    editor.setNodeRadius([atId], 4, { corner: 1 });
    expect(editor.getNode(atId)?.style?.radius).toEqual([16, 4, 16, 16]);
    editor.setNodeRadius([atId], 16, { corner: 1 });
    expect(editor.getNode(atId)?.style?.radius).toBe(16);

    editor.setNodeRotation([atId], 45);
    expect(editor.getNode(atId)?.rotation).toBeCloseTo(45);

    editor.rotateNodesBy([atId], 90);
    expect(editor.getNode(atId)?.rotation).toBeCloseTo(135);

    // 删除与副本走内核命令：容器连同后代一起复制、一起删除
    const store = engine.documentStore;
    store.addNode({ ...store.getNode(atId)!, id: 'child', parentId: atId, x: 0, y: 0, rotation: 0 });
    const [copyId] = editor.duplicateEntities({ nodeIds: [atId] }).nodeIds;
    expect([...engine.session.selectedNodeIds]).toEqual([copyId]);
    expect(engine.entityStore.getChildIds(copyId).size).toBe(1);
    editor.deleteEntities({ nodeIds: [atId, copyId] });
    expect(editor.nodeCount).toBe(0);

    // 颜色解析与历史记录状态
    expect(editor.canUndo).toBe(true);
    expect(editor.resolveColor('canvas-background')).toBeDefined();

    editor.destroy();
  });

  it('连线：进入连线工具画线后回到选择工具；生效样式含线型默认圆角；改样式、线型与删除', () => {
    const editor = new SkyNoteEditor({ renderer: new FakeAdapter() });
    const toolChanges: string[] = [];
    editor.onToolChange(() => toolChanges.push(editor.tool));
    editor.startConnectorTool('curved');
    expect(editor.tool).toBe('connector');
    expect(editor.connectorToolType).toBe('curved');
    editor.stopTool();
    expect(toolChanges).toEqual(['connector', 'select']);

    const a = editor.createNode({ nodeType: 'sticky', x: 0, y: 0 })!;
    const b = editor.createNode({ nodeType: 'sticky', x: 400, y: 0 })!;
    const id = editor.engine.documentStore.createConnector({ from: { nodeId: a }, to: { nodeId: b } })!;
    expect(editor.getConnectorStyle(id)?.cornerRadius).toBe(8);
    expect(editor.getEntitiesBounds({ connectorIds: [id] })).toBeDefined();
    expect(editor.connectorAt({ x: 300, y: 100 })?.id).toBe(id);

    editor.updateConnectorStyle([id], { stroke: '$red', endArrow: 'triangle' });
    editor.setConnectorType([id], 'straight');
    expect(editor.getConnector(id)).toMatchObject({
      connectorType: 'straight',
      style: { stroke: '$red', endArrow: 'triangle' }
    });
    expect(editor.getConnectorStyle(id)?.cornerRadius).toBeUndefined();

    // 之后新画的连线沿用刚设置的线型与样式
    expect(editor.connectorToolType).toBe('straight');
    editor.startConnectorTool();
    const pointer = (point: { x: number; y: number }, phase: 'down' | 'move' | 'up') => {
      const event = new SyntheticPointerEvent({ point, target: editor.nodeAt(point) });
      if (phase === 'down') editor.engine.pointer.dispatchPointerDown(event);
      else if (phase === 'move') editor.engine.pointer.dispatchPointerMove(event);
      else editor.engine.pointer.dispatchPointerUp(event);
    };
    pointer({ x: 100, y: 500 }, 'down');
    pointer({ x: 300, y: 500 }, 'move');
    pointer({ x: 300, y: 500 }, 'up');
    const [drawn] = editor.selectedConnectorIds;
    expect(editor.getConnector(drawn)).toMatchObject({
      connectorType: 'straight',
      style: { stroke: '$red', endArrow: 'triangle' }
    });
    editor.deleteEntities({ connectorIds: [drawn] });

    const copies = editor.duplicateEntities({ connectorIds: [id] });
    expect([...editor.selectedConnectorIds]).toEqual(copies.connectorIds);
    editor.deleteEntities({ connectorIds: [id, ...copies.connectorIds] });
    expect(editor.getConnector(id)).toBeUndefined();
    editor.destroy();
  });

  it('导出、导入与恢复：导入经校验替换内容且可撤销，非法内容不改动；恢复不进撤销栈；提交按序通知补丁', () => {
    const editor = new SkyNoteEditor({ renderer: new FakeAdapter() });
    const committed: unknown[] = [];
    editor.onCommit((patches) => committed.push(patches));
    const id = editor.createNode({ nodeType: 'sticky', x: 0, y: 0 })!;
    expect(committed).toHaveLength(1);

    const exported = JSON.parse(JSON.stringify(editor.exportDocument()));
    editor.deleteEntities({ nodeIds: [id] });
    expect(editor.importDocument({ broken: true }).ok).toBe(false);
    expect(editor.nodeCount).toBe(0);

    expect(editor.importDocument(exported)).toEqual({ ok: true, value: undefined });
    expect(editor.getNode(id)).toBeDefined();
    editor.undo();
    expect(editor.getNode(id)).toBeUndefined();

    editor.restoreDocument(exported);
    expect(editor.getNode(id)).toBeDefined();
    expect(editor.canUndo).toBe(false);

    // 剪贴板插件已装配：选中节点即可复制
    editor.select([id]);
    expect(editor.engine.clipboard.copy()).not.toBeNull();
    editor.destroy();
  });
});
