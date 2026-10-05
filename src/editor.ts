/**
 * @file editor.ts
 * @description 开箱即用的编辑器：引擎与基础插件的标准装配，并向宿主提供高级门面 API (SkyNoteEditor)
 *
 * 设计考量 (Why):
 * 1. 一行接入：`new SkyNoteEditor({ renderer: adapter })` 后在容器就绪时 mount(container)，不必了解引擎与插件的装配细节；
 * 2. 门面收敛 (Facade)：将图元增删改查、几何变换、视口换算、主题解析与历史变更集中收敛在 Editor 门面上，
 *    避免上层 UI 穿透依赖内部 store 或手拼底层的 CanvasPatch；
 * 3. 与渲染引擎无关：适配器成对提供渲染器与字体测量器 (ADR-105)，本包不依赖任何渲染引擎；
 * 4. 与界面框架无关：不依赖 Vue / React；纯 TypeScript 实现，接口整洁。
 */

import {
  SkyNoteEngine,
  screenToWorld,
  worldToScreen,
  resolveThemeColor,
  type NodeEntity,
  type CanvasPatch,
  type CanvasRenderer,
  type CanvasTheme,
  type CreateNodeRequest,
  type HistoryChangeListener,
  type LayerMove,
  type NodeCreateOptionsMap,
  type NodeStyle,
  type Point,
  type RenderAdapter,
  type SkyNoteEngineOptions,
  type SkyNotePlugin,
  type ViewportState
} from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TextEditPlugin,
  TransformPlugin,
  ViewportNavigationPlugin
} from '@skynote/plugins-basic';

export interface SkyNoteEditorOptions<TContainer> extends Omit<SkyNoteEngineOptions, 'fonts'> {
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
  /** 画布内文字编辑：界面据此显示格式工具栏并设置选区样式 */
  readonly textEditor = new TextEditPlugin();
  private readonly adapter: RenderAdapter<TContainer>;
  private renderer: CanvasRenderer | null = null;

  constructor(options: SkyNoteEditorOptions<TContainer>) {
    const { renderer, plugins = [], ...engineOptions } = options;
    this.adapter = renderer;
    this.engine = new SkyNoteEngine({ ...engineOptions, fonts: renderer.fonts })
      .use(new BasicNodesPlugin())
      .use(new ViewportNavigationPlugin())
      .use(new SelectionPlugin())
      .use(new SelectionOutlinePlugin())
      .use(new EditingShortcutsPlugin())
      .use(new TransformPlugin())
      .use(this.textEditor);
    for (const plugin of plugins) this.engine.use(plugin);
  }

  /** 是否已挂载到容器 */
  get isMounted(): boolean {
    return this.renderer !== null;
  }

  /** 挂载到宿主容器 (容器需已有尺寸)；已挂载时先从原容器卸载 */
  mount(container: TContainer): void {
    this.unmount();
    this.renderer = this.adapter.mount(this.engine, container);
  }

  /** 从容器卸载渲染器；引擎与文档保留 */
  unmount(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }

  // ==================== 视口与坐标门面 ====================

  /** 获取当前视口参数 (平移与缩放) */
  get viewport(): Readonly<ViewportState> {
    return this.engine.session.viewport;
  }

  /** 视口中心对应的世界坐标 */
  get viewportCenter(): Point {
    return this.engine.session.viewportCenter;
  }

  /** 视口屏幕像素尺寸 */
  get viewportSize(): { width: number; height: number } {
    return this.engine.session.viewportSize;
  }

  /** 屏幕物理坐标转为世界逻辑坐标 */
  screenToWorld(point: Point): Point {
    return screenToWorld(point, this.engine.session.viewport);
  }

  /** 世界逻辑坐标转为屏幕物理坐标 */
  worldToScreen(point: Point): Point {
    return worldToScreen(point, this.engine.session.viewport);
  }

  /** 以指定点为中心按比例缩放 (缺省时以视口中心缩放) */
  zoomAt(factor: number, center?: Point): void {
    this.engine.session.zoomAt(factor, center);
  }

  /** 缩放并平移视口以容纳全部内容 (内容很少时不超过原始尺寸，空画布回到原点) */
  fitContent(): void {
    this.engine.session.fitBounds(this.engine.spatialIndex.getContentBounds());
  }

  // ==================== 历史与文档状态门面 ====================

  /** 当前是否可以撤销 */
  get canUndo(): boolean {
    return this.engine.documentStore.canUndo;
  }

  /** 当前是否可以重做 */
  get canRedo(): boolean {
    return this.engine.documentStore.canRedo;
  }

  /** 撤销上一步操作 */
  undo(): boolean {
    return this.engine.documentStore.undo();
  }

