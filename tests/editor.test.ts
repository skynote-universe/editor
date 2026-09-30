/**
 * @file editor.test.ts
 * @description 编辑器标准装配：基础插件、渲染适配器生命周期与视口命令
 *
 * 用替身适配器测试：编辑器不依赖任何渲染引擎，只经 RenderAdapter 协议挂载与卸载。
 */

import { describe, it, expect } from 'vitest';
import {
  DETACHED_CANVAS_HOST,
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
    editor.destroy();
  });
});
