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
  clonePlainData,
  inspectDocumentAssets,
  type DocumentAssetInspection,
  computeWorldFrame,
  expandCornerRadius,
  isAspectLocked,
  parseCanvasDocument,
  resolveConnectorStyle,
  resolveNodeStyle,
  resolveThemeColor,
  screenToWorld,
  splitStyleAlpha,
  unionBounds,
  worldToScreen,
  type CanvasDocument,
  type AssetTaskEvent,
  type AssetTaskResult,
  type CanvasPatch,
  type CanvasRenderer,
  type ImageLoadState,
  type CanvasTheme,
  type CanvasThemeConfig,
  type ConnectorEntity,
  type ConnectorStyle,
  type CreateNodeRequest,
  type DocumentChangeSet,
  type EntityIds,
  type EntityRefs,
  type HistoryChangeListener,
  type InputScope,
  type CursorDefinition,
  type CursorStyle,
  type LayerMove,
  type NodeCreateOptionsMap,
  type NodeEntity,
  type NodeStyle,
  type NodeTransform,
  type ParseResult,
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
  BranchConnectorsPlugin,
  ClipboardPlugin,
  CONNECTOR_TOOL,
  ConnectorEditPlugin,
  ConnectorToolPlugin,
  EditingShortcutsPlugin,
  type ConnectNodeRequest,
  type ConnectorDropEvent,
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

/** 画布工具：选择 (默认) 或连线 */
export type CanvasTool = 'select' | typeof CONNECTOR_TOOL;

