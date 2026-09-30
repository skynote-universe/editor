/**
 * @file editor.ts
 * @description 开箱即用的编辑器：引擎与基础插件的标准装配，渲染引擎由宿主传入的适配器决定 (SkyNoteEditor)
 *
 * 设计考量 (Why):
 * 1. 一行接入：`new SkyNoteEditor({ renderer: adapter })` 后在容器就绪时 mount(container)，不必了解引擎与插件的装配细节；
 *    需要精细装配时仍可直接使用 core / plugins-basic 与各渲染包。
 * 2. 与渲染引擎无关：适配器成对提供渲染器与文本测量器 (ADR-105)，本包不依赖任何渲染引擎；
 *    容器类型随适配器推导 (Leafer 适配器为 HTMLElement)。
 * 3. 与界面框架无关：不依赖 Vue / React；界面需要的状态 (缩放比例、选区等) 直接订阅 engine.session。
 * 4. 生命周期分离：引擎随编辑器创建，可在挂载前载入文档与安装插件；渲染器只在 mount 与 unmount 之间存在，
 *    同一编辑器可以卸载后挂到另一个容器。
 */

import {
  SkyNoteEngine,
  type CanvasRenderer,
  type CreateNodeRequest,
  type NodeCreateOptionsMap,
  type RenderAdapter,
  type SkyNoteEngineOptions,
  type SkyNotePlugin
} from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TransformPlugin,
  ViewportNavigationPlugin
} from '@skynote/plugins-basic';

export interface SkyNoteEditorOptions<TContainer> extends Omit<SkyNoteEngineOptions, 'textMeasurer'> {
  /** 渲染适配器 (如 @skynote/renderer-leafer 的 LeaferAdapter) */
  renderer: RenderAdapter<TContainer>;
  /** 在基础插件之后额外安装的插件 (同 id 的插件会替换已安装者) */
  plugins?: readonly SkyNotePlugin[];
}

/** 在视口中心新建节点的请求：位置由视口决定；按已登记的节点类型逐一推导 options 的类型 */
export type ViewportInsertRequest = {
  [T in keyof NodeCreateOptionsMap]: Omit<CreateNodeRequest<T>, 'x' | 'y' | 'origin' | 'parentId'>;
}[keyof NodeCreateOptionsMap];

export class SkyNoteEditor<TContainer = unknown> {
  readonly engine: SkyNoteEngine;
  private readonly adapter: RenderAdapter<TContainer>;
  private renderer: CanvasRenderer | null = null;

  constructor(options: SkyNoteEditorOptions<TContainer>) {
    const { renderer, plugins = [], ...engineOptions } = options;
    this.adapter = renderer;
    this.engine = new SkyNoteEngine({ ...engineOptions, textMeasurer: renderer.textMeasurer })
      .use(new BasicNodesPlugin())
      .use(new ViewportNavigationPlugin())
      .use(new SelectionPlugin())
      .use(new SelectionOutlinePlugin())
      .use(new EditingShortcutsPlugin())
      .use(new TransformPlugin());
    for (const plugin of plugins) this.engine.use(plugin);
  }

  /** 是否已挂载到容器 */
  get isMounted(): boolean {
    return this.renderer !== null;
  }

  /**
   * 挂载到宿主容器 (容器需已有尺寸)；已挂载时先从原容器卸载
   * 渲染器上报视口尺寸后，视口居中、适配内容等命令才有意义
   */
  mount(container: TContainer): void {
    this.unmount();
    this.renderer = this.adapter.mount(this.engine, container);
  }

  /** 从容器卸载渲染器；引擎与文档保留 */
  unmount(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }

  /** 缩放并平移视口以容纳全部内容 (内容很少时不超过原始尺寸，空画布回到原点) */
  fitContent(): void {
    this.engine.session.fitBounds(this.engine.spatialIndex.getContentBounds());
  }

  /**
   * 以节点中心对准视口中心新建节点，置于根层级最上方；一步撤销，并选中新节点
   * @returns 新节点 id；提交被拒绝时返回 null
   */
  insertNodeAtViewportCenter(request: ViewportInsertRequest): string | null {
    const { x, y } = this.engine.session.viewportCenter;
    const id = this.engine.documentStore.createNode({ ...request, x, y, origin: 'center' });
    if (id) this.engine.session.setSelection({ nodeIds: [id], connectorIds: [] });
    return id;
  }

  /** 卸载渲染器并销毁引擎 (含全部插件) */
  destroy(): void {
    this.unmount();
    this.engine.destroy();
  }
}
