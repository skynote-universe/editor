# @skynote/editor

> A ready-to-use infinite-canvas whiteboard editor. One class assembles the [SkyNote](https://github.com/skynote-universe) kernel with sticky notes, text, shapes, frames, connectors, selection, snapping, clipboard and undo/redo; the rendering backend is pluggable (LeaferJS by default). Framework-agnostic, MIT licensed.

开箱即用的无限画布白板编辑器：一个类装配好内核、基础节点与全部基础交互，渲染后端可替换 (默认 LeaferJS)。与界面框架无关，Vue、React 或原生页面都能直接使用。

## 特性

- **基础节点**：便签、自由文本、形状 (矩形、圆形、菱形、三角形、星形)、画框容器，均支持画布内富文本编辑。
- **连线**：直线、正交折线、曲线；端点吸附节点锚点，拖到空白处可接着新建图形。
- **交互**：点选与框选、移动、缩放、旋转，边缘 / 中心 / 等间距吸附参考线，复制粘贴，图层顺序，锁定。
- **完整撤销**：每次修改一步撤销，连续调整 (拖动滑块、取色) 自动合并。
- **主题**：亮色 / 暗色与自定义种子色，切换即重绘；光标整套自绘并可统一配色或覆盖。
- **安全导入**：导入的文件与粘贴的数据经白名单校验，拒绝内联 Base64 与原型链污染。

## 安装

```bash
npm i @skynote/editor @skynote/renderer-leafer
```

## 快速上手

```ts
import { SkyNoteEditor } from '@skynote/editor';
import { LeaferAdapter } from '@skynote/renderer-leafer';

// 容器需要有确定的宽高
const container = document.getElementById('canvas')!;
const editor = new SkyNoteEditor<HTMLElement>({ renderer: new LeaferAdapter() });
editor.mount(container);

editor.insertNodeAtViewportCenter({ nodeType: 'sticky' });
editor.insertNodeAtViewportCenter({ nodeType: 'shape', options: { geometry: 'star' } });
editor.onSelectionChange(() => console.log([...editor.selectedNodeIds]));

// 保存与打开：导出的是纯 JSON；导入失败时给出出错位置，当前内容不变
const saved = JSON.stringify(editor.exportDocument());
const result = editor.importDocument(JSON.parse(saved));
if (!result.ok) console.error(result.error);

// 页面卸载时释放
editor.destroy();
```

在 Vue 中使用时，编辑器实例不要放进 `reactive()` / `ref()`，请用 `markRaw()` 或 `shallowRef()`：深度代理会拦截引擎内部的每次读写，性能急剧下降。

## 常用接口

| 分类 | 接口 |
| --- | --- |
| 生命周期 | `mount(container)`、`unmount()`、`destroy()` |
| 新建与编辑 | `insertNodeAtViewportCenter()`、`insertNodeAt()`、`updateNodeStyle()`、`setNodeSize()`、`setLocked()`、`moveNodeLayers()`、`deleteEntities()` |
| 连线 | `startConnectorTool(type)`、`updateConnectorStyle()`、`setConnectorType()`、`connectNewNode()` |
| 选区与视口 | `select()`、`selectAll()`、`zoomAt()`、`fitContent()`、`screenToWorld()`、`worldToScreen()` |
| 文档 | `exportDocument()`、`importDocument()`、`restoreDocument()`、`undo()`、`redo()` |
| 事件 | `onSelectionChange`、`onDocumentChange`、`onCommit`、`onViewportChange`、`onHistoryChange`、`onToolChange` |
| 外观 | `setTheme()`、`resolveColor()`、`registerCursor()`、`setCursorStyle()` |
| 扩展 | 构造参数 `plugins`、`registerInputScope()`、`engine` (底层引擎) |

`onCommit` 按提交顺序给出每次修改的正向补丁，可直接用于增量保存或协同同步。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl/⌘ + Z`、`Ctrl/⌘ + Y` (或 `Ctrl/⌘ + Shift + Z`) | 撤销、重做 |
| `Ctrl/⌘ + A`、`Esc` | 全选、取消选择 |
| `Ctrl/⌘ + C / X / V`、`Ctrl/⌘ + D` | 复制、剪切、粘贴、创建副本 |
| `Delete` / `Backspace` | 删除 |
| `[`、`]` (加 `Shift` 置底、置顶) | 下移、上移一层 |
| `Ctrl/⌘ + Shift + L` | 锁定 / 解锁 |
| `Shift + L` | 切换比例锁定 |
| `X` | 连线工具 |
| `Ctrl/⌘ + =`、`Ctrl/⌘ + -`、`Ctrl/⌘ + 0`、`Shift + 1` | 放大、缩小、100%、适配全部内容 |
| 按住空格拖动，或中键拖动 | 平移画布 |
| 方向键 (加 `Shift` 步长更大) | 微移 |
| 按住 `Ctrl/⌘` 拖动 | 暂时关闭吸附 |

快捷键只在画布持有焦点时生效，输入法组合输入期间不会触发。

## 扩展

自定义节点、连线路由器、箭头、光标和快捷键都以插件形式提供，经构造参数 `plugins` 装入。插件写法见 [@skynote/core](https://github.com/skynote-universe/core#编写插件)。

## 相关包

| 包 | 说明 |
| --- | --- |
| [@skynote/core](https://github.com/skynote-universe/core) | 平台中立内核：文档模型、事务与撤销、插件协议 |
| [@skynote/renderer-leafer](https://github.com/skynote-universe/renderer-leafer) | 基于 LeaferJS 的渲染器 |
| [@skynote/plugins-basic](https://github.com/skynote-universe/plugins-basic) | 基础节点与交互插件 |
| **@skynote/editor** | 开箱即用的编辑器 (本包) |
| [web](https://github.com/skynote-universe/web) | 官方示例应用 (Vue 3) |

## 许可证

[MIT](./LICENSE)
