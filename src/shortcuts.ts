// 可自定义快捷键的定义、存储与冲突判定。
// 注意：撤销/重做（Cmd/Ctrl+Z 等）是编辑基础能力，保持内置不可自定义。

export type ShortcutAction =
  | 'focusSearch'
  | 'tabOverview'
  | 'tabApi'
  | 'tabAccessibility'
  | 'tabExamples'
  | 'tabHistory'
  | 'addComponent'
  | 'saveVersion';

export type ShortcutGroup = 'global' | 'tab';

export interface ShortcutDescriptor {
  action: ShortcutAction;
  label: string;
  group: ShortcutGroup;
  defaultBinding: ShortcutBinding;
}

export interface ShortcutBinding {
  key: string; // 已归一化的 KeyboardEvent.key，如 'k'、'1'、'n'
  mod: boolean; // Cmd（macOS）或 Ctrl（其他平台）
  alt: boolean;
  shift: boolean;
}

export type ShortcutMap = Record<ShortcutAction, ShortcutBinding>;
export type ShortcutDraft = Partial<Record<ShortcutAction, ShortcutBinding | null>>;

export const STORAGE_KEY = 'sologsb-1028-shortcuts-v1';

export const SHORTCUT_DESCRIPTORS: ShortcutDescriptor[] = [
  { action: 'focusSearch', label: '聚焦搜索', group: 'global', defaultBinding: { key: 'k', mod: true, alt: false, shift: false } },
  { action: 'addComponent', label: '新建组件', group: 'global', defaultBinding: { key: 'n', mod: false, alt: true, shift: false } },
  { action: 'saveVersion', label: '保存版本', group: 'global', defaultBinding: { key: 's', mod: true, alt: false, shift: false } },
  { action: 'tabOverview', label: '编辑区：概述', group: 'tab', defaultBinding: { key: '1', mod: false, alt: true, shift: false } },
  { action: 'tabApi', label: '编辑区：属性与状态', group: 'tab', defaultBinding: { key: '2', mod: false, alt: true, shift: false } },
  { action: 'tabAccessibility', label: '编辑区：无障碍', group: 'tab', defaultBinding: { key: '3', mod: false, alt: true, shift: false } },
  { action: 'tabExamples', label: '编辑区：示例', group: 'tab', defaultBinding: { key: '4', mod: false, alt: true, shift: false } },
  { action: 'tabHistory', label: '编辑区：版本', group: 'tab', defaultBinding: { key: '5', mod: false, alt: true, shift: false } }
];

const isMac = () => /mac|iphone|ipad/i.test(navigator.platform) || /mac os/i.test(navigator.userAgent);

/** 归一化按键：字母转小写，其他键保持 KeyboardEvent.key 原样。 */
export function normalizeKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  return key;
}

/** 从键盘事件生成绑定（只记录修饰键状态，不要求当时已按下主键）。 */
export function bindingFromEvent(event: KeyboardEvent): ShortcutBinding {
  return {
    key: normalizeKey(event.key),
    mod: event.metaKey || event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  };
}

/** 判断事件是否与绑定完全一致（Cmd 与 Ctrl 在匹配时等价）。 */
export function eventMatchesBinding(event: KeyboardEvent, binding: ShortcutBinding | null | undefined): boolean {
  if (!binding) return false;
  return (
    normalizeKey(event.key) === binding.key &&
    (event.metaKey || event.ctrlKey) === binding.mod &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift
  );
}

export function sameBinding(a: ShortcutBinding | null | undefined, b: ShortcutBinding | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.key === b.key && a.mod === b.mod && a.alt === b.alt && a.shift === b.shift;
}

export function bindingCanonical(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push('mod');
  if (binding.alt) parts.push('alt');
  if (binding.shift) parts.push('shift');
  parts.push(binding.key);
  return parts.join('+');
}

const prettyKey = (key: string): string => {
  const map: Record<string, string> = {
    arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    ' ': 'Space', escape: 'Esc', enter: 'Enter', backspace: 'Backspace',
    delete: 'Del', tab: 'Tab'
  };
  return map[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);
};

/** 面向用户显示的组合键，如 ⌘K、Alt+N。可覆盖主键（用于 1–5 这类区间描述）。 */
export function describeBinding(binding: ShortcutBinding | null | undefined, keyOverride?: string): string {
  if (!binding) return '未设置';
  const mac = isMac();
  const keys: string[] = [];
  if (binding.mod) keys.push(mac ? '⌘' : 'Ctrl');
  if (binding.alt) keys.push(mac ? '⌥' : 'Alt');
  if (binding.shift) keys.push(mac ? '⇧' : 'Shift');
  keys.push(prettyKey(keyOverride ?? binding.key));
  return mac ? keys.join('') : keys.join('+');
}

/** aria-keyshortcuts 属性值，使用平台无关的 Control/Alt/Shift 名称。 */
export function ariaShortcut(binding: ShortcutBinding | null | undefined): string {
  if (!binding) return '';
  const keys: string[] = [];
  if (binding.mod) keys.push('Control');
  if (binding.alt) keys.push('Alt');
  if (binding.shift) keys.push('Shift');
  keys.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return keys.join('+');
}

export function defaultShortcuts(): ShortcutMap {
  return Object.fromEntries(
    SHORTCUT_DESCRIPTORS.map((descriptor) => [descriptor.action, { ...descriptor.defaultBinding }])
  ) as ShortcutMap;
}