/** 内置线型 (路由器 id) */
export type ConnectorLineType = 'straight' | 'orthogonal' | 'curved';

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
  private readonly connectorTool = new ConnectorToolPlugin();
  private readonly adapter: RenderAdapter<TContainer>;
  private renderer: CanvasRenderer | null = null;
  private imageSubscription?: () => void;
  private readonly imageListeners = new Set<() => void>();
  private readonly assetDisposers: (() => void)[] = [];

  constructor(options: SkyNoteEditorOptions<TContainer>) {
    const { renderer, plugins = [], ...engineOptions } = options;
    this.adapter = renderer;
    this.engine = new SkyNoteEngine({ ...engineOptions, fonts: renderer.fonts })
      .use(new BasicNodesPlugin())
      // 布局树的分支线 (ADR-130)：未安装对应布局插件时也能按通用默认值绘制
      .use(new BranchConnectorsPlugin())
      .use(new ViewportNavigationPlugin())
      .use(new SelectionPlugin())
      .use(new SelectionOutlinePlugin())
      .use(new EditingShortcutsPlugin())
      .use(new TransformPlugin())
      .use(new ClipboardPlugin())
      .use(this.connectorTool)
      .use(new ConnectorEditPlugin())
      .use(this.textEditor);
    for (const plugin of plugins) this.engine.use(plugin);
    let selectionVersion = 0;
    let latestInsertion = '';
    const intents = new Map<string, number>();
    this.assetDisposers.push(this.onSelectionChange(() => selectionVersion++));
    this.assetDisposers.push(
      this.engine.onAssetTaskEvent((event) => {
        if (event.phase === 'rejected' || event.task.operation === 'replace-image') return;
        if (event.phase === 'started') {
          latestInsertion = event.task.requestId;
          intents.set(event.task.requestId, selectionVersion);
          return;
        }
        const version = intents.get(event.task.requestId);
        intents.delete(event.task.requestId);
        if (
          event.result.status !== 'succeeded' ||
          version !== selectionVersion ||
          latestInsertion !== event.task.requestId ||
          event.task.documentEpoch !== this.engine.documentEpoch
        )
          return;
        const value = event.result.value;
        if (typeof value === 'string') this.select([value]);
        else if ('nodeIds' in value) this.select(value.nodeIds, value.connectorIds);
      })
    );
  }

  // ==================== 挂载与生命周期 ====================

  get isMounted(): boolean {
    return this.renderer !== null;
  }

  /** 挂载到宿主容器 (容器需已有尺寸)；已挂载时先从原容器卸载 */
  mount(container: TContainer): void {
    this.unmount();
    this.renderer = this.adapter.mount(this.engine, container);
    this.imageSubscription = this.renderer.images?.subscribe(() => this.notifyImageLoadChange());
    this.notifyImageLoadChange();
  }

  /** 从容器卸载渲染器；引擎与文档保留 */
  unmount(): void {
    this.imageSubscription?.();
    this.imageSubscription = undefined;
    this.renderer?.destroy();
    this.renderer = null;
    this.notifyImageLoadChange();
  }

  /** 卸载渲染器并销毁引擎 (含全部插件) */
  destroy(): void {
    for (const dispose of this.assetDisposers.splice(0)) dispose();
    this.unmount();
    this.imageListeners.clear();
    this.engine.destroy();
  }

  // ==================== 事件订阅 ====================

  getImageLoadState(nodeId: string): ImageLoadState | undefined {
    return this.renderer?.images?.getState(nodeId);
  }

  retryImages(nodeIds: readonly string[]): readonly string[] {
    return this.renderer?.images?.retry(nodeIds) ?? [];
  }

  onImageLoadChange(listener: () => void): () => void {
    this.imageListeners.add(listener);
    return () => this.imageListeners.delete(listener);
  }

  private notifyImageLoadChange(): void {
    for (const listener of this.imageListeners) listener();
  }

  get documentEpoch(): number {
    return this.engine.documentEpoch;
  }
  onAssetTaskEvent(listener: (event: AssetTaskEvent) => void): () => void {
    return this.engine.onAssetTaskEvent(listener);
  }

  /** 选中的节点或连线变化 */
  onSelectionChange(listener: () => void): () => void {
    return this.engine.session.subscribe((change) => {
      if (change.toggledNodeIds.size > 0 || change.toggledConnectorIds.size > 0) listener();
    });
  }

  /** 当前工具切换 (进入连线工具、画完一条后回到选择等) */
  onToolChange(listener: () => void): () => void {
    return this.engine.session.subscribe((change) => {
      if (change.toolChanged) listener();
    });
  }

  /** 连线松手在空白处 (留下自由端)：界面可在该处弹出图形选择，选择后调用 connectNewNode */
  onConnectorDropOnBlank(listener: (e: ConnectorDropEvent) => void): () => void {
    return this.connectorTool.onDropOnBlank(listener);
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
   * 注册或覆盖画布光标 (与内置 id 相同即覆盖，如 'default'、'resize')，方便统一风格；返回恢复函数
   */
  registerCursor(definition: CursorDefinition): () => void {
    return this.engine.cursors.register(definition);
  }

  /** 统一设置整套光标 (含插件注册的) 的配色 */
  setCursorStyle(style: Partial<CursorStyle>): void {
    this.engine.cursors.setStyle(style);
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

  /**
   * 每次提交 (含撤销、重做、导入) 的正向补丁，按提交顺序通知；本地持久化据此追加写入日志，
   * 从快照按序重放即得到当前文档
   */
  onCommit(listener: (patches: readonly CanvasPatch[]) => void): () => void {
    return this.engine.documentStore.subscribe((_view, record) => listener(record.patches));
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

  // ==================== 工具 ====================

  get tool(): CanvasTool {
    return this.engine.session.tool as CanvasTool;
  }

  /** 连线工具画出的线型 */
  get connectorToolType(): ConnectorLineType {
    return this.connectorTool.connectorType as ConnectorLineType;
  }

  /** 进入连线工具：之后在画布上拖动画出一条该线型的连线，画完回到选择工具 */
  startConnectorTool(connectorType: ConnectorLineType = this.connectorToolType): void {
    this.connectorTool.connectorType = connectorType;
    this.engine.session.setTool(CONNECTOR_TOOL);
  }

  /** 回到选择工具 (取消正在画的连线) */
  stopTool(): void {
    this.engine.session.setTool('select');
  }

  // ==================== 选区与查询 ====================

  get selectedNodeIds(): ReadonlySet<string> {
    return this.engine.session.selectedNodeIds;
  }

  get selectedConnectorIds(): ReadonlySet<string> {
    return this.engine.session.selectedConnectorIds;
  }

  /** 选中指定节点与连线 (替换原选区) */
  select(nodeIds: readonly string[], connectorIds: readonly string[] = []): void {
    this.engine.session.setSelection({ nodeIds, connectorIds });
  }

  /** 选中根层级的全部节点 (后代随容器) 与全部连线 */
  selectAll(): void {
    this.select(
      this.getChildIds(),
      this.engine.entityStore.getAllConnectors().map((runtime) => runtime.entity.id)
    );
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

  /** 世界坐标处的连线 (距离按屏幕像素容差判定) */
  connectorAt(point: Point): Readonly<ConnectorEntity> | undefined {
    return this.engine.hitTestConnector(point);
  }

  getConnector(id: string): Readonly<ConnectorEntity> | undefined {
    return this.engine.documentStore.getConnector(id);
  }

  /** 连线的生效样式 (线型默认样式 < 连线自身样式)，面板显示的值即画出的值 */
  getConnectorStyle(id: string): ConnectorStyle | undefined {
    const connector = this.engine.documentStore.getConnector(id);
    return connector && resolveConnectorStyle(connector, this.engine.routers);
  }

  /**
   * 节点与连线在世界坐标中的整体外接框 (节点含框外标题等装饰与旋转，连线取真实路由)，用于工具栏定位；
   * 都不存在时为 undefined
   */
  getEntitiesBounds(refs: EntityRefs): RectBounds | undefined {
    let bounds: RectBounds | undefined;
    const add = (b: RectBounds | undefined) => {
      if (b) bounds = bounds ? unionBounds(bounds, b) : b;
    };
    for (const id of refs.nodeIds ?? []) add(this.engine.getNodeOccupiedBounds(id));
    for (const id of refs.connectorIds ?? []) add(this.engine.getConnectorRoute(id)?.bounds);
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

  /** 节点绘制时是否采用圆角 (界面据此决定是否提供圆角设置) */
  supportsCornerRadius(id: string): boolean {
    const node = this.engine.documentStore.getNode(id);
    return !!node && !!this.engine.nodeTypes.get(node.nodeType)?.supportsCornerRadius?.(node);
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

  /** 上传并在指定世界坐标插入图片；未配置资产适配器时返回 null */
  insertImage(file: unknown, point: Point): Promise<AssetTaskResult<string>> {
    return this.engine.insertImage(file, point);
  }

  /** 替换选中图片的资产引用；保留节点尺寸、位置、样式与显示方式 */
  replaceImage(nodeIds: readonly string[], file: unknown): Promise<AssetTaskResult<readonly string[]>> {
    return this.engine.replaceImage(nodeIds, file);
  }

  /**
   * 创建副本 (节点含后代与内部连线；单独选中的连线一并复制)，偏移后选中副本；一步撤销
   * @returns 副本中最顶层节点与连线的 id
   */
  duplicateEntities(refs: EntityRefs, offset: Point = { x: 20, y: 20 }): EntityIds {
    const ids = this.engine.documentStore.duplicateEntities(refs, offset);
    if (ids.nodeIds.length + ids.connectorIds.length > 0) this.select(ids.nodeIds, ids.connectorIds);
    return ids;
  }

  /** 删除节点与连线：节点级联删除后代与依附连线，一步撤销 */
  deleteEntities(refs: EntityRefs, label?: string): void {
    this.engine.documentStore.removeEntities(refs, { label });
  }

  // ==================== 属性与样式 ====================

  /** 写入节点字段，一次提交；style / data 默认按字段合并 */
  updateNodes(
    nodeIds: readonly string[],
    fields: Partial<NodeEntity> | ((node: Readonly<NodeEntity>) => Partial<NodeEntity>),
    options?: UpdateOptions
  ): void {
    this.engine.documentStore.updateNodes(nodeIds, fields, options);
  }

  /**
   * 合并写入样式 (只改给出的样式项)；连续调整 (如拖动取色) 传同一 groupId 合并为一步撤销
   * 带透明度的填充色、描边色与导入时一样拆成不透明色值与单独的透明度
   */
  updateNodeStyle(nodeIds: readonly string[], style: Partial<NodeStyle>, options?: EditOptions): void {
    this.engine.documentStore.updateNodes(
      nodeIds,
      { style: splitStyleAlpha(style) },
      { label: '更新样式', ...options, merge: true }
    );
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

  /** 锁定或解锁节点与连线，一步撤销 */
  setLocked(refs: EntityRefs, locked: boolean): void {
    const { documentStore } = this.engine;
    documentStore.batch(
      () => {
        documentStore.updateNodes(refs.nodeIds ?? [], { locked });
        documentStore.updateConnectors(refs.connectorIds ?? [], { locked });
      },
      locked ? '锁定' : '解锁'
    );
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

  /** 将图片节点恢复为资产记录中的固有尺寸；缺少尺寸元数据时跳过 */
  restoreImageSize(nodeIds: readonly string[]): void {
    const assets = this.engine.documentStore.getView().assets ?? {};
    this.engine.documentStore.updateNodes(
      nodeIds,
      (node) => {
        const asset = node.image ? assets[node.image.assetId] : undefined;
        return asset?.width && asset.height ? { width: asset.width, height: asset.height } : {};
      },
      { label: '恢复图片原始尺寸' }
    );
  }

  /** 保留图片节点当前宽度，并按资产固有比例恢复高度 */
  restoreImageRatio(nodeIds: readonly string[]): void {
    const assets = this.engine.documentStore.getView().assets ?? {};
    this.engine.documentStore.updateNodes(
      nodeIds,
      (node) => {
        const asset = node.image ? assets[node.image.assetId] : undefined;
        if (!asset?.width || !asset.height) return {};
        return { height: Math.max(1, Math.round((node.width * asset.height) / asset.width)) };
      },
      { label: '恢复图片比例' }
    );
  }

  // ==================== 连线 ====================

  /**
   * 合并写入连线样式 (颜色、粗细、虚线、箭头、圆角)；连续调整传同一 groupId 合并为一步撤销
   * 之后新画的连线沿用这次设置的样式 (与 FigJam 一致：用户改过的样式通常就是想要的默认样式)
   */
  updateConnectorStyle(connectorIds: readonly string[], style: Partial<ConnectorStyle>, options?: EditOptions): void {
    this.engine.documentStore.updateConnectors(
      connectorIds,
      { style },
      { label: '更新连线样式', ...options, merge: true }
    );
    this.connectorTool.style = { ...this.connectorTool.style, ...style };
  }

  /** 切换线型 (直线 / 折线 / 曲线)：手动拐点的含义随线型不同，一并清除；之后新画的连线沿用该线型 */
  setConnectorType(connectorIds: readonly string[], connectorType: ConnectorLineType): void {
    this.engine.documentStore.updateConnectors(
      connectorIds,
      { connectorType, controlPoints: undefined },
      { label: '切换线型' }
    );
    this.connectorTool.connectorType = connectorType;
  }

  /**
   * 在连线的自由端新建节点并连上 (节点朝向另一端的边落在自由端)，一步撤销，并选中新节点
   * @returns 新节点 id；连线没有自由端时返回 null
   */
  connectNewNode(connectorId: string, request: ConnectNodeRequest): string | null {
    return this.connectorTool.connectNewNode(connectorId, request);
  }

  /** 清除手动拐点，恢复自动路由 */
  resetConnectorRoute(connectorIds: readonly string[]): void {
    this.engine.documentStore.updateConnectors(connectorIds, { controlPoints: undefined }, { label: '恢复自动路由' });
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

  // ==================== 文档导出、导入与恢复 ====================

  /** 当前文档的完整副本 (可直接 JSON 序列化) */
  exportDocument(): CanvasDocument {
    return clonePlainData(this.engine.documentStore.getView()) as CanvasDocument;
  }

  /**
   * 导入外部文档 (文件)：经白名单校验后替换当前内容，撤销一步即回到原内容
   * @returns 校验失败时给出出错位置，当前内容不变
   */
  prepareDocumentImport(value: unknown): ParseResult<DocumentAssetInspection> {
    const parsed = parseCanvasDocument(value);
    if (!parsed.ok) return parsed;
    try {
      return { ok: true, value: inspectDocumentAssets(parsed.value, this.engine.nodeTypes) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '文档资产引用无效' };
    }
  }

  /** 宿主确认后可接受媒体问题；结构解析与事务守卫始终执行。 */
  importDocument(value: unknown, options?: { allowAssetIssues?: boolean }): ParseResult<void> {
    const prepared = this.prepareDocumentImport(value);
    if (!prepared.ok) return prepared;
    if (prepared.value.issues.length && !options?.allowAssetIssues)
      return { ok: false, error: prepared.value.issues[0].detail };
    const doc = prepared.value.document;
    const record = this.engine.documentStore.replaceContent(doc.content, { label: '导入文档' }, doc.assets ?? {});
    if (!record) return { ok: false, error: '文档结构或事务校验失败，未导入' };
    return { ok: true, value: undefined };
  }

  /** 从本地存储恢复文档 (须先经 parseCanvasDocument 校验)：不进撤销栈，并清空撤销历史 */
  restoreDocument(doc: CanvasDocument): void {
    this.engine.documentStore.replaceContent(doc.content, { undoable: false }, doc.assets ?? {});
    this.engine.documentStore.clearHistory();
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
