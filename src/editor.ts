/**
 * @file editor.ts
 * @description 开箱即用的编辑器：引擎与基础插件的标准装配，并作为界面访问画布的唯一门面 (SkyNoteEditor)
 *
 * 设计考量 (Why):
 * 1. 一行接入：`new SkyNoteEditor({ renderer: adapter })` 后在容器就绪时 mount(container)，不必了解引擎与插件的装配细节。
 * 2. 门面 (Facade)：界面只依赖本类的方法与事件，不直接调用引擎、文档或会话；内核结构调整时只改门面一处。
 *    门面方法一律转调内核语义命令 (删除级联、缩放走 applyResize 等规则由内核保证)，不自己拼补丁；
 *    其中很多方法只有一行转调，这是有意为之的稳定对外接口，而非多余包装。
 * 3. 与渲染引擎无关：适配器成对提供渲染器与字体测量器 (ADR-105)，本包不依赖任何渲染引擎。
 * 4. 与界面框架无关：不依赖 Vue / React，事件以回调订阅、返回注销函数。
 * 5. 生命周期分离：引擎随编辑器创建，可在挂载前载入文档；渲染器只在 mount 与 unmount 之间存在。
 */

import {
  SkyNoteEngine,
  compactCornerRadius,
  computeWorldFrame,
  expandCornerRadius,
  isAspectLocked,
  resolveNodeStyle,
  resolveThemeColor,
  screenToWorld,
  unionBounds,
  worldToScreen,
  type CanvasRenderer,
  type CanvasTheme,
  type CanvasThemeConfig,
  type CreateNodeRequest,
  type DocumentChangeSet,
  type HistoryChangeListener,
  type InputScope,
  type LayerMove,
  type NodeCreateOptionsMap,
  type NodeEntity,
  type NodeStyle,
  type NodeTransform,
  type Point,
  type RadiusCorner,
  type RectBounds,
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

/** 修改类方法的公共选项 */
export interface EditOptions {
  /** 撤销记录名称 */
  label?: string;
  /** 同组的连续修改 (如拖动滑块、取色) 合并为一步撤销 */
  groupId?: string;
}

export interface UpdateOptions extends EditOptions {
  /** style / data 是否按字段合并 (默认 true)；false 时整体替换 */
  merge?: boolean;
}

export class SkyNoteEditor<TContainer = unknown> {
  /** 底层引擎：供装配插件与高级扩展使用；界面应通过门面方法与事件访问，不直接使用 */
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

  // ==================== 挂载与生命周期 ====================

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

  /** 卸载渲染器并销毁引擎 (含全部插件) */
  destroy(): void {
    this.unmount();
    this.engine.destroy();
  }

  // ==================== 事件订阅 ====================

  /** 选中的节点或连线变化 */
  onSelectionChange(listener: () => void): () => void {
    return this.engine.session.subscribe((change) => {
      if (change.toggledNodeIds.size > 0 || change.toggledConnectorIds.size > 0) listener();
    });
  }

  /** 视口平移或缩放 */
  onViewportChange(listener: () => void): () => void {
    return this.engine.session.subscribe((change) => {
      if (change.viewportChanged) listener();
    });
  }

  /** 文档变更：变更集按实体归类 (几何、数据、删除等)，界面据此判断是否需要刷新 */
  onDocumentChange(listener: (changes: DocumentChangeSet) => void): () => void {
    return this.engine.documentStore.subscribe((_view, _record, changes) => listener(changes));
  }

  /**
   * 注册键盘作用域 (ADR-005 焦点栈)：界面需要的按键 (如 Esc 关闭面板) 也经焦点栈分发，
   * 优先级高于画布快捷键时先行消费；返回注销函数
   */
  registerInputScope(scope: InputScope): () => void {
    this.engine.inputScopes.pushScope(scope);
    return () => {
      this.engine.inputScopes.popScope(scope.id);
    };
  }

  /** 撤销 / 重做可用状态变化 */
  onHistoryChange(listener: HistoryChangeListener): () => void {
    return this.engine.documentStore.onHistoryChange(listener);
  }

  // ==================== 视口与坐标 ====================

  get viewport(): Readonly<ViewportState> {
    return this.engine.session.viewport;
  }

  /** 视口中心对应的世界坐标 */
  get viewportCenter(): Point {
    return this.engine.session.viewportCenter;
  }

  /** 视口像素尺寸 */
  get viewportSize(): { width: number; height: number } {
    return this.engine.session.viewportSize;
  }

  /** 画布容器内的屏幕坐标 → 世界坐标 */
  screenToWorld(point: Point): Point {
    return screenToWorld(point, this.engine.session.viewport);
  }

  /** 世界坐标 → 画布容器内的屏幕坐标 */
  worldToScreen(point: Point): Point {
    return worldToScreen(point, this.engine.session.viewport);
  }

  /** 以指定屏幕点为中心按倍数缩放 (缺省以视口中心) */
  zoomAt(factor: number, center?: Point): void {
    this.engine.session.zoomAt(factor, center);
  }

  /** 缩放并平移视口以容纳全部内容 (内容很少时不超过原始尺寸，空画布回到原点) */
  fitContent(): void {
    this.engine.session.fitBounds(this.engine.spatialIndex.getContentBounds());
  }

  // ==================== 主题 ====================

  get theme(): CanvasTheme {
    return this.engine.session.theme;
  }

  /** 切换画布主题 (由种子色派生全部画布配色) */
  setTheme(config: CanvasThemeConfig): void {
    this.engine.session.setTheme(config);
  }

  /** 调色板名称 ($red 等) 或主题色解析为实际色值；无法解析时原样返回 */
  resolveColor(colorOrToken: string): string {
    return resolveThemeColor(colorOrToken, this.engine.session.theme) ?? colorOrToken;
  }

  // ==================== 选区与查询 ====================

  get selectedNodeIds(): ReadonlySet<string> {
    return this.engine.session.selectedNodeIds;
  }

  /** 选中指定节点 (清空连线选区) */
  select(nodeIds: readonly string[]): void {
    this.engine.session.setSelection({ nodeIds, connectorIds: [] });
  }

  /** 选中根层级的全部节点 (后代随容器) */
  selectAll(): void {
    this.select(this.getChildIds());
  }

  get nodeCount(): number {
    return this.engine.entityStore.nodeCount;
  }

  getNode(id: string): Readonly<NodeEntity> | undefined {
    return this.engine.documentStore.getNode(id);
  }

  /** 容器的直接子节点；parentId 缺省为根层级 */
  getChildIds(parentId?: string): string[] {
    return [...this.engine.entityStore.getChildIds(parentId)];
  }

  /** 世界坐标处最上层的节点 (按实际轮廓与框外装饰判定) */
  nodeAt(point: Point): Readonly<NodeEntity> | undefined {
    return this.engine.hitTestNode(point);
  }

  /** 节点在世界坐标中占据的整体外接框 (含框外标题等装饰与旋转)，用于工具栏定位；节点都不存在时为 undefined */
  getNodesBounds(nodeIds: Iterable<string>): RectBounds | undefined {
    let bounds: RectBounds | undefined;
    for (const id of nodeIds) {
      const nodeBounds = this.engine.getNodeOccupiedBounds(id);
      if (nodeBounds) bounds = bounds ? unionBounds(bounds, nodeBounds) : nodeBounds;
    }
    return bounds;
  }

  /** 节点的生效样式 (节点类型默认样式 < 节点自身样式)，面板显示的值即画出的值 */
  getNodeStyle(id: string): NodeStyle | undefined {
    const node = this.engine.documentStore.getNode(id);
    return node && resolveNodeStyle(node, this.engine.nodeTypes.get(node.nodeType));
  }

  /** 节点当前是否锁定比例 (节点显式值优先，否则取节点类型默认值) */
  isAspectLocked(id: string): boolean {
    const node = this.engine.documentStore.getNode(id);
    return node !== undefined && isAspectLocked(node, this.engine.nodeTypes.get(node.nodeType));
  }

  /** 节点能否适应内容 (界面据此决定是否显示入口) */
  canFitContent(id: string): boolean {
    return this.engine.documentStore.canFitContent(id);
  }

  // ==================== 新建、副本与删除 ====================

  /**
   * 新建节点 (不改变选区)；x / y 为节点左上角在父容器中的坐标
   * @returns 新节点 id；提交被拒绝时返回 null
   */
  createNode<T extends string>(request: CreateNodeRequest<T>): string | null {
    return this.engine.documentStore.createNode(request);
  }

  /**
   * 以节点中心对准视口中心新建节点，置于根层级最上方；一步撤销，并选中新节点
   * @returns 新节点 id；提交被拒绝时返回 null
   */
  insertNodeAtViewportCenter(request: ViewportInsertRequest): string | null {
    return this.insertNodeAt(request, this.engine.session.viewportCenter);
  }

  /**
   * 以节点中心对准指定世界坐标新建节点，置于根层级最上方；一步撤销，并选中新节点
   * @returns 新节点 id；提交被拒绝时返回 null
   */
  insertNodeAt(request: ViewportInsertRequest, point: Point): string | null {
    const id = this.engine.documentStore.createNode({ ...request, x: point.x, y: point.y, origin: 'center' });
    if (id) this.select([id]);
    return id;
  }

  /**
   * 创建副本 (含后代与内部连线)，偏移后选中副本；一步撤销
   * @returns 副本中最顶层节点的 id
   */
  duplicateNodes(nodeIds: readonly string[], offset: Point = { x: 20, y: 20 }): string[] {
    const ids = this.engine.documentStore.duplicateNodes(nodeIds, offset);
    if (ids.length > 0) this.select(ids);
    return ids;
  }

  /** 删除节点：级联删除后代与依附连线，一步撤销 */
  deleteNodes(nodeIds: readonly string[], label?: string): void {
    this.engine.documentStore.removeNodes(nodeIds, { label });
  }

  // ==================== 属性与样式 ====================

  /** 写入节点字段，一次提交；style / data 默认按字段合并 */
  updateNodes(nodeIds: readonly string[], fields: Partial<NodeEntity>, options?: UpdateOptions): void {
    this.engine.documentStore.updateNodes(nodeIds, fields, options);
  }

  /** 合并写入样式 (只改给出的样式项)；连续调整 (如拖动取色) 传同一 groupId 合并为一步撤销 */
  updateNodeStyle(nodeIds: readonly string[], style: Partial<NodeStyle>, options?: EditOptions): void {
    this.engine.documentStore.updateNodes(nodeIds, { style }, { label: '更新样式', ...options, merge: true });
  }

  /**
   * 设置圆角：不指定 corner 时四角统一；指定时只改该角、保留各节点其余三角 (四角相同时存回单值)
   */
  setNodeRadius(nodeIds: readonly string[], radius: number, options?: EditOptions & { corner?: RadiusCorner }): void {
    const { corner, ...edit } = options ?? {};
    const { documentStore, nodeTypes } = this.engine;
    documentStore.updateNodes(
      nodeIds,
      (node) => {
        if (corner === undefined) return { style: { radius } };
        const corners = expandCornerRadius(resolveNodeStyle(node, nodeTypes.get(node.nodeType)).radius);
        corners[corner] = radius;
        return { style: { radius: compactCornerRadius(corners) } };
      },
      { label: '设置圆角', ...edit, merge: true }
    );
  }

  setNodesLocked(nodeIds: readonly string[], locked: boolean): void {
    this.updateNodes(nodeIds, { locked }, { label: locked ? '锁定节点' : '解锁节点' });
  }

  setAspectLocked(nodeIds: readonly string[], locked: boolean): void {
    this.engine.documentStore.setAspectLocked(nodeIds, locked);
  }

  /** 调整层级 (上移一层 / 下移一层 / 置顶 / 置底) */
  moveNodeLayers(nodeIds: readonly string[], move: LayerMove): void {
    this.engine.documentStore.moveLayers(nodeIds, move);
  }

  /** 节点外框适应内容，已适应或不支持的节点跳过 */
  fitNodesContent(nodeIds: readonly string[]): void {
    this.engine.documentStore.fitContent(nodeIds);
  }

  // ==================== 几何变换 ====================

  /** 设置节点宽高：左上角不动，比例锁定按节点自身状态联动，与拖控制柄同一缩放语义 */
  setNodeSize(nodeIds: readonly string[], size: { width?: number; height?: number }, options?: EditOptions): void {
    this.engine.documentStore.resizeNodes(nodeIds, size, options);
  }

  /** 设置节点旋转角度 (各自绕自身中心，规整到 0~360) */
  setNodeRotation(nodeIds: readonly string[], rotation: number, options?: EditOptions): void {
    const target = ((rotation % 360) + 360) % 360;
    const { documentStore, entityStore } = this.engine;
    const transforms: NodeTransform[] = [];
    for (const id of nodeIds) {
      const node = documentStore.getNode(id);
      if (!node || node.rotation === target) continue;
      const frame = computeWorldFrame(node, entityStore.getWorldTransform(id)!);
      transforms.push({ id, frame: { ...frame, rotation: frame.rotation + target - node.rotation } });
    }
    documentStore.transformNodes(transforms, { label: '设置旋转角度', ...options });
  }

  /** 绕选中节点整体中心增量旋转 (如顺时针 90°)，与拖动旋转控制柄结果一致 */
  rotateNodesBy(nodeIds: readonly string[], degrees: number, options?: EditOptions): void {
    this.engine.documentStore.rotateNodes(nodeIds, degrees, options);
  }

  // ==================== 撤销与重做 ====================

  get canUndo(): boolean {
    return this.engine.documentStore.canUndo;
  }

  get canRedo(): boolean {
    return this.engine.documentStore.canRedo;
  }

  undo(): boolean {
    return this.engine.documentStore.undo();
  }

  redo(): boolean {
    return this.engine.documentStore.redo();
  }

  /** 清空撤销历史 (如载入文档或示例数据之后) */
  clearHistory(): void {
    this.engine.documentStore.clearHistory();
  }
}
