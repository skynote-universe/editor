/** 数值面板的一次连续编辑：只保留当前会话，所有写入仍经 Core 语义命令。 */
import {
  clonePlainData,
  computeWorldFrame,
  generateId,
  GROUP_NODE_TYPE,
  isDerivedConnectorId,
  type SkyNoteEngine,
  type CommandOptions,
  type DocumentChangeSet,
  type CanvasOperationRecord,
  type NodeEntity,
  type WorldFrame,
  type NodeScaleSnapshot,
  type NodeConnectorTransformSnapshot,
  type ConnectorEntity,
  type LayoutDefinition,
  type NodeTransform
} from '@skynote/core';

type Size = { width?: number; height?: number };
type Mode = 'width' | 'height' | 'size' | 'rotation';
interface Session {
  requestedGroup: string;
  groupId: string;
  mode: Mode;
  ids: readonly string[];
  members: Set<string>;
  ancestors: Set<string>;
  types: Set<string>;
  layouts: Map<string, LayoutDefinition | undefined>;
  frames: Map<string, WorldFrame>;
  rotations: Map<string, number>;
  sizes: Map<string, NodeScaleSnapshot>;
  connectors: Map<string, NodeConnectorTransformSnapshot>;
  connectorIds: Set<string>;
}

export class GeometryEditSession {
  private active?: Session;
  private endedGroup?: string;
  private applying = false;
  private readonly disposers: (() => void)[];

  constructor(private readonly engine: SkyNoteEngine) {
    this.disposers = [
      engine.documentStore.subscribe((_view, record, changes) => this.onChange(changes, record)),
      engine.session.subscribe((change) => {
        if (
          change.readOnlyChanged ||
          change.textEditingChanged ||
          change.toggledNodeIds.size ||
          change.toggledConnectorIds.size
        )
          this.end();
      }),
      engine.nodeTypes.onChange((type) => {
        if (this.active?.types.has(type)) this.end();
      }),
      engine.layouts.onChange(() => {
        if (this.active && [...this.active.layouts].some(([id, value]) => engine.layouts.get(id) !== value)) this.end();
      })
    ];
  }

  end(groupId?: string): void {
    if (!this.active || (groupId !== undefined && this.active.requestedGroup !== groupId)) return;
    this.endedGroup = this.active.requestedGroup;
    this.active = undefined;
  }

  dispose(): void {
    this.end();
    for (const dispose of this.disposers) dispose();
  }

  resize(ids: readonly string[], size: Size, options?: CommandOptions): void {
    const mode = size.height === undefined ? 'width' : size.width === undefined ? 'height' : 'size';
    const session = this.get(ids, mode, options?.groupId);
    this.applying = true;
    try {
      this.engine.documentStore.resizeNodes(
        ids,
        size,
        session ? { ...options, groupId: session.groupId } : options,
        session?.sizes
      );
    } finally {
      this.applying = false;
    }
  }

