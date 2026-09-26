export type ShortcutActionId =
  | 'search'
  | 'tab-overview'
  | 'tab-api'
  | 'tab-accessibility'
  | 'tab-examples'
  | 'tab-history'
  | 'new-component'
  | 'save-version';

export type ShortcutMap = Record<ShortcutActionId, string>;

export interface ShortcutActionMeta {
  id: ShortcutActionId;
  label: string;
}

export const SHORTCUT_ACTIONS: ShortcutActionMeta[] = [
  { id: 'search', label: '聚焦搜索' },
  { id: 'tab-overview', label: '编辑区：概述' },
  { id: 'tab-api', label: '编辑区：属性与状态' },
  { id: 'tab-accessibility', label: '编辑区：无障碍' },
  { id: 'tab-examples', label: '编辑区：关联示例' },
  { id: 'tab-history', label: '编辑区：版本与迁移' },
  { id: 'new-component', label: '新建组件' },
  { id: 'save-version', label: '保存版本' }
];

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  search: 'mod+k',
  'tab-overview': 'alt+1',
  'tab-api': 'alt+2',
  'tab-accessibility': 'alt+3',
  'tab-examples': 'alt+4',
  'tab-history': 'alt+5',
  'new-component': 'alt+n',
  'save-version': 'mod+s'
};

// 组合键统一写成 "mod+shift+k" 形式：mod 表示 macOS 的 ⌘ 或其他平台的 Ctrl。
const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta']);
const IGNORED_KEYS = new Set(['dead', 'unidentified', 'process']);

export function comboFromEvent(event: KeyboardEvent): string | null {
  const raw = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(raw) || IGNORED_KEYS.has(raw)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(raw === ' ' || raw === 'spacebar' ? 'space' : raw);
  return parts.join('+');
}

// 撤销/重做是内置固定键位，不开放配置，但占用组合空间。
const FIXED_SHORTCUTS: Record<string, string> = {
  'mod+z': '撤销',
  'mod+shift+z': '重做'
};

// 浏览器保留组合：页面收不到或无法 preventDefault，绑了也不会生效。
const BROWSER_RESERVED: Record<string, string> = {
  'mod+t': '新建标签页',
  'mod+shift+t': '恢复关闭的标签页',
  'mod+n': '新建窗口',
  'mod+shift+n': '新建无痕窗口',
  'mod+w': '关闭标签页',
  'mod+shift+w': '关闭窗口',
  'mod+q': '退出浏览器',
  'mod+m': '最小化窗口',
  'mod+1': '切换到第 1 个标签页',
  'mod+2': '切换到第 2 个标签页',
  'mod+3': '切换到第 3 个标签页',
  'mod+4': '切换到第 4 个标签页',
  'mod+5': '切换到第 5 个标签页',
  'mod+6': '切换到第 6 个标签页',
  'mod+7': '切换到第 7 个标签页',
  'mod+8': '切换到第 8 个标签页',
  'mod+9': '切换到最后一个标签页'
};

// 这些键不带修饰键单独使用时会干扰浏览、导航或编辑。
const BARE_KEY_BLOCKLIST = new Set([
  'tab', 'enter', 'space', 'escape', 'backspace', 'delete',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'home', 'end', 'pageup', 'pagedown', 'contextmenu'
]);

export interface ShortcutConflict {
  message: string;
}

export function validateCombo(combo: string, actionId: ShortcutActionId, draft: ShortcutMap): ShortcutConflict | null {
  const reserved = BROWSER_RESERVED[combo];
  if (reserved) {
    return { message: `「${formatCombo(combo)}」被浏览器保留（${reserved}），页面无法接管，请换一个组合。` };
  }
  const fixed = FIXED_SHORTCUTS[combo];
  if (fixed) {
    return { message: `「${formatCombo(combo)}」是内置的「${fixed}」快捷键，不能重复占用。` };
  }
  if (!combo.includes('+') && BARE_KEY_BLOCKLIST.has(combo)) {
    return { message: `「${formatCombo(combo)}」单独使用会干扰正常操作，请搭配 ⌘/Ctrl、Alt 或 Shift。` };
  }
  const holder = SHORTCUT_ACTIONS.find((action) => action.id !== actionId && draft[action.id] === combo);
  if (holder) {
    return { message: `「${formatCombo(combo)}」已分配给「${holder.label}」，请换一个组合。` };
  }
  return null;
}

const ARROW_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→'
};

export function formatCombo(combo: string): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const modifiers = parts.map((part) => (part === 'mod' ? '⌘/Ctrl' : part === 'alt' ? 'Alt' : 'Shift'));
  let label = ARROW_LABELS[key] ?? (key === 'space' ? 'Space' : key);
  if (label.length === 1) label = label.toUpperCase();
  else label = label.charAt(0).toUpperCase() + label.slice(1);
  return [...modifiers, label].join('+');
}

const SHORTCUT_STORAGE_KEY = 'sologsb-1028-shortcuts-v1';

export function loadShortcuts(): ShortcutMap {
  const map: ShortcutMap = { ...DEFAULT_SHORTCUTS };
  try {
    const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<ShortcutActionId, unknown>>;
      for (const action of SHORTCUT_ACTIONS) {
        const value = saved[action.id];
        if (typeof value === 'string' && value) map[action.id] = value;
      }
    }
  } catch {
    // 本地草稿损坏时回退到默认键位。
  }
  // 存储被手工改坏时可能出现重复键位，后出现的动作回退到默认。
  const seen = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    if (seen.has(map[action.id])) map[action.id] = DEFAULT_SHORTCUTS[action.id];
    seen.add(map[action.id]);
  }
  return map;
}

export function persistShortcuts(map: ShortcutMap): void {
  localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(map));
}
