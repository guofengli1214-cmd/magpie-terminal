// 文件面板（TASK-V4-G §5.5）：终端下方的常驻区域，跟随当前终端目录，
// 支持 列表 / 新建 / 查看 / 编辑 / 重命名 / 删除 / 上传 / 下载 / **多选批量**。
//
// 四件事必须记住：
// 1. 面板只依赖 api + store 的**只读**快照，不发 WS 帧（上行帧本卡不新增）。
// 2. 高度只写 localStorage（key `magpie.term.filePanelHeight`），范围 150–520px。
// 3. 分界必须同时有三样：1px 亮线 + `inset 0 7px 14px` 内投影 + 常显 46×4 把手
//    （CHANGES-V4 §4 第 15 条）。CSS 在 components.css 的 `.file-panel*` 段。
// 4. 选择模型是 `selected: Set<string>`，存**绝对路径**（不是索引 —— 列表刷新 /
//    排序变化后索引会错位）。见下面的多选状态机（TASK-FIX17-C R2）。
//
// 跟随规则：收到 `session.cwd` 且该会话就是面板当前绑定的会话、且用户没有手动
// 切过目录（manualPath=false）→ 自动跳过去。手动进目录后停止跟随，工具条上的
// **定位按钮**（常显，内联 SVG）一键回到终端目录并恢复跟随（TASK-FIX17-C R1）。

const HEIGHT_KEY = "magpie.term.filePanelHeight";
const OPEN_KEY = "magpie.term.filePanelOpen";
export const MIN_HEIGHT = 150;
export const MAX_HEIGHT = 520;
export const DEFAULT_HEIGHT = 224;

// TASK-FIX-ACCEPT4：虚拟滚动。只渲染「可视行 ± OVERSCAN 行」，上下各放一个
// 跨全列的 spacer 撑住滚动高度（滚动条仍按全量条目算）。
// 行高/行间距必须有兜底值：getComputedStyle 在面板 hidden 时也读得到，但
// 万一以后 CSS 换成别的单位，兜底能保证不把窗口算成 0 行。
export const VIRTUAL_OVERSCAN_ROWS = 2;
// 小目录直通阈值：≤ 400 项的目录**整份渲染**，DOM 与改动前逐节点一致
// （任务书 §任务1 第 5 条「小目录行为与现在一致」）。400 也是本卡的 DOM 上限，
// 所以大目录虚拟化后（可视行 ± 2 行，实测 60–84 条）依然远低于这条线。
export const FULL_RENDER_LIMIT = 400;
const ROW_HEIGHT_FALLBACK = 74;
const ROW_GAP_FALLBACK = 2;

/** `grid-template-columns` 的计算值 → 列数（`none`/空记 0）。纯函数，可单测。 */
export function countTracks(value) {
  const text = String(value || "").trim();
  if (!text || text === "none") return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * 纯窗口计算（可单测）：给定总数 / 列数 / 行高 / 滚动位置，算出要渲染的条目区间。
 *
 * - `topRows` / `bottomRows` 是上下 spacer 要占的行数；
 * - `startIndex..endIndex` 是真正要 append 的条目下标区间（左闭右开）；
 * - 小目录（总行数放得下）会得到 topRows=0 / bottomRows=0 / 全量区间，
 *   与改动前的 DOM 完全一致。
 */
export function computeWindow({
  count = 0,
  columns = 1,
  rowHeight = ROW_HEIGHT_FALLBACK,
  rowGap = ROW_GAP_FALLBACK,
  scrollTop = 0,
  viewportHeight = 0,
  overscan = VIRTUAL_OVERSCAN_ROWS,
  fullRenderLimit = FULL_RENDER_LIMIT,
} = {}) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const cols = Math.max(1, Math.floor(Number(columns) || 1));
  const rowH = Math.max(1, Number(rowHeight) || ROW_HEIGHT_FALLBACK);
  const rowG = Math.max(0, Number(rowGap) || 0);
  const step = rowH + rowG;
  const view = Math.max(0, Number(viewportHeight) || 0);
  const top = Math.max(0, Number(scrollTop) || 0);
  const pad = Math.max(0, Math.floor(Number(overscan) || 0));
  const totalRows = Math.ceil(total / cols);
  // 小目录直通：全量渲染，上下 spacer 都是 0 行 —— 与改动前的 DOM 完全同构。
  if (total > 0 && total <= Math.max(0, Number(fullRenderLimit) || 0)) {
    return {
      columns: cols,
      totalRows,
      startRow: 0,
      endRow: totalRows,
      startIndex: 0,
      endIndex: total,
      topRows: 0,
      bottomRows: 0,
      rendered: total,
      fullRender: true,
    };
  }
  const firstRow = Math.floor(top / step);
  const startRow = Math.max(0, Math.min(totalRows, firstRow - pad));
  const endRow = Math.max(startRow, Math.min(totalRows, Math.ceil((top + view) / step) + pad));
  const startIndex = Math.min(total, startRow * cols);
  const endIndex = Math.min(total, endRow * cols);
  return {
    columns: cols,
    totalRows,
    startRow,
    endRow,
    startIndex,
    endIndex,
    topRows: startRow,
    bottomRows: totalRows - endRow,
    rendered: endIndex - startIndex,
    fullRender: false,
  };
}

/* ------------------ 条目动作清单与菜单定位（TASK-FIX-UI-REST §6.2/§6.3） ------------------
 *
 * 以前每条目里都塞一条横排的 `.file-panel-fmore`（5 个文字按钮 ≈150px），
 * 而格子只有 110–117px → 左侧溢出 42–50px、盖住图标。现在改成「点 ⋯ 在面板级
 * 弹一个竖排菜单」：文字放得下、零横向溢出，每行 DOM 从 6 个 button 降到 1 个。
 *
 * 下面三样都是纯函数/常量，方便单测，也避免开菜单时先测量再定位造成的闪烁。
 */

/** 菜单项高度（px）。必须与 components.css 的 `.file-panel-menu-item` 对齐。 */
export const MENU_ITEM_HEIGHT = 26;
/** 菜单除菜单项外的固定开销（1px 边框×2 + 1px 内边距×2）。 */
export const MENU_CHROME = 4;
/** 菜单宽度（px）：CSS 里 `min-width: 120px`，文案最长「重命名」放得下。 */
export const MENU_WIDTH = 120;
/** 菜单与按钮之间的垂直间隙（px）。 */
export const MENU_GAP = 2;
/** 菜单与面板四边的最小留白（px）。 */
export const MENU_MARGIN = 4;

/**
 * 条目可执行的动作清单（顺序即菜单顺序）。
 * @param {{type?: string}} entry
 * @returns {Array<{label: string, action: string}>}
 */
export function actionsForEntry(entry) {
  if (entry && entry.type === "dir") {
    return [
      { label: "打开", action: "open" },
      { label: "重命名", action: "rename" },
      { label: "删除", action: "delete" },
    ];
  }
  return [
    { label: "查看", action: "view" },
    { label: "编辑", action: "edit" },
    { label: "重命名", action: "rename" },
    { label: "下载", action: "download" },
    { label: "删除", action: "delete" },
  ];
}

/** 菜单尺寸：按条目数算（不读 DOM）。 */
export function menuSizeFor(count) {
  const items = Math.max(0, Math.floor(Number(count) || 0));
  return { width: MENU_WIDTH, height: items > 0 ? items * MENU_ITEM_HEIGHT + MENU_CHROME : 0 };
}

/** DOMRect / {left,top,width,height} / {left,top,right,bottom} → 统一矩形；非法返回 null。 */
function numericRect(value) {
  if (!value) return null;
  const left = Number(value.left);
  const top = Number(value.top);
  const width = Number(value.width !== undefined ? value.width : value.w);
  const height = Number(value.height !== undefined ? value.height : value.h);
  let right = Number(value.right);
  let bottom = Number(value.bottom);
  if (!Number.isFinite(right)) right = Number.isFinite(width) ? left + width : NaN;
  if (!Number.isFinite(bottom)) bottom = Number.isFinite(height) ? top + height : NaN;
  if (![left, top, right, bottom].every((n) => Number.isFinite(n))) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * 菜单尺寸：接受 `{width, height}` / `{w, h}`（也容忍带 left/top 的矩形）。
 * 拿不到就按「最长的文件菜单」（5 项）算，宁可多留白也不越界。
 */
function menuSize(menu) {
  const fallback = menuSizeFor(5);
  if (!menu || typeof menu !== "object") return fallback;
  const width = Number(menu.width !== undefined ? menu.width : menu.w);
  const height = Number(menu.height !== undefined ? menu.height : menu.h);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallback.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.height,
  };
}

/**
 * 菜单定位（视口坐标，纯函数）：优先贴在「锚点」下方，放不下翻到上方，
 * 左右按面板内缩 4px 钳制；面板比菜单还窄/矮时取左上边界，绝不出负数。
 *
 * 水平按 `btn`（⋯ 按钮）对齐；垂直按 `anchor`（整张条目卡片）对齐 ——
 * 这样菜单落在整张卡片的下方/上方，不会压住「这一行自己的文件名与图标」。
 * 不传 `anchor` 时退回 `btn`（与 TASK §6.3 的原始公式一致）。
 *
 * @param {{btn?: object, anchor?: object, menu?: object, panel?: object}} input
 *   `btn` / `anchor` / `panel` 接受 DOMRect 或 `{left, top, right, bottom}` /
 *   `{left, top, width, height}`；`menu` 只要 `{width, height}`（用 menuSizeFor() 算）。
 * @returns {{left: number, top: number, placement: "above"|"below"|"side"|"fit"}}
 *   视口坐标（写 CSS 前要减去面板原点）。`placement` 是真实几何关系：菜单整块
 *   在锚点上方 → "above"，整块在下方 → "below"，上下都放不下、改到卡片旁边
 *   → "side"，连旁边也放不下（面板比菜单还窄）→ "fit"（硬塞在面板内）。
 */