  rotate(ids: readonly string[], rotation: number, options?: CommandOptions): void {
    const target = ((Math.round(rotation) % 360) + 360) % 360;
    const session = this.get(ids, 'rotation', options?.groupId);
    const { documentStore, entityStore } = this.engine;
    const selected = new Set(ids);
    const worldDeltas = new Map<string, number>();
    // 面板设置的是局部角度；世界目标还需叠加同批选中祖先的变化，共享父链只求解一次。
    for (const id of selected) {
      if (selected.size === 1) break;
      const path: { id: string; rotation: number }[] = [];
      let current: string | undefined = id;
      while (current !== undefined && !worldDeltas.has(current)) {
        const node = documentStore.getNode(current);
        if (!node) break;
        path.push(node);
        current = node.parentId;
      }
      let delta = current === undefined ? 0 : (worldDeltas.get(current) ?? 0);
      for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i];
        if (selected.has(node.id)) delta += target - (session?.rotations.get(node.id) ?? node.rotation);
        worldDeltas.set(node.id, delta);
      }
    }
    const transforms: NodeTransform[] = [];
    for (const id of selected) {
      const node = documentStore.getNode(id);
      if (!node) continue;
      const frame = session?.frames.get(id) ?? computeWorldFrame(node, entityStore.getWorldTransform(id)!);
      transforms.push({
        id,
        frame: {
          ...frame,
          rotation: frame.rotation + (worldDeltas.get(id) ?? target - (session?.rotations.get(id) ?? node.rotation))
        },
        connectorSnapshot: session?.connectors.get(id)
      });
    }
    this.applying = true;
    try {
      documentStore.transformNodes(transforms, { ...options, groupId: session?.groupId ?? options?.groupId });
    } finally {
      this.applying = false;
    }
  }

  private get(nodeIds: readonly string[], mode: Mode, groupId?: string): Session | undefined {
    if (!groupId || this.engine.session.isReadOnly) {
      this.end();
      return undefined;
    }
    const ids = [...new Set(nodeIds)].filter((id) => this.engine.documentStore.getNode(id));
    if (ids.length === 0) {
      this.end();
      return undefined;
    }
    const current = this.active;
    if (
      current?.requestedGroup === groupId &&
      current.mode === mode &&
      ids.length === current.ids.length &&
      ids.every((id, i) => id === current.ids[i])
    )
      return current;
    this.end();
    const session: Session = {
      requestedGroup: groupId,
      groupId: this.endedGroup === groupId ? generateId('geometry-edit') : groupId,
      mode,
      ids,
      members: new Set(ids),
      ancestors: new Set(),
      types: new Set(),
      layouts: new Map(),
      frames: new Map(),
      rotations: new Map(),
      sizes: new Map(),
      connectors: new Map(),
      connectorIds: new Set()
    };
    const { documentStore, entityStore } = this.engine;
    const sources = new Map<string, { node: NodeEntity; frame: WorldFrame }>();
    const selected = new Set(ids);
    for (const id of ids) {
      const node = documentStore.getNode(id)!;
      const frame = computeWorldFrame(node, entityStore.getWorldTransform(id)!);
      session.frames.set(id, frame);
      session.rotations.set(id, node.rotation);
      if (mode === 'rotation') {
        const snapshot = documentStore.captureConnectorTransformSnapshot([id], frame, selected);
        session.connectors.set(id, snapshot);
        for (const member of snapshot.nodeIds) session.members.add(member);
        for (const connector of snapshot.controlPoints.keys()) session.connectorIds.add(connector);
      } else if (node.nodeType === GROUP_NODE_TYPE) {
        for (const member of entityStore.collectDescendantIds(id)) session.members.add(member);
      }
      let parentId = node.parentId;
      while (parentId !== undefined && !session.ancestors.has(parentId)) {
        session.ancestors.add(parentId);
        parentId = documentStore.getNode(parentId)?.parentId;
      }
    }
    for (const id of session.members) {
      const node = documentStore.getNode(id)!;
      if (mode !== 'rotation')
        sources.set(id, {
          node: clonePlainData(node) as NodeEntity,
          frame: session.frames.get(id) ?? computeWorldFrame(node, entityStore.getWorldTransform(id)!)
        });
    }
    if (mode !== 'rotation') {
      const connectors = new Map<string, ConnectorEntity>();
      for (const id of session.members)
        for (const connectorId of entityStore.getConnectorIdsOfNode(id)) {
          if (isDerivedConnectorId(connectorId) || connectors.has(connectorId)) continue;
          const connector = documentStore.getConnector(connectorId);
          if (!connector || !session.members.has(connector.from.nodeId!) || !session.members.has(connector.to.nodeId!))
            continue;
          connectors.set(connectorId, clonePlainData(connector) as ConnectorEntity);
          session.connectorIds.add(connectorId);
        }
      const snapshot = { nodes: sources, connectors };
      for (const id of ids) session.sizes.set(id, snapshot);
    }
    for (const id of [...session.members, ...session.ancestors]) {
      const node = documentStore.getNode(id);
      if (!node) continue;
      session.types.add(node.nodeType);
      if (node.layout) session.layouts.set(node.layout.type, this.engine.layouts.get(node.layout.type));
    }
    this.active = session;
    return session;
  }

  private onChange(changes: DocumentChangeSet, record: CanvasOperationRecord): void {
    const session = this.active;
    if (!session || (this.applying && record.origin === 'local' && record.groupId === session.groupId)) return;
    const related = (id: string): boolean =>
      session.members.has(id) ||
      session.ancestors.has(id) ||
      this.engine.entityStore.getAncestorIds(id).some((parent) => session.members.has(parent));
    const nodesChanged = [
      changes.nodes.geometry,
      changes.nodes.worldGeometry,
      changes.nodes.data,
      changes.nodes.removed
    ];
    const connectorsChanged = [changes.connectors.geometry, changes.connectors.data, changes.connectors.removed];
    if (changes.contentReplaced) {
      this.end();
      return;
    }
    for (const ids of nodesChanged)
      for (const id of ids) {
        if (related(id)) {
          this.end();
          return;
        }
      }
    for (const ids of connectorsChanged)
      for (const id of ids) {
        const connector = this.engine.documentStore.getConnector(id);
        if (
          session.connectorIds.has(id) ||
          (connector !== undefined &&
            session.members.has(connector.from.nodeId!) &&
            session.members.has(connector.to.nodeId!))
        ) {
          this.end();
          return;
        }
      }
  }
}