  /** 重做已撤销的操作 */
  redo(): boolean {
    return this.engine.documentStore.redo();
  }

  /** 监听撤销/重做历史状态变化 */
  onHistoryChange(listener: HistoryChangeListener): () => void {
    return this.engine.documentStore.onHistoryChange(listener);
  }

  /** 订阅文档数据变更通知 */
  subscribe(listener: () => void): () => void {
    return this.engine.documentStore.subscribe(listener);
  }

  // ==================== 图元查询门面 ====================

  /** 获取画布中的节点总数 */
  get nodeCount(): number {
    return this.engine.entityStore.nodeCount;
  }

  /** 读取指定 id 的节点，不存在时返回 undefined */
  getNode(id: string): Readonly<NodeEntity> | undefined {
    return this.engine.documentStore.getNode(id);
  }

  /** 批量读取指定 ids 的节点 */
  getNodes(ids: readonly string[]): readonly (Readonly<NodeEntity> | undefined)[] {
    return ids.map((id) => this.engine.documentStore.getNode(id));
  }

  // ==================== 图元操作与创建门面 ====================

  /**
   * 以节点中心对准视口中心新建节点，置于根层级最上方；一步撤销，并选中新节点
   * @returns 新节点 id；提交被拒绝时返回 null
   */
  insertNodeAtViewportCenter(request: ViewportInsertRequest): string | null {
    const { x, y } = this.engine.session.viewportCenter;
    return this.insertNodeAt(request, { x, y });
  }

  /**
   * 在指定世界坐标处以节点中心对齐新建节点，置于根层级最上方；一步撤销，并选中新节点
   * @returns 新节点 id；提交被拒绝时返回 null
   */
  insertNodeAt(request: ViewportInsertRequest, point: Point): string | null {
    const id = this.engine.documentStore.createNode({ ...request, x: point.x, y: point.y, origin: 'center' });
    if (id) this.engine.session.setSelection({ nodeIds: [id], connectorIds: [] });
    return id;
  }

  /** 更新单个节点的属性 (支持合并模式) */
  updateNode(
    id: string,
    patch: Partial<NodeEntity>,
    options?: { label?: string; merge?: boolean; groupId?: string }
  ): void {
    this.engine.documentStore.updateNode(id, patch, options);
  }

  /** 批量更新多个节点的属性 (多节点自动开启事务批处理) */
  updateNodes(
    nodeIds: readonly string[],
    patch: Partial<NodeEntity>,
    options?: { label?: string; merge?: boolean; groupId?: string }
  ): void {
    if (nodeIds.length === 0) return;
    if (nodeIds.length === 1) {
      this.engine.documentStore.updateNode(nodeIds[0]!, patch, options);
      return;
    }
    this.engine.documentStore.batch(() => {
      for (const id of nodeIds) {
        this.engine.documentStore.updateNode(id, patch, options);
      }
    }, options?.label);
  }

  /** 批量更新节点样式 (自动做深层安全合并) */
  updateNodeStyle(
    nodeIds: readonly string[],
    style: Partial<NodeStyle>,
    options?: { label?: string; groupId?: string }
  ): void {
    if (nodeIds.length === 0) return;
    this.updateNodes(nodeIds, { style } as Partial<NodeEntity>, {
      label: options?.label ?? '更新样式',
      groupId: options?.groupId,
      merge: true
    });
  }

  /** 批量设置节点锁定状态 */
  setNodesLocked(nodeIds: readonly string[], locked: boolean, label?: string): void {
    if (nodeIds.length === 0) return;
    this.updateNodes(nodeIds, { locked }, { label: label ?? (locked ? '锁定节点' : '解锁节点') });
  }

  /** 批量设置等比例缩放开关 */
  setAspectLocked(nodeIds: readonly string[], locked: boolean): void {
    this.engine.documentStore.setAspectLocked(nodeIds, locked);
  }

  /** 调整图元层级 (置顶/置底/上一层/下一层) */
  moveNodeLayers(nodeIds: readonly string[], move: LayerMove): void {
    this.engine.documentStore.moveLayers(nodeIds, move);
  }

  /** 节点适应内容尺寸 */
  fitNodesContent(nodeIds?: readonly string[]): void {
    if (!nodeIds || nodeIds.length === 0) return;
    this.engine.documentStore.fitContent(nodeIds);
  }

  /** 批量删除节点 */
  deleteNodes(nodeIds: readonly string[], label?: string): void {
    if (nodeIds.length === 0) return;
    const patches: CanvasPatch[] = nodeIds.map((id) => ({
      op: 'unset',
      path: ['content', 'nodes', id]
    }));
    this.engine.documentStore.commit({
      patches,
      label: label ?? '删除节点'
    });
  }