export function clampMenuPosition({ btn, anchor, menu, panel } = {}) {
  const button = numericRect(btn);
  const frame = numericRect(panel);
  // 参数不完整（如面板还未布局）：不抛异常，返回一个「什么都不能用」的结果。
  if (!button || !frame) return { left: 0, top: 0, placement: "fit" };
  const ref = numericRect(anchor) || button;
  const { width, height } = menuSize(menu);

  const minLeft = frame.left + MENU_MARGIN;
  const maxLeft = frame.right - width - MENU_MARGIN;
  // 先按「按钮左缘」贴齐，再钳进面板；面板太窄时 minLeft 胜出（不产生负数）。
  const left = Math.max(minLeft, Math.min(button.left, maxLeft));

  const minTop = frame.top + MENU_MARGIN;
  const maxTop = frame.bottom - height - MENU_MARGIN;
  const below = ref.bottom + MENU_GAP;
  const above = ref.top - height - MENU_GAP;

  if (below <= maxTop) return { left, top: below, placement: "below" };
  if (above >= minTop && above <= maxTop) return { left, top: above, placement: "above" };

  // 上/下都放不下（面板只有两三行高）：改到卡片右侧（放不下则左侧），
  // 让菜单「不遮住你正在操作的那一行」——比直接压在它上面好理解得多。
  const sideTop = Math.max(minTop, Math.min(ref.top, maxTop));
  const rightSide = ref.right + MENU_GAP;
  if (rightSide + width <= frame.right - MENU_MARGIN) {
    return { left: rightSide, top: sideTop, placement: "side" };
  }
  const leftSide = ref.left - width - MENU_GAP;
  if (leftSide >= minLeft) {
    return { left: leftSide, top: sideTop, placement: "side" };
  }

  // 面板比菜单还窄：只能硬塞进面板左上角（不越界优先）。
  return {
    left,
    top: Math.max(minTop, Math.min(above, maxTop)),
    placement: "fit",
  };
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatTime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 条目图标（与旧 file-tree.js 的语义一致：目录/链接/文件三态）。
 *
 * `kind` 是**上色用的语义**：`[data-kind=…]` 负责 dir/accent、js|ts/warn、json|md/ok。
 * `icon` 只是图形（ICONS 的键名）。两者故意分开：按扩展名分支的条目（js/ts/json/md/img）
 * 共用同一张纸，但颜色不同；把图形名当 kind 会把这些颜色一并抹掉。 */
function iconFor(entry) {
  if (entry.type === "dir") return { kind: "dir", icon: "folder" };
  if (entry.type === "link") return { kind: "link", icon: "link" };
  const name = String(entry.name || "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const kind =
    ["js", "mjs", "cjs", "jsx"].includes(ext) ? "js"
    : ["ts", "tsx"].includes(ext) ? "ts"
    : ext === "json" ? "json"
    : ["md", "markdown"].includes(ext) ? "md"
    : ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext) ? "img"
    : "file";
  return { kind, icon: "file" };
}

/**
 * 批量移动的分批大小（TASK-FIX17-C R3）。
 *
 * 服务端的 `POST /api/fs/move` 有两条上限：`MAX_MOVE_ITEMS = 500`（项数）与
 * 64KB 的 JSON body（`http.mjs`）。所以前端按 50 项一批发，失败汇总后再刷新。
 */
export const MOVE_CHUNK_SIZE = 50;

/** 文件面板工具栏的图标（内联 SVG，不引外部资源：沙箱禁 CDN）。 */
const ICONS = {
  // 准星：定位到终端所在目录（R1）
  locate:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3.2M12 18.2v3.2M21.4 12h-3.2M5.8 12H2.6"/>',
  // 文件夹 + 右箭头：批量移动
  move:
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l1.6 1.8h4.4"/><path d="M11.5 19.5H4.5A1.5 1.5 0 0 1 3 18V6.5"/><path d="M14.5 14.5H21m0 0-2.7-2.7M21 14.5l-2.7 2.7"/>',
  // 垃圾桶：批量删除
  trash:
    '<path d="M4 7h16M9.5 7V4.8h5V7M6.4 7l.9 12.4a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/><path d="M10.2 10.8v6.4M13.8 10.8v6.4"/>',
  // 下箭头：批量下载
  download: '<path d="M12 4v10.2"/><path d="M7.8 10.2 12 14.4l4.2-4.2"/><path d="M4.6 18.4h14.8"/>',
  // ✕：取消选择
  cancel: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"/>',
  // 文件夹：顶部带折角的闭合轮廓（条目的结构图标，替掉原来的 emoji）
  folder:
    '<path d="M4 7.2A1.7 1.7 0 0 1 5.7 5.5h3.4l1.9 2.2h7.3A1.7 1.7 0 0 1 20 9.4v7.4a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 16.8Z"/>',
  // 纸张 + 右下折角
  file: '<path d="M6.5 4.5h7l4 4v11h-11Z"/><path d="M13.5 4.5v4h4"/>',
  // 链接：斜向链条（与 folder/file 同一套 1.7px 描边、无填充）
  link:
    '<path d="M10.4 13.6a3.4 3.4 0 0 0 4.8 0l2.6-2.6a3.4 3.4 0 1 0-4.8-4.8l-1.3 1.3"/><path d="M13.6 10.4a3.4 3.4 0 0 0-4.8 0l-2.6 2.6a3.4 3.4 0 1 0 4.8 4.8l1.3-1.3"/>',
};

/**
 * 造一个内联 SVG 图标节点（纯 DOM，不返回字符串）。
 *
 * `aria-hidden` + `focusable=false`：图标不进读屏、不在 Tab 序列里，
 * 语义一律由父按钮的 `title` / `aria-label` 提供。
 *
 * @param {keyof ICONS} name
 * @param {number} [size]
 */
function iconSvg(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = ICONS[name] || "";
  return svg;
}

/** 定位按钮的三态（R1 / AC2）。 */
export const LOCATE_STATE = Object.freeze({
  NO_TERMINAL: "no-terminal",
  CURRENT: "current",
  AWAY: "away",
});

/**
 * 两个路径是否指同一处（Windows 大小写不敏感、分隔符混用）。纯函数。
 *
 * @param {string} a
 * @param {string} b
 */
export function samePath(a, b) {
  const norm = (value) =>
    String(value == null ? "" : value)
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 定位按钮该显示成哪一态 + 给什么 title（AC2 的三态）。
 *
 *   - `no-terminal`：没有活动终端 / 终端还没上报 cwd → 禁用，title 说明原因；
 *   - `current`：当前路径已经等于终端 cwd → 弱化（不是隐藏，用户要看得见）；
 *   - `away`：可用，点了就跳过去并恢复跟随。
 *
 * @param {{termCwd?: string|null, path?: string|null, hasSession?: boolean}} input
 * @returns {{state: string, disabled: boolean, title: string}}
 */
export function locateButtonState(input = {}) {
  const termCwd = typeof input.termCwd === "string" ? input.termCwd.trim() : "";
  const current = typeof input.path === "string" ? input.path.trim() : "";
  if (!input.hasSession || termCwd.length === 0) {
    return {
      state: LOCATE_STATE.NO_TERMINAL,
      disabled: true,
      title: input.hasSession ? "这个终端还没上报目录，等它出现第一个提示符" : "当前没有终端，无法定位",
    };
  }
  if (samePath(termCwd, current)) {
    return { state: LOCATE_STATE.CURRENT, disabled: false, title: "已在此目录（点一下仍然可以重新跟随）" };
  }
  return { state: LOCATE_STATE.AWAY, disabled: false, title: `定位到终端所在目录：${termCwd}` };
}

/**
 * 多选状态机（R2 / AC3）。纯函数：输入当前选择 + 事件，输出新的选择与锚点。
 *
 * 规则（与文件管理器一致）：
 *   - 普通点击：清空其它，只选这一条，锚点 = 这一条；
 *   - Ctrl/Cmd + 点击：切换这一条（锚点跟着走，与 Explorer 一致）；
 *   - Shift + 点击：从锚点到这一条的**可见顺序区间**全选（锚点不动）。
 *     没有锚点时退化成普通点击。
 *
 * @param {{selected?: Set<string>|string[], anchor?: string|null, paths?: string[], index?: number,
 *          shift?: boolean, toggle?: boolean}} input
 * @returns {{selected: Set<string>, anchor: string|null}}
 */
export function applySelectionClick(input = {}) {
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const index = Number(input.index);
  const path = paths[index];
  const selected = new Set(
    input.selected instanceof Set ? [...input.selected] : Array.isArray(input.selected) ? input.selected : [],
  );
  let anchor = typeof input.anchor === "string" ? input.anchor : null;
  if (typeof path !== "string" || path.length === 0) return { selected, anchor };

  if (input.shift === true && anchor !== null) {
    const anchorIndex = paths.indexOf(anchor);
    if (anchorIndex >= 0) {
      // Shift 区间是加法语义：区间内的旧选择保留（与 Explorer 一致）。
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      for (let i = start; i <= end; i += 1) selected.add(paths[i]);
      return { selected, anchor };
    }
    // 锚点已经不在当前列表里（切过目录 / 条目被删）→ 当普通点击处理。
    anchor = null;
  }

  if (input.toggle === true) {
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path };
  }

  return { selected: new Set([path]), anchor: path };
}

/**
 * 批量删除/移动后要清掉的选择：只保留**仍然存在**的路径。
 *
 * 例：选了 5 项，其中 3 项删成功、2 项失败 → 选择里只留那 2 项，
 * 用户能直接重试，而不用重新找它们。
 *
 * @param {Set<string>} selected
 * @param {Set<string>} survivors 保留下来的路径（失败的 / 还在的）
 * @returns {Set<string>}
 */
export function pruneSelection(selected, survivors) {
  const next = new Set();
  const keep = survivors && typeof survivors.has === "function" ? survivors : new Set();
  for (const path of selected || []) {
    if (keep.has(path)) next.add(path);
  }
  return next;
}

/** 父路径（按分隔符风格）；到根返回 null。 */
function parentOf(target) {
  const text = String(target || "").replace(/[\\/]+$/, "");
  if (!text) return null;
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return "/";
  const parent = text.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

function joinPath(dir, name) {
  const base = String(dir || "");
  if (!base) return name;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  return `${base}${sep}${name}`;
}

/** 取路径的最后一段（`C:\\a\\b.txt` → `b.txt`）。纯函数。 */
export function baseNameOf(target) {
  const text = String(target == null ? "" : target).replace(/[\\/]+$/, "");
  if (!text) return "";
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return index >= 0 ? text.slice(index + 1) : text;
}

/**
 * 把选中的每项推到目标目录下（批量移动的 `to` 计算）。
 *
 * 源和目标目录相同时**不产生条目**：服务端会把它当 INVALID_PATH
 * （from === to），而用户看到的就是「什么都没发生」，不如前端直接不动。
 *
 * @param {string[]} sources
 * @param {string} targetDir
 * @returns {Array<{from:string, to:string}>}
 */
export function movePlan(sources, targetDir) {
  const dir = String(targetDir == null ? "" : targetDir).trim();
  if (!dir) return [];
  const plan = [];
  for (const from of Array.isArray(sources) ? sources : []) {
    const name = baseNameOf(from);
    if (!name) continue;
    const to = joinPath(dir, name);
    if (samePath(from, to)) continue;
    plan.push({ from, to });
  }
  return plan;
}

/**
 * 把一批 move 请求按 `chunkSize` 切开（服务端 64KB body + 500 项上限）。
 * 纯函数。
 *
 * @param {Array<{from:string,to:string}>} items
 * @param {number} [chunkSize]
 */
export function chunkMoves(items, chunkSize = MOVE_CHUNK_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(chunkSize) || 1));
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

export default function createFilePanel(elements) {
  const api = elements.api;
  const store = elements.store;
  const host = elements.host;
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};

  const state = {
    open: false,
    height: DEFAULT_HEIGHT,
    // 面板绑定的会话（id / kind / hostId / cwd）
    sessionId: null,
    kind: "local",
    hostId: null,
    termCwd: null,
    path: null,
    parent: null,
    entries: [],
    // TASK-FIX17-C R2：多选。存**绝对路径**（不是索引）；锚点给 Shift 区间用。
    selected: new Set(),
    anchorPath: null,
    // 批量操作进行中：禁用按钮防重复提交。
    batchBusy: false,
    manualPath: false,
    busy: false,
    uploads: [],
  };

  let root = null;
  let toolbar = null;
  let pathInput = null;
  let pathSlot = null;
  let batchBar = null;
  let locateButton = null;
  let grid = null;
  let statusLine = null;
  let uploadHost = null;
  // TASK-FIX17-L1 R4：下载到目录后的回显行（完整路径 + 打开所在文件夹）。
  let savedHint = null;
  let savedHintPath = null;
  let savedReveal = null;
  let lastSavedPath = null;
  let backdrop = null;
  let modal = null;
  let unsubscribe = null;
  let lastActiveId = null;
  // TASK-FIX-UI-REST：面板级动作菜单（挂在 .file-panel 根上，不进 grid）。
  let actionMenu = null;

  // TASK-FIX-ACCEPT4：虚拟窗口状态。
  let topSpacer = null;
  let bottomSpacer = null;
  let paintScheduled = false;
  let needsPaint = true;
  let gridObserver = null;
  let focusPath = null;
  let rendered = {
    startIndex: 0,
    endIndex: 0,
    columns: 0,
    topRows: 0,
    bottomRows: 0,
    rowHeight: 0,
  };

  /* ---------------------------- 存储 ---------------------------- */

  function readStoredHeight() {
    try {
      const raw = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(raw) && raw > 0) {
        return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(raw)));
      }
    } catch {
      // localStorage 不可用（沙箱里也可能被拒）：用默认值。
    }
    return DEFAULT_HEIGHT;
  }

  function storeHeight(value) {
    try {
      localStorage.setItem(HEIGHT_KEY, String(value));
    } catch {
      // 忽略。
    }
  }

  function readStoredOpen() {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      return raw === null ? false : raw === "1";
    } catch {
      return false;
    }
  }

  function storeOpen(value) {
    try {
      localStorage.setItem(OPEN_KEY, value ? "1" : "0");
    } catch {
      // 忽略。
    }
  }

  /* ---------------------------- 布局 ---------------------------- */

  function applyHeight(value) {
    state.height = value;
    if (root) root.style.height = `${value}px`;
    if (root) root.setAttribute("data-height", String(value));
    // 供 CSS 算把手位置：AI 把手只在上方的终端区域垂直居中，
    // 不能压在文件面板工具条（关闭按钮）上。
    try {
      document.documentElement.style.setProperty("--file-panel-h", `${value}px`);
    } catch {
      // 忽略。
    }
  }

  function applyOpen() {
    if (!root) return;
    root.hidden = !state.open;
    // 面板收起时浮层菜单不能留在屏幕上。
    if (!state.open) closeActionMenu({ restoreFocus: false });
    document.documentElement.setAttribute("data-files-open", state.open ? "true" : "false");
    const railButton = document.querySelector('[data-role="rail-files"]');
    if (railButton) {
      railButton.setAttribute("aria-pressed", state.open ? "true" : "false");
      railButton.setAttribute("data-active", state.open ? "true" : "false");
    }
    if (state.open) {
      // 收起时宽度/高度为 0（先前记为 needsPaint），展开后要立刻补画一次窗口。
      needsPaint = true;
      schedulePaint();
      // 打开面板会改变终端可用高度：让 xterm 重新 fit（走常规 resize 管道）。
      window.dispatchEvent(new CustomEvent("magpie:file-panel-toggle", { detail: { open: true } }));
    } else {
      window.dispatchEvent(new CustomEvent("magpie:file-panel-toggle", { detail: { open: false } }));
    }
  }

  /* ---------------------------- 数据 ---------------------------- */

  function target() {
    return state.kind === "remote" && state.hostId ? { hostId: state.hostId } : null;
  }

  async function load(pathValue, opts = {}) {
    if (state.busy) return;
    state.busy = true;
    // 换目录后上一轮的「已保存到 …」不再跟当前视野相关，收起来。
    if (savedHint) savedHint.hidden = true;
    renderGridMessage("正在读取目录…");
    const wanted = typeof pathValue === "string" && pathValue.length > 0 ? pathValue : state.path || ".";
    const result = await api.fsList(target(), wanted);
    state.busy = false;
    if (!result.ok) {
      state.entries = [];
      renderGridMessage(result.userText || `读取失败（${result.code}）`, true);
      onNotice(result.userText || "列不出这个目录。", "warn");
      return;
    }
    const data = result.data || {};
    state.path = typeof data.path === "string" && data.path.length > 0 ? data.path : wanted;
    state.parent = typeof data.parent === "string" ? data.parent : parentOf(state.path);
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    if (!opts.keepSelection) {
      state.selected.clear();
      state.anchorPath = null;
    }
    render();
  }

  /** 当前会话的终端目录 → 面板目录（跟随开关打开时才动）。 */
  async function followTerminalCwd(cwd) {
    if (typeof cwd !== "string" || cwd.length === 0) return;
    state.termCwd = cwd;
    renderLocateButton();
    if (state.manualPath) return;
    if (samePath(state.path, cwd)) return;
    await load(cwd);
  }

  /** R1：点定位按钮 = 显式要求跟随（清掉 manualPath 再跳过去）。 */
  async function locateToTerminalCwd() {
    const cwd = state.termCwd;
    if (typeof cwd !== "string" || cwd.length === 0) return;
    // 点它 = 显式要求重新跟随，把「手动改过路径」这件事清掉。
    state.manualPath = false;
    state.selected.clear();
    state.anchorPath = null;
    // 已经在目录里也刷一遍：用户点它可能就是想「重新读一次并恢复跟随」。
    await load(cwd);
    renderToolbarSlots();
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function renderPathBar() {
    if (!pathInput) return;
    pathInput.value = state.path || "";
    pathInput.title = state.path || "";
  }

  /**
   * 定位按钮三态（R1 / AC2）：**常显**，只是状态不同。
   *
   * 之前这里是一个 `hidden = !(manualPath && termCwd !== path)` 的文字按钮，
   * 用户基本看不到它（问题 5）。现在改成：存在就一直在，靠 `data-state` +
   * `title` 表达「没有终端 / 已在此处 / 可以跳过去」。
   */
  function renderLocateButton() {
    if (!locateButton) return;
    const view = locateButtonState({
      termCwd: state.termCwd,
      path: state.path,
      hasSession: Boolean(state.sessionId),
    });
    locateButton.setAttribute("data-state", view.state);
    locateButton.disabled = view.disabled;
    locateButton.title = view.title;
    locateButton.setAttribute("aria-label", view.title);
    locateButton.setAttribute("aria-disabled", view.disabled ? "true" : "false");
  }

  /**
   * 工具栏的两个分支（R2 / AC4）：
   *
   *   - 没选中任何项 → 显示路径输入框；
   *   - 选中 ≥ 1 项 → 同一个容器里换成批量操作条（不是另加一行）。
   *
   * 两个分支的容器高度由 CSS 固定（`.file-panel-slot{height:28px}`），
   * 所以切换不跳版。DOM 复用同一个 `pathSlot`，不用重建整个 toolbar（重建会
   * 把焦点与 IME 状态弄没）。
   */
  function renderToolbarSlots() {
    renderPathBar();
    renderLocateButton();
    if (!pathSlot) return;
    const count = state.selected.size;
    const showBatch = count > 0;
    if (pathSlot.getAttribute("data-mode") !== (showBatch ? "batch" : "path")) {
      pathSlot.setAttribute("data-mode", showBatch ? "batch" : "path");
    }
    if (pathInput) pathInput.hidden = showBatch;
    if (batchBar) {
      batchBar.hidden = !showBatch;
      if (showBatch) renderBatchBar();
    }
  }

  /** 批量条里的计数与按钮可用性。 */
  function renderBatchBar() {
    if (!batchBar) return;
    const count = state.selected.size;
    const label = batchBar.querySelector('[data-role="files-batch-count"]');
    if (label) label.textContent = `已选 ${count} 项`;
    for (const button of batchBar.querySelectorAll("button")) {
      // 取消选择始终可用（批量操作卡住时用户必须能退出）。
      if (button.getAttribute("data-role") === "files-batch-cancel") continue;
      button.disabled = state.batchBusy || count === 0;
    }
    batchBar.setAttribute("aria-busy", state.batchBusy ? "true" : "false");
  }

  function renderGridMessage(text, isError) {
    if (!grid) return;
    // 重渲染一律关菜单：剩一个指向旧条目的悬空菜单比消失更难理解。
    closeActionMenu({ restoreFocus: false });
    rendered = { startIndex: 0, endIndex: 0, columns: 0 };
    grid.textContent = "";
    const note = el("p", { className: "file-panel-empty" }, text);
    if (isError) note.setAttribute("data-tone", "error");
    grid.appendChild(note);
  }

  function render() {
    // renderToolbarSlots 内部已调 renderPathBar + renderLocateButton。
    renderToolbarSlots();
    // 切目录 / 刷新：菜单指向的条目即将被重建，先收掉。
    closeActionMenu({ restoreFocus: false });
    if (!grid) return;
    rendered = { startIndex: 0, endIndex: 0, columns: 0 };
    if (state.entries.length === 0) {
      grid.textContent = "";
      renderGridMessage("这个目录是空的。");
      renderStatus();
      return;
    }
    // 切目录 / 刷新：回到顶部，然后只铺可视窗口。
    grid.textContent = "";
    topSpacer = null;
    bottomSpacer = null;
    grid.scrollTop = 0;
    paintWindow({ rebuild: true });
    renderStatus();
  }

  /* ------------------------- 虚拟窗口（TASK-FIX-ACCEPT4） ------------------------- */

  /**
   * 从布局里量当前的列数 / 行高 / 行距 / 可视高。
   * 面板 hidden 或宽度为 0 时列数为 0，调用方必须推迟渲染——
   * 否则 1 万条会被当成「放得下」全铺出来。
   */
  function gridMetrics() {
    if (!grid) return null;
    const cs = getComputedStyle(grid);
    return {
      columns: countTracks(cs.gridTemplateColumns),
      rowHeight: Number.parseFloat(cs.gridAutoRows) || ROW_HEIGHT_FALLBACK,
      rowGap: Number.parseFloat(cs.rowGap) || 0,
      viewportHeight: grid.clientHeight || 0,
      scrollTop: grid.scrollTop || 0,
    };
  }

  function ensureSpacers() {
    if (!grid) return;
    if (!topSpacer || topSpacer.parentNode !== grid) {
      topSpacer = el("div", {
        className: "file-panel-spacer",
        "data-role": "file-panel-spacer-top",
        "aria-hidden": "true",
      });
      grid.insertBefore(topSpacer, grid.firstChild);
    }
    if (!bottomSpacer || bottomSpacer.parentNode !== grid) {
      bottomSpacer = el("div", {
        className: "file-panel-spacer",
        "data-role": "file-panel-spacer-bottom",
        "aria-hidden": "true",
      });
      grid.appendChild(bottomSpacer);
    }
  }

  /** 0 行时就地移除（不占 DOM，小目录与改动前完全同构）。 */
  function applySpacer(spacer, rows) {
    if (!spacer) return;
    const n = Math.max(0, Math.floor(Number(rows) || 0));
    if (n <= 0) {
      if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
      return;
    }
    spacer.style.gridRow = `span ${n}`;
    if (spacer.parentNode !== grid) grid.insertBefore(spacer, spacer === topSpacer ? grid.firstChild : null);
  }

  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    const run = () => {
      paintScheduled = false;
      paintWindow();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** 按当前滚动位置与列数只铺「可视行 ± OVERSCAN 行」。 */
  function paintWindow({ rebuild = false } = {}) {
    if (!grid) return;
    const metrics = gridMetrics();
    if (!metrics || metrics.columns < 1 || metrics.viewportHeight <= 0) {
      // 面板收着 / 宽度为 0：先记脏，等真正有布局时（ResizeObserver / applyOpen）
      // 再算。这里不能自旋 rAF，否则收起状态下每帧空转。
      needsPaint = true;
      return;
    }
    needsPaint = false;
    const win = computeWindow({ count: state.entries.length, ...metrics });
    const unchanged =
      !rebuild &&
      rendered.startIndex === win.startIndex &&
      rendered.endIndex === win.endIndex &&
      rendered.columns === win.columns &&
      rendered.topRows === win.topRows &&
      rendered.bottomRows === win.bottomRows &&
      rendered.rowHeight === metrics.rowHeight;
    if (unchanged) return;

    // 条目区间没变、只是 spacer 行数或行高变了（窗口高度变化）→ 只改 spacer。
    const sameRange =
      rendered.startIndex === win.startIndex &&
      rendered.endIndex === win.endIndex &&
      rendered.columns === win.columns;
    ensureSpacers();
    // 先补偿量（spacer）再动条目：同一任务里完成，浏览器不会看到中间态。
    applySpacer(topSpacer, win.topRows);
    applySpacer(bottomSpacer, win.bottomRows);
    if (sameRange) {
      rendered.topRows = win.topRows;
      rendered.bottomRows = win.bottomRows;
      rendered.rowHeight = metrics.rowHeight;
      return;
    }

    // 按 data-path 复用已有节点：滚动一格只换掉进出窗口的那几个，
    // 不重建整个窗口（hover / 选中 / 焦点都留在原地）。
    const existing = new Map();
    for (const node of grid.querySelectorAll('[data-role="file-entry"]')) {
      existing.set(node.getAttribute("data-path"), node);
    }
    const desired = [];
    for (let i = win.startIndex; i < win.endIndex; i += 1) {
      const entry = state.entries[i];
      if (!entry) continue;
      const reuse = existing.get(entry.path);
      if (reuse) {
        existing.delete(entry.path);
        desired.push(reuse);
      } else {
        desired.push(renderEntry(entry));
      }
    }

    // 焦点先记账：被移出窗口的那一条会被 removeChild，焦点会掉到 body。
    const activeEl = document.activeElement;
    const focusInsideGrid = Boolean(activeEl && activeEl.closest && activeEl.closest('[data-role="file-panel-grid"]') === grid);
    const keepFocusPath = focusPath || (focusInsideGrid && activeEl.getAttribute ? activeEl.getAttribute("data-path") : null);

    // 就地 diff：只动增/减的节点，不整块清空 —— 清空会把 scrollTop 夹回 0。
    let ref = topSpacer && topSpacer.parentNode === grid ? topSpacer.nextSibling : grid.firstChild;
    for (const node of desired) {
      if (ref === node) {
        ref = node.nextSibling;
        continue;
      }
      grid.insertBefore(node, ref);
      ref = node.nextSibling;
    }
    const stop = bottomSpacer && bottomSpacer.parentNode === grid ? bottomSpacer : null;
    while (ref && ref !== stop) {
      const next = ref.nextSibling;
      grid.removeChild(ref);
      ref = next;
    }
    // diff 只从窗口头部往尾部清，窗口后面还挂着的旧节点在这里兜底收尾。
    for (const node of existing.values()) {
      if (node.parentNode === grid) grid.removeChild(node);
    }

    rendered = {
      startIndex: win.startIndex,
      endIndex: win.endIndex,
      columns: win.columns,
      topRows: win.topRows,
      bottomRows: win.bottomRows,
      rowHeight: metrics.rowHeight,
    };

    // 焦点别丢：条目还在窗口里就把焦点还给同一个 path；
    // 它已经滚出窗口（被卸载）就把焦点交给网格容器本身（tabindex=-1），
    // 不让焦点掉到 body —— 那样键盘用户会失去位置感。
    focusPath = null;
    if (keepFocusPath) {
      const node = grid.querySelector(`[data-role="file-entry"][data-path="${cssEscape(keepFocusPath)}"]`);
      if (node && typeof node.focus === "function") {
        node.focus({ preventScroll: true });
      } else if (focusInsideGrid && typeof grid.focus === "function") {
        grid.focus({ preventScroll: true });
        grid.setAttribute("data-focus-path", keepFocusPath);
      }
    }
    // 重铺可能把菜单的锚点行卸载了 → 菜单跟着关掉（不留悬空浮层）。
    syncActionMenuToDom();
  }

  /** CSS.escape 兜底：Windows 路径里有反斜杠、空格与中文。 */
  function cssEscape(value) {
    const text = String(value == null ? "" : value);
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(text);
    return text.replace(/["\\]/g, "\\$&");
  }
  function onGridScroll() {
    // 滚动时窗内条目会重铺，菜单一律关掉（§6.3：不留悬空菜单）。
    closeActionMenu({ restoreFocus: false });
    paintWindow();
  }

  function onGridResize() {
    // 列数 / 可视高度变了：窗口要重算。paintWindow 自己会比较，没变就不动 DOM。
    closeActionMenu({ restoreFocus: false });
    paintWindow();
  }

  /**
   * 网格上的键盘（R2）：
   *   - `Ctrl/Cmd + A`（焦点在列表里）→ 全选当前目录；
   *   - `Escape` → 清空选择（菜单自己处理时已 preventDefault，这里兜底）。
   *
   * 只在事件来自网格内部时生效：页面上还有终端的 xterm，抢它的 Ctrl+A 不礼貌。
   */
  function onGridKeydown(event) {
    if (event.key === "Escape") {
      if (state.selected.size === 0) return;
      event.preventDefault();
      clearSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
      // 焦点在批量条输入框 / 路径框里时不拦（用户想全选文本）。
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      event.preventDefault();
      selectAll();
    }
  }

  /**
   * 点空白处清空选择（R2）。
   *
   * 判定「空白」：事件目标是网格容器本身、上下 spacer、或条目之间的空隙 ——
   * 都不是条目卡片、也不是卡片里的 ⋯ 按钮。
   */
  function onGridPointerDown(event) {
    if (state.selected.size === 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-role="file-entry"]')) return;
    if (target.closest('[data-role="file-action-menu"]')) return;
    clearSelection();
  }

  function renderEntry(entry) {
    const icon = iconFor(entry);
    const card = el("button", {
      type: "button",
      className: "file-panel-entry",
      "data-role": "file-entry",
      "data-type": entry.type,
      "data-name": entry.name,
      "data-path": entry.path,
      title: `${entry.path}\n${entry.type} · ${formatSize(entry.size)} · ${formatTime(entry.mtime)}`,
    });
    if (state.selected.has(entry.path)) card.setAttribute("data-selected", "true");

    // 图标是内联 SVG（不引外部资源、不受平台 emoji 字体影响）。
    // 注意不能交给 `el()` 的第三个参数：那里走 `textContent`，会把节点变成字符串。
    // 颜色由 `[data-kind=…]` 的 `color` 通过 `currentColor` 传下来。
    const type = el("span", {
      className: "file-panel-ftype",
      "data-kind": icon.kind,
      "aria-hidden": "true",
    });
    type.appendChild(iconSvg(icon.icon, 14));
    card.appendChild(type);

    const name = el("span", { className: "file-panel-fname" }, entry.name);
    card.appendChild(name);

    const meta = el(
      "span",
      { className: "file-panel-fmeta" },
      entry.type === "dir" ? formatTime(entry.mtime) : `${formatSize(entry.size)} · ${formatTime(entry.mtime)}`,
    );
    card.appendChild(meta);

    // TASK-FIX-UI-REST §6.2：行内只留一个「⋯」入口。具体动作改为点开
    // 面板级弹出菜单（见 §6.3），不再往格子里塞 5 个文字按钮。
    const moreToggle = el("button", {
      type: "button",
      className: "file-panel-more-toggle",
      "data-role": "file-more-toggle",
      title: `更多操作：${entry.name}`,
      "aria-label": `更多操作：${entry.name}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    }, "⋯");
    moreToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      // 再点同一个 ⋯ → 关闭（切换）；点别的行 → 关掉旧的、在新位置重开。
      if (openMenuEntry && openMenuEntry.path === entry.path) closeActionMenu({ restoreFocus: false });
      else openActionMenu(entry, moreToggle);
    });
    card.appendChild(moreToggle);

    card.addEventListener("click", (event) => {
      if (event.target && event.target.closest && event.target.closest(".file-panel-more-toggle")) return;
      // R2：普通 / Ctrl(mac 上 Cmd) / Shift 三套语义全在纯函数里（可单测）。
      const next = applySelectionClick({
        selected: state.selected,
        anchor: state.anchorPath,
        paths: state.entries.map((item) => item.path),
        index: state.entries.findIndex((item) => item.path === entry.path),
        shift: event.shiftKey === true,
        toggle: event.ctrlKey === true || event.metaKey === true,
      });
      state.selected = next.selected;
      state.anchorPath = next.anchor;
      paintSelection();
    });
    // 记住键盘焦点落在哪个 path：虚拟窗口重铺后要把它还回去。
    card.addEventListener("focus", () => { focusPath = entry.path; }, true);
    card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (entry.type === "dir") void enterDirectory(entry.path);
      else void openViewer(entry);
    });
    return card;
  }

  function renderStatus() {
    if (!statusLine) return;
    const count = state.entries.length;
    const selectedCount = state.selected.size;
    const suffix = selectedCount > 0 ? ` · 已选 ${selectedCount} 项` : "";
    statusLine.textContent = `${state.kind === "remote" ? "远程" : "本地"} · ${count} 项${suffix}`;
  }

  /**
   * 把 `state.selected` 刷到 DOM（条目 `data-selected` + 工具栏 + 状态栏）。
   *
   * 只遍历**当前渲染窗口**的条目（虚拟滚动下 DOM 里只有几十个），
   * 滚出窗口的条目重建时会从 `state.selected` 重新读，不需要额外同步。
   */
  function paintSelection() {
    if (grid) {
      for (const node of grid.querySelectorAll('[data-role="file-entry"]')) {
        const path = node.getAttribute("data-path");
        node.setAttribute("data-selected", state.selected.has(path) ? "true" : "false");
      }
    }
    renderToolbarSlots();
    renderStatus();
  }

  /** 清空选择（Escape / 点空白 / 取消按钮）。 */
  function clearSelection() {
    if (state.selected.size === 0 && state.anchorPath === null) return;
    state.selected.clear();
    state.anchorPath = null;
    paintSelection();
  }

  /** Ctrl+A：全选当前目录下所有条目（不只是 DOM 里的窗口）。 */
  function selectAll() {
    if (state.entries.length === 0) return;
    state.selected = new Set(state.entries.map((entry) => entry.path));
    if (state.anchorPath === null) state.anchorPath = state.entries[0].path;
    paintSelection();
  }

  /* ------------------ 面板级动作菜单（TASK-FIX-UI-REST §6.3） ------------------
   *
   * 菜单挂在 `.file-panel` 根上（不在 card、不在 grid）：
   * - 不会被 grid 的 `overflow-y:auto` 裁掉；
   * - 虚拟滚动重渲染只动 card，菜单不会随之丢失（但重渲染/滚动本身会关掉它，
   *   避免留一个指向已卸载行的悬空菜单）。
   * 定位用纯函数 clampMenuPosition（按条目数算高度，不先测量再摆，免闪）。
   */

  /** 当前菜单指向的条目（null = 没开）。 */
  let openMenuEntry = null;
  /** 当前开菜单的那个 ⋯ 按钮（Esc 后要把焦点还回去）。 */
  let openMenuButton = null;

  function ensureActionMenu() {
    if (actionMenu && actionMenu.parentNode === root) return actionMenu;
    actionMenu = el("div", {
      className: "file-panel-action-menu",
      "data-role": "file-action-menu",
      role: "menu",
      hidden: true,
    });
    if (root) root.appendChild(actionMenu);
    return actionMenu;
  }

  /** 关闭菜单；`restoreFocus` 为真时把焦点还给打开它的 ⋯。 */
  function closeActionMenu({ restoreFocus = false } = {}) {
    const button = openMenuButton;
    openMenuEntry = null;
    openMenuButton = null;
    if (actionMenu) {
      actionMenu.hidden = true;
      actionMenu.textContent = "";
      actionMenu.removeAttribute("data-open-path");
      actionMenu.removeAttribute("data-placement");
    }
    if (button) {
      button.setAttribute("aria-expanded", "false");
      if (restoreFocus && button.isConnected && typeof button.focus === "function") {
        button.focus({ preventScroll: true });
      }
    }
  }

  /** 按当前面板/按钮位置把菜单摆好（视口坐标 → 面板内绝对坐标）。 */
  function positionActionMenu(button) {
    if (!actionMenu || !root) return;
    const items = actionMenu.querySelectorAll('[data-role="file-action-item"]').length;
    const size = menuSizeFor(items);
    const panelRect = root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    // 垂直按「整张卡片」对齐：菜单落在卡片下方/上方，绝不遮住这一行自己的
    // 文件名与图标（TASK §2 目标 2「不遮文件名、不遮图标」）。
    const card = button.closest('[data-role="file-entry"]');
    const cardRect = card ? card.getBoundingClientRect() : buttonRect;
    const placed = clampMenuPosition({
      btn: buttonRect,
      anchor: cardRect,
      menu: { width: size.width, height: size.height },
      panel: panelRect,
    });
    // 绝对定位的包含块是面板的「padding box」；面板顶边有 1px 边框，
    // 要减掉 border 宽，菜单才能精准落在算好的视口坐标上（否则整体偏 1px）。
    const offsetX = panelRect.left + (root.clientLeft || 0);
    const offsetY = panelRect.top + (root.clientTop || 0);
    actionMenu.style.left = `${Math.round(placed.left - offsetX)}px`;
    actionMenu.style.top = `${Math.round(placed.top - offsetY)}px`;
    // placement 由定位函数给出（翻到上方时阴影也要反过来）。
    actionMenu.setAttribute("data-placement", placed.placement);
  }

  function menuItems() {
    if (!actionMenu) return [];
    return Array.from(actionMenu.querySelectorAll('[data-role="file-action-item"]'));
  }

  function focusMenuItem(index) {
    const items = menuItems();
    if (items.length === 0) return;
    const n = ((Number(index) || 0) + items.length) % items.length;
    items[n].focus({ preventScroll: true });
  }

  /** 打开菜单：构建条目 → 定位 → 显示 → 聚焦第一项。 */
  function openActionMenu(entry, button) {
    if (!root || !button || !button.isConnected) return;
    // 先收起旧的（不在新旧之间留残影），再在同一位置重建。
    closeActionMenu({ restoreFocus: false });
    ensureActionMenu();
    const actions = actionsForEntry(entry);
    actionMenu.textContent = "";
    for (const { label, action } of actions) {
      const item = el("button", {
        type: "button",
        className: "file-panel-menu-item",
        "data-role": "file-action-item",
        "data-action": action,
        role: "menuitem",
        tabindex: "-1",
        title: `${label}：${entry.name}`,
      }, label);
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        closeActionMenu({ restoreFocus: false });
        void runAction(action, entry);
      });
      actionMenu.appendChild(item);
    }
    actionMenu.setAttribute("data-open-path", entry.path);
    openMenuEntry = entry;
    openMenuButton = button;
    button.setAttribute("aria-expanded", "true");
    actionMenu.hidden = false;
    positionActionMenu(button);
    focusMenuItem(0);
  }

  /** 菜单内的键盘：↑/↓ 移动（循环）、Home/End、Esc 关闭并还焦点、Tab 关闭。 */
  function onMenuKeydown(event) {
    if (!actionMenu || actionMenu.hidden) return;
    const items = menuItems();
    const index = items.indexOf(document.activeElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusMenuItem(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusMenuItem(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusMenuItem(0);
        return;
      case "End":
        event.preventDefault();
        focusMenuItem(items.length - 1);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeActionMenu({ restoreFocus: true });
        return;
      case "Tab":
        // 菜单是浮层：Tab 不当成菜单内导航，直接关掉把焦点交回页面。
        closeActionMenu({ restoreFocus: false });
        return;
      default:
    }
  }

  /** 点菜单外任意处关闭（捕获阶段，先于 card 的 click）。 */
  function onDocumentPointerDown(event) {
    if (!actionMenu || actionMenu.hidden) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (actionMenu.contains(target)) return;
    // 点自己的 ⋯ 交给它的 click 处理（切换），这里不重复关。
    if (openMenuButton && openMenuButton.contains(target)) return;
    closeActionMenu({ restoreFocus: false });
  }

  /** 菜单外部的 Esc（焦点不在菜单里时也要能关）。 */
  function onDocumentKeydown(event) {
    if (event.key !== "Escape") return;
    // 模态开着时只关模态（不能顺手把选择也清了）。
    if (backdrop && !backdrop.hidden) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (!actionMenu || actionMenu.hidden) return;
    event.preventDefault();
    closeActionMenu({ restoreFocus: true });
  }

  /** 重渲染/滚动/切目录后：指向的条目还在 DOM 里就留着，否则关掉。 */
  function syncActionMenuToDom() {
    if (!actionMenu || actionMenu.hidden || !openMenuEntry) return;
    if (!openMenuButton || !openMenuButton.isConnected) {
      closeActionMenu({ restoreFocus: false });
    }
  }

  async function enterDirectory(pathValue) {
    state.manualPath = true;
    await load(pathValue);
    renderLocateButton();
  }

  /* ---------------------------- 操作 ---------------------------- */

  async function runAction(action, entry) {
    switch (action) {
      case "open":
        await enterDirectory(entry.path);
        return;
      case "view":
        await openViewer(entry);
        return;
      case "edit":
        await openEditor(entry);
        return;
      case "rename":
        await promptRename(entry);
        return;
      case "download":
        await downloadFile(entry);
        return;
      case "delete":
        await confirmDelete(entry);
        return;
      default:
        return;
    }
  }

  async function openViewer(entry) {
    const result = await api.fsRead(target(), entry.path);
    if (!result.ok) {
      onNotice(result.userText || "打不开这个文件。", "warn");
      showNoticeModal("查看失败", result.userText || `读取失败（${result.code}）`);
      return;
    }
    showTextModal({
      role: "file-viewer",
      title: entry.name,
      content: result.data && typeof result.data.content === "string" ? result.data.content : "",
      readOnly: true,
      path: entry.path,
    });
  }

  async function openEditor(entry) {
    const result = await api.fsRead(target(), entry.path);
    if (!result.ok) {
      onNotice(result.userText || "打不开这个文件。", "warn");
      showNoticeModal("编辑失败", result.userText || `读取失败（${result.code}）`);
      return;
    }
    showTextModal({
      role: "file-editor",
      title: entry.name,
      content: result.data && typeof result.data.content === "string" ? result.data.content : "",
      readOnly: false,
      path: entry.path,
    });
  }

  /* ---------------------------- 模态 ---------------------------- */

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    backdrop = el("div", { "data-role": "confirm-backdrop", hidden: true });
    const card = el("div", {
      "data-role": "confirm-card",
      role: "dialog",
      "aria-modal": "true",
    });
    modal = card;
    backdrop.appendChild(card);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function closeModal() {
    if (!backdrop) return;
    backdrop.hidden = true;
    modal.textContent = "";
    modal.removeAttribute("data-role");
    modal.setAttribute("data-role", "confirm-card");
  }

  function openModalShell() {
    ensureBackdrop();
    modal.textContent = "";
    modal.setAttribute("data-role", "confirm-card");
    backdrop.hidden = false;
    return modal;
  }

  function showNoticeModal(title, text) {
    const card = openModalShell();
    card.appendChild(el("h2", {}, title));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, text));
    const actions = el("div", { className: "file-panel-modal-actions" });
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "知道了");
    ok.addEventListener("click", () => closeModal());
    actions.appendChild(ok);
    card.appendChild(actions);
    ok.focus();
  }

  function showTextModal({ role, title, content, readOnly, path }) {
    // 外层保持 confirm-card（复用它的卡片壳 / 遮罩 / 层级），
    // 内层带契约要求的 data-role（file-viewer / file-editor）。
    const card = openModalShell();
    card.setAttribute("data-role", "confirm-card");
    card.setAttribute("data-tone", "neutral");
    const body = el("div", { "data-role": role, className: "file-panel-modal" });
    card.appendChild(body);
    const head = el("div", { className: "file-panel-modal-head" });
    head.appendChild(el("h2", {}, title));
    head.appendChild(el("span", { className: "file-panel-modal-path" }, path));
    body.appendChild(head);

    const editor = el("textarea", {
      className: "file-panel-textarea",
      spellcheck: "false",
      readonly: readOnly ? "readonly" : null,
      "data-role": readOnly ? "file-viewer-body" : "file-editor-body",
    });
    editor.value = content;
    body.appendChild(editor);

    const actions = el("div", { className: "file-panel-modal-actions" });
    const hint = el(
      "span",
      { className: "file-panel-modal-hint" },
      readOnly ? "只读预览 · Ctrl+A 全选可复制" : "Ctrl+S 保存 · Esc 关闭",
    );
    actions.appendChild(hint);

    const close = el("button", { type: "button", className: "file-panel-btn" }, "关闭");
    close.addEventListener("click", () => closeModal());
    actions.appendChild(close);

    if (!readOnly) {
      const save = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "保存");
      save.setAttribute("data-role", "file-editor-save");
      const doSave = async () => {
        save.disabled = true;
        const result = await api.fsWrite(target(), path, editor.value);
        save.disabled = false;
        if (!result.ok) {
          onNotice(result.userText || "保存失败。", "error");
          return;
        }
        onNotice("已保存。", "ok");
        closeModal();
        await load(state.path, { keepSelection: true });
      };
      save.addEventListener("click", () => void doSave());
      editor.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
          event.preventDefault();
          void doSave();
        }
      });
      actions.appendChild(save);
    }
    body.appendChild(actions);
    editor.focus();
  }

  async function promptRename(entry) {
    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "重命名"));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, entry.path));
    const input = el("input", { type: "text", className: "file-panel-input", "data-role": "file-rename-input" });
    input.value = entry.name;
    card.appendChild(input);
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "重命名");
    const submit = async () => {
      const name = input.value.trim();
      if (!name || name === entry.name) {
        closeModal();
        return;
      }
      const parent = entry.path.slice(0, entry.path.length - entry.name.length);
      const to = `${parent}${name}`;
      const result = await api.fsRename(target(), entry.path, to);
      if (!result.ok) {
        onNotice(result.userText || "重命名失败。", "error");
        return;
      }
      closeModal();
      onNotice(`已重命名为 ${name}`, "ok");
      await load(state.path);
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  async function confirmDelete(entry) {
    const card = openModalShell();
    card.appendChild(el("h2", {}, "确认删除"));
    // 目录要先知道里面有多少项，「N 项」才是真的。
    let count = 1;
    if (entry.type === "dir") {
      const listing = await api.fsList(target(), entry.path);
      if (listing.ok && listing.data && Array.isArray(listing.data.entries)) {
        count = listing.data.entries.length;
      }
    }
    const isRemote = state.kind === "remote";
    const message = el(
      "p",
      { className: "file-panel-modal-text" },
      isRemote
        ? `将从远程永久删除 ${entry.path}${entry.type === "dir" ? `（目录里现有 ${count} 项，远程只能删空目录）` : ""}`
        : `将永久删除 ${entry.path}${entry.type === "dir" ? `（${count} 项）` : ""}`,
    );
    card.appendChild(message);
    if (entry.type === "dir" && !isRemote) {
      const label = el("label", { className: "file-panel-check" });
      const box = el("input", { type: "checkbox", "data-role": "file-delete-recursive" });
      label.appendChild(box);
      label.appendChild(document.createTextNode(`连同目录里的 ${count} 项一起删除`));
      card.appendChild(label);
      card._recursiveBox = box;
    }
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-danger" }, "永久删除");
    ok.setAttribute("data-role", "file-delete-confirm");
    ok.addEventListener("click", async () => {
      const recursive = Boolean(card._recursiveBox && card._recursiveBox.checked);
      const result = await api.fsDelete(target(), entry.path, recursive);
      if (!result.ok) {
        onNotice(result.userText || "删除失败。", "error");
        closeModal();
        return;
      }
      closeModal();
      onNotice(`已删除 ${entry.name}`, "ok");
      await load(state.path, { keepSelection: true });
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    // 默认焦点在取消上（危险操作不能靠误回车触发）。
    cancel.focus();
  }

  /**
   * 下载一个文件。返回 `{ok, mode?, size?}` / `{ok:false, code, userText}`，
   * 供单个下载与批量下载共用（批量需要知道哪一条失败、失败原因）。
   *
   * TASK-FIX17-L1 R4：先问服务端能不能直接存进「下载目录」；
   * `NO_DOWNLOAD_DIR` 时**逐字保留**原来的 `<a download>` 行为（AC5 探针就断言这个）。
   */
  async function downloadFile(entry, opts = {}) {
    const saved = await saveToDownloadDir(entry, opts);
    if (saved) return saved;
    return legacyDownload(entry, opts);
  }

  /**
   * 尝试由服务端落盘。
   *
   * @returns {Promise<object|null>} null = 「本机没设下载目录 / 服务端太旧」→ 调用方回落旧下载
   */
  async function saveToDownloadDir(entry, opts = {}) {
    if (!api || typeof api.fsSave !== "function") return null;
    const result = await api.fsSave(target(), entry.path);
    if (result.ok) {
      const data = result.data || {};
      if (data.ok === true && typeof data.savedPath === "string" && data.savedPath.length > 0) {
        if (!opts.quiet) {
          onNotice(`已保存到 ${data.savedPath}`, "ok");
          showSavedHint(data.savedPath);
        }
        return {
          ok: true,
          mode: "saved",
          savedPath: data.savedPath,
          name: typeof data.name === "string" && data.name.length > 0 ? data.name : entry.name,
          size: Number.isFinite(data.bytes) ? data.bytes : undefined,
        };
      }
      if (data.code === "NO_DOWNLOAD_DIR") return null;
      const userText = data.userText || "保存失败。";
      if (!opts.quiet) onNotice(userText, "error");
      return { ok: false, code: data.code || "SAVE_FAILED", userText };
    }
    // 没设目录 / 服务端还没这个接口 / 网络断：都交给旧路径再试一次，
    // 绝不能让「升级前的服务端」把下载变成完全不可用。
    if (result.code === "NO_DOWNLOAD_DIR" || result.code === "NOT_FOUND" || result.code === "NETWORK") {
      return null;
    }
    const userText = result.userText || "保存失败。";
    if (!opts.quiet) onNotice(userText, "error");
    return { ok: false, code: result.code, userText };
  }

  /** 旧行为：fetch → blob → `<a download>`（TASK-FIX17-L1 之前就是这个）。 */
  async function legacyDownload(entry, opts = {}) {
    const url = api.fsDownloadUrl(target(), entry.path);
    try {
      const headers = api.fsAuthHeader();
      const response = await fetch(url, { headers, credentials: "omit" });
      if (!response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const userText = (body && body.userText) || `下载失败（HTTP ${response.status}）。`;
        if (!opts.quiet) onNotice(userText, "error");
        return { ok: false, code: (body && body.code) || `HTTP_${response.status}`, userText };
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      if (!opts.quiet) onNotice(`已下载 ${entry.name}（${formatSize(blob.size)}）`, "ok");
      return { ok: true, mode: "browser", size: blob.size };
    } catch (err) {
      const userText = `下载失败：${err && err.message ? err.message : "网络错误"}`;
      if (!opts.quiet) onNotice(userText, "error");
      return { ok: false, code: "NETWORK", userText };
    }
  }

  /** 取路径里的目录部分（Windows / POSIX 分隔符都算）。 */
  function dirOfEditorial(targetPath) {
    const text = String(targetPath || "");
    const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    return index > 0 ? text.slice(0, index) : "";
  }

  /** 面板底部那行「已保存到 … / 打开所在文件夹」（TASK-FIX17-L1 R4）。 */
  function showSavedHint(savedPath) {
    lastSavedPath = savedPath;
    if (!savedHint) return;
    savedHint.hidden = false;
    if (savedHintPath) savedHintPath.textContent = `已保存到 ${savedPath}`;
  }

  /** 调 `/api/fs/reveal`；失败只提示，不影响文件已经落盘这件事。 */
  async function revealSaved() {
    const targetPath = lastSavedPath;
    if (!targetPath) return;
    if (!api || typeof api.revealPath !== "function") {
      onNotice("这个版本的本地服务不支持打开文件夹。", "warn");
      return;
    }
    const result = await api.revealPath(targetPath);
    if (!result.ok) {
      onNotice(result.userText || "打不开文件夹。", "warn");
      return;
    }
    onNotice(`已打开所在文件夹：${dirOfEditorial(targetPath)}`, "ok");
  }

  /* ------------------ 多选与批量操作（TASK-FIX17-C R2） ------------------ */

  /** 选中的条目（按列表顺序，只含当前目录里真的存在的）。 */
  function selectedEntries() {
    return state.entries.filter((entry) => state.selected.has(entry.path));
  }

  /** 批量操作前后统一的「忙」开关：防重复提交。 */
  function setBatchBusy(value) {
    state.batchBusy = Boolean(value);
    renderBatchBar();
  }

  /**
   * 批量删除：二次确认（含「将删除 N 项，不可撤销」）→ 逐项 DELETE。
   *
   * 远程分支不允许递归（服务端 400），所以远程只删空目录；本地目录一律
   * `recursive=true`（用户的意图就是「连同内容一起删」，而确认卡已经写明项数）。
   */
  async function batchDelete() {
    if (state.batchBusy) return;
    const items = selectedEntries();
    if (items.length === 0) return;
    const isRemote = state.kind === "remote";
    const dirCount = items.filter((entry) => entry.type === "dir").length;

    const card = openModalShell();
    card.appendChild(el("h2", {}, "确认批量删除"));
    card.appendChild(
      el(
        "p",
        { className: "file-panel-modal-text", "data-role": "files-batch-delete-text" },
        `将删除 ${items.length} 项${dirCount > 0 ? `（含 ${dirCount} 个目录及其内容）` : ""}，不可撤销。`,
      ),
    );
    const list = el("ul", { className: "file-panel-batch-list", "data-role": "files-batch-delete-list" });
    for (const entry of items.slice(0, 8)) list.appendChild(el("li", {}, entry.path));
    if (items.length > 8) list.appendChild(el("li", { className: "file-panel-batch-more" }, `…另外 ${items.length - 8} 项`));
    card.appendChild(list);

    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-danger" }, "永久删除");
    ok.setAttribute("data-role", "files-batch-delete-confirm");
    cancel.addEventListener("click", () => closeModal());
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      cancel.disabled = true;
      closeModal();
      setBatchBusy(true);
      const failed = [];
      let deleted = 0;
      for (const entry of items) {
        const recursive = entry.type === "dir" && !isRemote;
        const result = await api.fsDelete(target(), entry.path, recursive);
        if (result.ok) deleted += 1;
        else failed.push({ path: entry.path, name: entry.name, userText: result.userText || `删除失败（${result.code}）` });
      }
      // 成功的那几条从选择里剔掉；失败的留着让用户看清是哪些。
      const failedPaths = new Set(failed.map((row) => row.path));
      state.selected = pruneSelection(state.selected, failedPaths);
      if (state.selected.size === 0) state.anchorPath = null;
      setBatchBusy(false);
      await load(state.path, { keepSelection: true });
      if (failed.length === 0) {
        onNotice(`已删除 ${deleted} 项`, "ok");
      } else {
        onNotice(`已删除 ${deleted} 项，${failed.length} 项失败：${failed[0].userText}`, "error");
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    // 危险操作：默认焦点在取消上。
    cancel.focus();
  }

  /**
   * 批量移动：填目标目录 → 逐批 `POST /api/fs/move` → 汇总 `failed`。
   *
   * 不覆盖任何已有文件（不传 `overwrite`）：撞名的那条进 `failed`，源文件原地不动。
   */
  async function batchMove() {
    if (state.batchBusy) return;
    const items = selectedEntries();
    if (items.length === 0) return;
    const isRemote = state.kind === "remote";

    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "批量移动到"));
    card.appendChild(
      el(
        "p",
        { className: "file-panel-modal-text" },
        isRemote
          ? `将移动 ${items.length} 项（远程主机暂不支持批量移动）。`
          : `将移动 ${items.length} 项到这里（目标目录已存在同名项时不覆盖，该条会报告失败）。`,
      ),
    );
    const input = el("input", {
      type: "text",
      className: "file-panel-input",
      "data-role": "files-batch-move-input",
      spellcheck: "false",
      placeholder: "目标目录（绝对路径）",
    });
    input.value = state.path || "";
    card.appendChild(input);

    const quick = el(
      "div",
      { className: "file-panel-batch-quick" },
    );
    const currentButton = el(
      "button",
      { type: "button", className: "file-panel-btn file-panel-btn-quiet", "data-role": "files-batch-move-current" },
      "用当前目录",
    );
    currentButton.addEventListener("click", () => {
      input.value = state.path || "";
      input.focus();
    });
    quick.appendChild(currentButton);
    const termButton = el(
      "button",
      { type: "button", className: "file-panel-btn file-panel-btn-quiet", "data-role": "files-batch-move-term" },
      "用终端目录",
    );
    const cwd = typeof state.termCwd === "string" ? state.termCwd : "";
    termButton.disabled = cwd.length === 0;
    termButton.title = cwd.length === 0 ? "终端还没上报目录" : `终端目录：${cwd}`;
    termButton.addEventListener("click", () => {
      if (cwd.length === 0) return;
      input.value = cwd;
      input.focus();
    });
    quick.appendChild(termButton);
    card.appendChild(quick);

    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "移动");
    ok.setAttribute("data-role", "files-batch-move-confirm");
    cancel.addEventListener("click", () => closeModal());
    const submit = async () => {
      const dir = input.value.trim();
      if (!dir) {
        onNotice("先填目标目录。", "warn");
        return;
      }
      const plan = movePlan(items.map((entry) => entry.path), dir);
      if (plan.length === 0) {
        closeModal();
        onNotice("目标目录与当前目录相同，没有可移动的项。", "warn");
        return;
      }
      closeModal();
      setBatchBusy(true);
      const moved = [];
      const failed = [];
      for (const chunk of chunkMoves(plan)) {
        const result = await api.fsMove(target(), chunk);
        if (!result.ok) {
          // 整批失败（网络 / 400）：每一项都记上同一个原因，不让它们静默消失。
          for (const item of chunk) {
            failed.push({ from: item.from, to: item.to, userText: result.userText || `移动失败（${result.code}）` });
          }
          continue;
        }
        const data = result.data || {};
        if (Array.isArray(data.moved)) moved.push(...data.moved);
        if (Array.isArray(data.failed)) {
          for (const row of data.failed) {
            failed.push({
              from: row.from,
              to: row.to,
              code: row.code,
              userText: row.userText || "移动失败。",
            });
          }
        }
      }
      // 成功的那几条从选择里剔掉；失败的留着让用户重试。
      const failedFrom = new Set(failed.map((row) => row.from));
      state.selected = new Set([...state.selected].filter((path) => failedFrom.has(path)));
      if (state.selected.size === 0) state.anchorPath = null;
      setBatchBusy(false);
      await load(state.path, { keepSelection: true });
      if (failed.length === 0) {
        onNotice(`已移动 ${moved.length} 项到 ${dir}`, "ok");
      } else {
        onNotice(`已移动 ${moved.length} 项，${failed.length} 项失败：${failed[0].userText}`, "error");
      }
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  /**
   * 批量下载：逐项 `downloadFile`。
   *
   * 两种落盘方式共存（TASK-FIX17-L1 R4）：
   *   - 设了下载目录 → 全部存进该目录，结束时汇总「已保存 N 个文件到 <目录>」；
   *   - 没设目录 → 整体回落旧行为（浏览器逐个弹下载）。
   *
   * 两条已知限制（写在这里，免得下次当成 bug 去修）：
   *   1. 浏览器可能拦多次下载（站点的「允许自动下载多个文件」），那是浏览器行为；
   *   2. 目录不能下载（服务端 `IS_A_DIRECTORY`）—— 跳过并计数，不报错。
   */
  async function batchDownload() {
    if (state.batchBusy) return;
    const items = selectedEntries();
    if (items.length === 0) return;
    const files = items.filter((entry) => entry.type !== "dir");
    const skipped = items.length - files.length;
    if (files.length === 0) {
      onNotice("选中的都是目录，目录不支持下载。", "warn");
      return;
    }
    setBatchBusy(true);
    const failed = [];
    const savedPaths = [];
    let browserCount = 0;
    for (const entry of files) {
      const result = await downloadFile(entry, { quiet: true });
      if (!result.ok) {
        failed.push({ name: entry.name, userText: result.userText });
      } else if (result.mode === "saved" && typeof result.savedPath === "string") {
        savedPaths.push(result.savedPath);
      } else {
        browserCount += 1;
      }
    }
    setBatchBusy(false);
    const parts = [];
    if (savedPaths.length > 0) {
      // AC6：汇总文案里必须带目录，用户不用去猜文件去哪了。
      parts.push(`已保存 ${savedPaths.length} 个文件到 ${dirOfEditorial(savedPaths[0])}`);
      showSavedHint(savedPaths[0]);
    }
    if (browserCount > 0) parts.push(`已开始下载 ${browserCount} 个文件`);
    if (skipped > 0) parts.push(`${skipped} 个目录不支持下载`);
    if (failed.length > 0) parts.push(`${failed.length} 个失败：${failed[0].userText}`);
    onNotice(parts.join(" · "), failed.length > 0 ? "warn" : "ok");
  }

  /* ---------------------------- 上传 ---------------------------- */

  function renderUploads() {
    if (!uploadHost) return;
    uploadHost.textContent = "";
    if (state.uploads.length === 0) {
      uploadHost.hidden = true;
      return;
    }
    uploadHost.hidden = false;
    for (const item of state.uploads) {
      const row = el("div", { className: "file-panel-upload", "data-role": "file-upload-row", "data-state": item.state });
      const name = el("span", { className: "file-panel-upload-name" }, item.name);
      row.appendChild(name);
      const bar = el("span", { className: "file-panel-upload-bar" });
      const fill = el("i");
      fill.style.width = `${Math.round(item.percent * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      const pct = el(
        "span",
        { className: "file-panel-upload-pct" },
        item.state === "done" ? "已写入" : item.state === "error" ? "失败" : `${Math.round(item.percent * 100)}%`,
      );
      row.appendChild(pct);
      uploadHost.appendChild(row);
    }
  }

  function uploadFiles(files) {
    if (!files || files.length === 0) return;
    const dir = state.path;
    if (!dir) {
      onNotice("先选一个目录再上传。", "warn");
      return;
    }
    for (const file of files) {
      void uploadOne(file, dir);
    }
  }

  function uploadOne(file, dir) {
    const item = { name: file.name, percent: 0, state: "uploading" };
    state.uploads.push(item);
    renderUploads();
    const { url, token } = api.fsUploadEndpoint(target(), dir);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("x-magpie-term-token", token);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        item.percent = Math.min(0.99, event.loaded / event.total);
        renderUploads();
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        item.percent = 1;
        item.state = "done";
        renderUploads();
        onNotice(`已上传 ${file.name}`, "ok");
        void load(state.path, { keepSelection: true });
        setTimeout(() => {
          state.uploads = state.uploads.filter((row) => row !== item);
          renderUploads();
        }, 4000);
        return;
      }
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      item.state = "error";
      renderUploads();
      onNotice((body && body.userText) || `上传失败（HTTP ${xhr.status}）。`, "error");
    });
    xhr.addEventListener("error", () => {
      item.state = "error";
      renderUploads();
      onNotice(`上传失败：连不上本地服务。`, "error");
    });
    xhr.send(file);
  }

  /* ---------------------------- 工具栏动作 ---------------------------- */

  async function newDirectory() {
    if (!state.path) return;
    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "新建文件夹"));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, state.path));
    const input = el("input", { type: "text", className: "file-panel-input", "data-role": "file-newdir-input" });
    input.value = "新建文件夹";
    card.appendChild(input);
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "创建");
    const submit = async () => {
      const name = input.value.trim();
      if (!name) {
        closeModal();
        return;
      }
      const result = await api.fsMkdir(target(), joinPath(state.path, name));
      if (!result.ok) {
        onNotice(result.userText || "新建文件夹失败。", "error");
        return;
      }
      closeModal();
      onNotice(`已创建文件夹 ${name}`, "ok");
      await load(state.path);
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  async function newFile() {
    if (!state.path) return;
    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "新建文件"));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, state.path));
    const input = el("input", { type: "text", className: "file-panel-input", "data-role": "file-newfile-input" });
    input.value = "新建文件.txt";
    card.appendChild(input);
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "创建");
    const submit = async () => {
      const name = input.value.trim();
      if (!name) {
        closeModal();
        return;
      }
      const result = await api.fsNewFile(target(), joinPath(state.path, name));
      if (!result.ok) {
        onNotice(result.userText || "新建文件失败。", "error");
        return;
      }
      closeModal();
      onNotice(`已创建 ${name}`, "ok");
      await load(state.path);
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  /* ---------------------------- 骨架 ---------------------------- */

  function build() {
    root = host;
    root.textContent = "";
    root.className = "file-panel";
    root.setAttribute("data-role", "file-panel");

    // 拖拽把手（常显；分界线与内投影在 CSS 上由 .file-panel 提供）。
    const grip = el("div", {
      className: "file-panel-grip",
      "data-role": "file-panel-grow",
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-valuemin": String(MIN_HEIGHT),
      "aria-valuemax": String(MAX_HEIGHT),
      title: "拖动调整文件面板高度（150–520px）",
    });
    root.appendChild(grip);

    toolbar = el("div", { className: "file-panel-toolbar" });

    const up = el("button", {
      type: "button",
      className: "file-panel-icon-btn",
      title: "上一级",
      "data-role": "file-panel-up",
    }, "↑");
    up.addEventListener("click", () => {
      if (!state.parent) return;
      void enterDirectory(state.parent);
    });
    toolbar.appendChild(up);

    // TASK-FIX17-C R1：定位按钮——**常显**（之前那个只在手动改过路径后
    // 才冒出来的文字按钮，用户基本看不到）。图标是内联 SVG（沙箱禁 CDN），
    // 三态由 renderLocateButton() 写 data-state / title。
    locateButton = el("button", {
      type: "button",
      className: "file-panel-icon-btn file-panel-locate",
      "data-role": "files-locate",
      title: "定位到终端所在目录",
      "aria-label": "定位到终端所在目录",
      "data-state": LOCATE_STATE.NO_TERMINAL,
    });
    locateButton.appendChild(iconSvg("locate", 14));
    locateButton.addEventListener("click", () => void locateToTerminalCwd());
    toolbar.appendChild(locateButton);

    const title = el("span", { className: "file-panel-title" }, "文件");
    toolbar.appendChild(title);

    // R2 / AC4：路径输入框与批量操作条共用同一个槽位（同高，切换不跳版）。
    pathSlot = el("div", { className: "file-panel-slot", "data-role": "file-panel-slot", "data-mode": "path" });

    pathInput = el("input", {
      type: "text",
      className: "file-panel-path",
      "data-role": "file-panel-path",
      "aria-label": "当前路径",
      spellcheck: "false",
    });
    pathInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const value = pathInput.value.trim();
      if (!value) return;
      state.manualPath = true;
      void load(value).then(renderLocateButton);
    });
    pathInput.addEventListener("blur", () => {
      // 编辑后没回车就失焦：回填真实路径，不偷偷跳目录。
      if (pathInput.value !== (state.path || "")) pathInput.value = state.path || "";
    });
    pathSlot.appendChild(pathInput);

    // 批量操作条（默认 hidden）：计数 + 移动 / 删除 / 下载 + 取消。
    batchBar = el("div", {
      className: "file-panel-batch",
      "data-role": "files-batch-bar",
      hidden: true,
    });
    const batchCount = el(
      "span",
      { className: "file-panel-batch-count", "data-role": "files-batch-count" },
      "已选 0 项",
    );
    batchBar.appendChild(batchCount);

    const batchButtons = [
      { role: "files-batch-move", icon: "move", title: "批量移动到…", handler: batchMove },
      { role: "files-batch-delete", icon: "trash", title: "批量删除…", handler: batchDelete, tone: "danger" },
      { role: "files-batch-download", icon: "download", title: "批量下载（逐个下载文件）", handler: batchDownload },
    ];
    for (const item of batchButtons) {
      const button = el("button", {
        type: "button",
        className: "file-panel-icon-btn file-panel-batch-btn",
        "data-role": item.role,
        title: item.title,
        "aria-label": item.title,
      });
      if (item.tone) button.setAttribute("data-tone", item.tone);
      button.appendChild(iconSvg(item.icon, 14));
      button.addEventListener("click", () => void item.handler());
      batchBar.appendChild(button);
    }

    const batchCancel = el("button", {
      type: "button",
      className: "file-panel-icon-btn file-panel-batch-cancel",
      "data-role": "files-batch-cancel",
      title: "取消选择（Esc）",
      "aria-label": "取消选择",
    });
    batchCancel.appendChild(iconSvg("cancel", 14));
    batchCancel.addEventListener("click", () => {
      clearSelection();
      if (grid && typeof grid.focus === "function") grid.focus({ preventScroll: true });
    });
    batchBar.appendChild(batchCancel);

    pathSlot.appendChild(batchBar);
    toolbar.appendChild(pathSlot);

    const tools = el("div", { className: "file-panel-tools" });

    const refresh = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-refresh",
      title: "刷新（F5）",
    }, "刷新");
    refresh.addEventListener("click", () => void load(state.path));
    tools.appendChild(refresh);

    const newdir = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-newdir",
      title: "新建文件夹",
    }, "新建文件夹");
    newdir.addEventListener("click", () => void newDirectory());
    tools.appendChild(newdir);

    const newfile = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-newfile",
      title: "新建文件",
    }, "新建文件");
    newfile.addEventListener("click", () => void newFile());
    tools.appendChild(newfile);

    const upload = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-accent",
      "data-role": "file-panel-upload",
      title: "上传文件（支持多选）",
    }, "上传");
    tools.appendChild(upload);

    // 文件选择框（必须有：拖拽只是锦上添花）。
    const picker = el("input", {
      type: "file",
      multiple: "multiple",
      "data-role": "file-panel-picker",
      className: "file-panel-picker",
      tabindex: "-1",
    });
    picker.addEventListener("change", () => {
      uploadFiles(picker.files);
      picker.value = "";
    });
    tools.appendChild(picker);
    upload.addEventListener("click", () => picker.click());

    const close = el("button", {
      type: "button",
      className: "file-panel-icon-btn",
      "data-role": "file-panel-close",
      title: "关闭文件面板",
      "aria-label": "关闭文件面板",
    }, "✕");
    close.addEventListener("click", () => setOpen(false));
    tools.appendChild(close);

    toolbar.appendChild(tools);
    root.appendChild(toolbar);

    uploadHost = el("div", { className: "file-panel-uploads", "data-role": "file-panel-uploads", hidden: true });
    root.appendChild(uploadHost);

    grid = el("div", { className: "file-panel-grid", "data-role": "file-panel-grid", tabindex: "-1" });
    // 网格自己就是滚动容器：滚动只换窗口里的条目，不重建整张列表。
    grid.addEventListener("scroll", onGridScroll, { passive: true });
    // R2：Ctrl+A 全选 / Escape 清空 / 点空白清空。
    grid.addEventListener("keydown", onGridKeydown);
    grid.addEventListener("pointerdown", onGridPointerDown);
    // 列数（宽度）或可视高度变了要重算每行条目数。
    if (typeof ResizeObserver === "function") {
      gridObserver = new ResizeObserver(() => schedulePaint());
      gridObserver.observe(grid);
    }
    // 老 WebView2 没有 ResizeObserver 时的兜底：窗口尺寸变化也算一次。
    window.addEventListener("resize", onGridResize);
    root.appendChild(grid);

    statusLine = el("div", { className: "file-panel-status", "data-role": "file-panel-status" });
    root.appendChild(statusLine);

    // TASK-FIX17-L1 R4：下载到目录后在这里回显完整路径 + 「打开所在文件夹」。
    // 放在状态行下面而不是状态行里：状态栏（`status-bar.js`）不在本卡白名单内，
    // 而且它是全局面包屑，塞一个只在文件面板有意义的按钮会串味。
    savedHint = el("div", {
      className: "file-panel-saved-hint",
      "data-role": "files-saved-hint",
      hidden: true,
    });
    savedHintPath = el("span", { className: "file-panel-saved-path", "data-role": "files-saved-path" });
    savedReveal = el(
      "button",
      { type: "button", className: "file-panel-saved-reveal", "data-role": "files-reveal" },
      "打开所在文件夹",
    );
    savedReveal.addEventListener("click", () => void revealSaved());
    savedHint.append(savedHintPath, savedReveal);
    root.appendChild(savedHint);

    // TASK-FIX-UI-REST §6.3：动作菜单（面板级浮层，挂在 .file-panel 根上）。
    ensureActionMenu();
    actionMenu.addEventListener("keydown", onMenuKeydown);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeydown, true);

    // 拖拽调高。
    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    const onMove = (event) => {
      if (!dragging) return;
      const delta = startY - event.clientY;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(startHeight + delta)));
      if (next !== state.height) applyHeight(next);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      root.removeAttribute("data-drag");
      storeHeight(state.height);
      window.dispatchEvent(new CustomEvent("magpie:file-panel-resize"));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      startY = event.clientY;
      startHeight = state.height;
      root.setAttribute("data-drag", "true");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    grip.addEventListener("dblclick", () => {
      // 双击把手：在默认高与最大值之间切换（设计稿的「双击折叠」在此不适用，
      // 折叠改由 rail 开关负责 —— 见 REPORT 的待人类决策）。
      const next = state.height >= MAX_HEIGHT - 4 ? DEFAULT_HEIGHT : MAX_HEIGHT;
      applyHeight(next);
      storeHeight(next);
      window.dispatchEvent(new CustomEvent("magpie:file-panel-resize"));
    });

    // 拖放上传。
    root.addEventListener("dragover", (event) => {
      event.preventDefault();
      root.setAttribute("data-drop", "true");
    });
    root.addEventListener("dragleave", () => root.removeAttribute("data-drop"));
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      root.removeAttribute("data-drop");
      if (event.dataTransfer && event.dataTransfer.files) uploadFiles(event.dataTransfer.files);
    });
  }

  /* ---------------------------- 会话绑定 ---------------------------- */

  function bindSession(session) {
    if (!session) {
      state.sessionId = null;
      state.kind = "local";
      state.hostId = null;
      state.termCwd = null;
      state.manualPath = false;
      // 没有终端 = 没有列表：条目与选择必须一起清，否则工具栏会留
      // 「已选 N 项」，而网格已经在说「当前没有终端标签」——两句自相矛盾。
      state.path = null;
      state.parent = null;
      state.entries = [];
      state.selected = new Set();
      state.anchorPath = null;
      return false;
    }
    const changed =
      session.id !== state.sessionId ||
      session.kind !== state.kind ||
      (session.hostId || null) !== state.hostId;
    state.sessionId = session.id;
    state.kind = session.kind === "remote" ? "remote" : "local";
    state.hostId = session.kind === "remote" ? session.hostId || null : null;
    state.termCwd = typeof session.cwd === "string" && session.cwd.length > 0 ? session.cwd : state.termCwd;
    if (changed) {
      // 换会话 = 重新跟随（用户上次的手动路径属于上一个会话）。
      state.manualPath = false;
      state.path = null;
      state.entries = [];
      state.selected = new Set();
      state.anchorPath = null;
    }
    return changed;
  }

  async function syncToSession(session, { force = false } = {}) {
    const changed = bindSession(session);
    if (!state.open) return;
    if (!session) {
      // 终端没了：定位按钮必须立刻转成 no-terminal 禁用态（不能停在上一个会话的
      // 「away」，否则用户点一下无事发生，也不知道为什么）。
      renderLocateButton();
      renderToolbarSlots();
      renderGridMessage("当前没有终端标签：先开一个标签，文件面板会跟着它的目录走。");
      renderStatus();
      return;
    }
    if (changed || force) {
      const start = state.termCwd || (state.kind === "remote" ? "." : null);
      if (start) await load(start);
      else renderGridMessage("这个终端还没报告目录，等它出现第一个提示符。");
      renderLocateButton();
    }
  }

  /* ---------------------------- 对外接口 ---------------------------- */

  /** 打开 / 收起。收放都不改终端列数（只改高度，fit 由 terminal-view 自己做）。 */
  function setOpen(value) {
    state.open = Boolean(value);
    storeOpen(state.open);
    applyOpen();
    if (state.open) {
      const snapshot = store.getSnapshot();
      const active = snapshot.sessions.find((s) => s.id === snapshot.activeId) || null;
      void syncToSession(active, { force: true });
    }
  }

  return {
    init() {
      build();
      state.height = readStoredHeight();
      applyHeight(state.height);
      state.open = readStoredOpen();
      applyOpen();
      render();

      const railButton = document.querySelector('[data-role="rail-files"]');
      if (railButton) {
        railButton.addEventListener("click", () => setOpen(!state.open));
        railButton.setAttribute("aria-pressed", state.open ? "true" : "false");
      }

      // 会话切换 / cwd 变化都从 store 快照推；不新增上行帧。
      unsubscribe = store.subscribe((snapshot) => {
        const active = snapshot.sessions.find((s) => s.id === snapshot.activeId) || null;
        if (!active) {
          if (lastActiveId !== null) {
            lastActiveId = null;
            void syncToSession(null);
          }
          return;
        }
        if (active.id !== lastActiveId) {
          lastActiveId = active.id;
          void syncToSession(active);
          return;
        }
        // 同一个会话：cwd 变了就走跟随逻辑。
        if (active.cwd && active.cwd !== state.termCwd) {
          state.termCwd = active.cwd;
          void followTerminalCwd(active.cwd);
        }
      });
    },

    /** 打开 / 收起。 */
    setOpen,    toggle() {
      setOpen(!state.open);
    },
    /** WS 帧 session.cwd 的入口（app.js 调）。 */
    onSessionCwd(id, cwd) {
      if (!state.open) {
        // 面板收着也记下来，重新打开时直接跳到最新目录。
        if (id === state.sessionId) state.termCwd = cwd;
        return;
      }
      if (id !== state.sessionId) return;
      void followTerminalCwd(cwd);
    },
    /** 暴露给验收探针 / 提交用。 */
    get state() {
      return {
        open: state.open,
        height: state.height,
        path: state.path,
        kind: state.kind,
        hostId: state.hostId,
        entries: state.entries.slice(),
        manualPath: state.manualPath,
        termCwd: state.termCwd,
        // R2：多选快照（探针要断言「已选 N 项」与具体路径）。
        selected: [...state.selected],
        selectedCount: state.selected.size,
        anchorPath: state.anchorPath,
        batchBusy: state.batchBusy,
        // R1：定位按钮的三态（直接调同一个纯函数，不重复实现一份）。
        locate: locateButtonState({
          termCwd: state.termCwd,
          path: state.path,
          hasSession: Boolean(state.sessionId),
        }),
      };
    },
    /** 清空选择（探针 / 外部入口用）。 */
    clearSelection,
    refresh() {
      if (state.open) void load(state.path);
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (gridObserver) gridObserver.disconnect();
      gridObserver = null;
      window.removeEventListener("resize", onGridResize);
      if (grid) {
        grid.removeEventListener("keydown", onGridKeydown);
        grid.removeEventListener("pointerdown", onGridPointerDown);
      }
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeydown, true);
      closeActionMenu({ restoreFocus: false });
      actionMenu = null;
    },
  };
}