export function isDefaultMap(map: ShortcutMap): boolean {
  return SHORTCUT_DESCRIPTORS.every((descriptor) => sameBinding(map[descriptor.action], descriptor.defaultBinding));
}

/** 读取本机已保存的设置；缺失或损坏时回退默认，并过滤未知动作。 */
export function loadShortcuts(): ShortcutMap {
  const fallback = defaultShortcuts();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Record<ShortcutAction, ShortcutBinding>>;
    for (const descriptor of SHORTCUT_DESCRIPTORS) {
      const binding = saved[descriptor.action];
      if (binding && typeof binding.key === 'string') {
        fallback[descriptor.action] = {
          key: normalizeKey(binding.key),
          mod: Boolean(binding.mod),
          alt: Boolean(binding.alt),
          shift: Boolean(binding.shift)
        };
      }
    }
  } catch {
    // 损坏的设置直接使用默认键位。
  }
  return fallback;
}

export function saveShortcuts(map: ShortcutMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/**
 * 浏览器保留快捷键：网页拦截不到或拦截会破坏基础浏览，因此禁止占用。
 * 键为归一化后的组合签名。
 */
const RESERVED_BROWSER: { pattern: (binding: ShortcutBinding) => boolean; reason: string }[] = [
  { pattern: (b) => b.key === 'w' && b.mod && !b.alt, reason: '关闭标签页是浏览器保留快捷键' },
  { pattern: (b) => b.key === 't' && b.mod && !b.alt && !b.shift, reason: '新建标签页是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'n' && b.mod && !b.alt && !b.shift, reason: '新建窗口是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'p' && b.mod && !b.shift, reason: '打印是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'l' && b.mod && !b.alt, reason: '聚焦地址栏是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'd' && b.mod && !b.alt && !b.shift, reason: '收藏书签是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'j' && b.mod && !b.alt, reason: '下载列表是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'h' && b.mod && !b.alt && !b.shift, reason: '浏览器历史是保留快捷键' },
  { pattern: (b) => b.key === 'q' && b.mod && !b.alt, reason: '退出浏览器是保留快捷键' },
  { pattern: (b) => b.key === 'r' && b.mod && !b.alt, reason: '刷新页面是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'f5', reason: '刷新页面是浏览器保留快捷键' },
  { pattern: (b) => b.key === 'tab' && b.mod, reason: '切换标签页是浏览器保留快捷键' },
  { pattern: (b) => b.key === '`' && b.mod && !b.alt, reason: '切换窗口是浏览器保留快捷键' },
  { pattern: (b) => b.key === ',' && b.mod && !b.alt && !b.shift, reason: '浏览器设置是保留快捷键（macOS）' },
  { pattern: (b) => b.key === 'f4' && b.alt, reason: '关闭窗口是浏览器保留快捷键' }
];

/** 撤销/重做作为内置编辑能力固定，自定义键位不得占用。 */
const RESERVED_BUILTIN: { binding: ShortcutBinding; reason: string }[] = [
  { binding: { key: 'z', mod: true, alt: false, shift: false }, reason: '⌘/Ctrl+Z 已固定用于撤销' },
  { binding: { key: 'z', mod: true, alt: false, shift: true }, reason: '⇧⌘/Ctrl+Z 已固定用于重做' },
  { binding: { key: 'y', mod: true, alt: false, shift: false }, reason: '⌘/Ctrl+Y 已固定用于重做' }
];

/** 仅是修饰键或无修饰的单键等不适合作为全局快捷键。 */
export function bindingProblem(binding: ShortcutBinding): string | null {
  const modifierOnly = ['control', 'meta', 'alt', 'shift'];
  if (modifierOnly.includes(binding.key.toLowerCase())) return '请同时按下一个主键（字母、数字或符号）';
  if (binding.key === 'Dead' || binding.key === 'Unidentified' || binding.key === 'Process') return '该按键无法识别，请换一个组合';
  if (binding.key === 'tab' && !binding.mod && !binding.alt) return 'Tab 用于焦点移动，不能占用';
  if (!binding.mod && !binding.alt) {
    return binding.key === 'escape'
      ? 'Esc 用于关闭弹层，不能占用'
      : '请搭配 Ctrl/⌘ 或 Alt 使用，避免影响正常输入';
  }
  for (const reserved of RESERVED_BROWSER) {
    if (reserved.pattern(binding)) return reserved.reason;
  }
  for (const builtin of RESERVED_BUILTIN) {
    if (sameBinding(binding, builtin.binding)) return builtin.reason;
  }
  return null;
}

/** 在当前草稿（或已生效设置）中查找占用同一组合的动作。 */
export function findConflict(
  binding: ShortcutBinding,
  action: ShortcutAction,
  map: Partial<Record<ShortcutAction, ShortcutBinding | null>>
): ShortcutAction | null {
  for (const descriptor of SHORTCUT_DESCRIPTORS) {
    if (descriptor.action === action) continue;
    if (sameBinding(map[descriptor.action], binding)) return descriptor.action;
  }
  return null;
}

export function actionLabel(action: ShortcutAction): string {
  return SHORTCUT_DESCRIPTORS.find((descriptor) => descriptor.action === action)?.label ?? action;
}