  // ==================== 几何变换高阶门面 (屏蔽 CanvasPatch) ====================

  /**
   * 设置图元尺寸并自动处理等比锁定联动
   */
  setNodeSize(
    nodeIds: readonly string[],
    target: { width?: number; height?: number },
    options?: { aspectLocked?: boolean; label?: string; groupId?: string }
  ): void {
    if (nodeIds.length === 0) return;
    const patches: CanvasPatch[] = [];
    const isLocked = options?.aspectLocked ?? false;

    for (const id of nodeIds) {
      const node = this.getNode(id);
      if (!node) continue;
      const oldW = node.width;
      const oldH = node.height;
      let newW = target.width ?? oldW;
      let newH = target.height ?? oldH;

      if (isLocked && oldW > 0 && oldH > 0) {
        const ratio = oldW / oldH;
        if (target.width !== undefined && target.height === undefined) {
          newH = Math.max(1, Math.round(target.width / ratio));
        } else if (target.height !== undefined && target.width === undefined) {
          newW = Math.max(1, Math.round(target.height * ratio));
        }
      }

      if (newW !== oldW) {
        patches.push({ op: 'set', path: ['content', 'nodes', id, 'width'], value: newW });
      }
      if (newH !== oldH) {
        patches.push({ op: 'set', path: ['content', 'nodes', id, 'height'], value: newH });
      }
    }

    if (patches.length > 0) {
      this.engine.documentStore.commit({
        label: options?.label ?? '调整尺寸',
        groupId: options?.groupId,
        patches
      });
    }
  }

  /** 设置图元圆角 */
  setNodeRadius(nodeIds: readonly string[], radius: number, options?: { label?: string; groupId?: string }): void {
    if (nodeIds.length === 0) return;
    const patches: CanvasPatch[] = [];
    for (const id of nodeIds) {
      const node = this.getNode(id);
      if (!node) continue;
      const curR = ((node.style as Record<string, unknown> | undefined)?.radius as number) ?? 0;
      if (curR !== radius) {
        patches.push({
          op: 'set',
          path: ['content', 'nodes', id, 'style'],
          value: { radius },
          merge: true
        });
      }
    }
    if (patches.length > 0) {
      this.engine.documentStore.commit({
        label: options?.label ?? '设置圆角',
        groupId: options?.groupId,
        patches
      });
    }
  }

  /** 设置图元绝对旋转角度 (0~360 度规整化) */
  setNodeRotation(nodeIds: readonly string[], rotation: number, options?: { label?: string; groupId?: string }): void {
    if (nodeIds.length === 0) return;
    const norm = ((Math.round(rotation) % 360) + 360) % 360;
    const patches: CanvasPatch[] = [];
    for (const id of nodeIds) {
      const node = this.getNode(id);
      if (!node) continue;
      const curRot = ((Math.round(node.rotation ?? 0) % 360) + 360) % 360;
      if (curRot !== norm) {
        patches.push({
          op: 'set',
          path: ['content', 'nodes', id, 'rotation'],
          value: norm
        });
      }
    }
    if (patches.length > 0) {
      this.engine.documentStore.commit({
        label: options?.label ?? '设置旋转角度',
        groupId: options?.groupId,
        patches
      });
    }
  }

  /** 增量旋转图元 (如顺时针旋转 90 度) */
  rotateNodesBy(nodeIds: readonly string[], deltaDegree: number, options?: { label?: string }): void {
    if (nodeIds.length === 0) return;
    const patches: CanvasPatch[] = [];
    for (const id of nodeIds) {
      const node = this.getNode(id);
      if (!node) continue;
      const nextRot = ((Math.round((node.rotation ?? 0) + deltaDegree) % 360) + 360) % 360;
      patches.push({
        op: 'set',
        path: ['content', 'nodes', id, 'rotation'],
        value: nextRot
      });
    }
    if (patches.length > 0) {
      this.engine.documentStore.commit({
        label: options?.label ?? `旋转${deltaDegree}度`,
        patches
      });
    }
  }

  // ==================== 主题与颜色门面 ====================

  /** 获取当前画布的主题配置 */
  get theme(): CanvasTheme {
    return this.engine.session.theme;
  }

  /** 将设计变量名或主题颜色解析为实际 HEX/RGB 颜色值 */
  resolveColor(colorOrToken: string): string {
    return resolveThemeColor(colorOrToken, this.engine.session.theme) ?? colorOrToken;
  }

  /** 卸载渲染器并销毁引擎 (含全部插件) */
  destroy(): void {
    this.unmount();
    this.engine.destroy();
  }
}
