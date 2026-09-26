import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { diffAgainstSnapshot } from './diff';
import { SpecStore } from './store';
import {
  SHORTCUT_DESCRIPTORS,
  actionLabel,
  ariaShortcut,
  bindingFromEvent,
  bindingProblem,
  describeBinding,
  eventMatchesBinding,
  findConflict,
  loadShortcuts,
  sameBinding,
  saveShortcuts,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutMap
} from './shortcuts';
import type { ComponentExample, ComponentSpec, PreviewDensity, PreviewTheme, PropertySpec, ValidationIssue } from './types';

type EditorTab = 'overview' | 'api' | 'accessibility' | 'examples' | 'history';

interface RowError {
  message: string;
  kind: 'invalid' | 'conflict';
  // 冲突提示里被拒绝的新组合：草稿里仍是原绑定，需记住它才能判断提示是否还成立。
  rejected?: ShortcutBinding;
}

const TAB_ACTIONS = ['tabOverview', 'tabApi', 'tabAccessibility', 'tabExamples', 'tabHistory'] as const satisfies readonly ShortcutAction[];
const TAB_BY_ACTION: Record<(typeof TAB_ACTIONS)[number], EditorTab> = {
  tabOverview: 'overview',
  tabApi: 'api',
  tabAccessibility: 'accessibility',
  tabExamples: 'examples',
  tabHistory: 'history'
};

/** 焦点位于可编辑元素内时，除“保存版本”外不触发全局快捷键，避免劫持打字。 */
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type.toLowerCase();
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
  }
  return false;
}

export class SpecA11yWorkbench extends LitElement {
  static properties = {
    query: { state: true },
    tab: { state: true },
    previewTheme: { state: true },
    previewDensity: { state: true },
    toast: { state: true },
    showValidation: { state: true },
    shortcutsOpen: { state: true },
    recordingAction: { state: true },
    draftVersion: { state: true }
  };

  private store = new SpecStore();
  private query = '';
  private tab: EditorTab = 'overview';
  private previewTheme: PreviewTheme = 'light';
  private previewDensity: PreviewDensity = 'regular';
  private toast = '';
  private showValidation = true;
  private toastTimer?: number;
  private shortcuts: ShortcutMap = loadShortcuts();
  // 设置对话框状态：打开期间所有旧快捷键停止工作。
  private shortcutsOpen = false;
  private recordingAction: ShortcutAction | null = null;
  private draft: ShortcutMap = this.shortcuts;
  private draftVersion = 0; // 自增以触发设置列表重渲染
  private rowError = new Map<ShortcutAction, RowError>();
  private lastFocusedElement: HTMLElement | null = null;

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      color: var(--spectrum-gray-900);
      background: linear-gradient(135deg, var(--spectrum-gray-100), var(--spectrum-blue-100));
      font-family: var(--spectrum-sans-font-family, Inter, ui-sans-serif, system-ui);
    }
    * { box-sizing: border-box; }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header {
      position: sticky; top: 0; z-index: 20;
      display: flex; align-items: center; gap: 18px; padding: 14px 22px;
      background: color-mix(in srgb, var(--spectrum-gray-50) 92%, transparent);
      border-bottom: 1px solid var(--spectrum-gray-300); backdrop-filter: blur(14px);
    }
    .brand { min-width: 245px; }
    .brand h1 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
    .brand p { margin: 3px 0 0; color: var(--spectrum-gray-700); font-size: 12px; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex: 1; }
    .toolbar sp-search { min-width: 280px; flex: 1; max-width: 520px; }
    .save-state { color: var(--spectrum-gray-700); font-size: 12px; white-space: nowrap; }
    .layout {
      display: grid; grid-template-columns: minmax(245px, 290px) minmax(0, 1fr) minmax(315px, 390px);
      min-height: calc(100vh - 72px);
    }
    .sidebar, .inspector { background: color-mix(in srgb, var(--spectrum-gray-50) 90%, transparent); }
    .sidebar { border-right: 1px solid var(--spectrum-gray-300); padding: 18px 12px; }
    .sidebar-heading { display: flex; justify-content: space-between; align-items: center; padding: 0 8px 12px; }
    .sidebar-heading h2, .panel h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
    .component-list { display: grid; gap: 7px; }
    .component-item {
      width: 100%; text-align: left; border: 1px solid transparent; border-radius: 10px;
      background: transparent; color: inherit; padding: 11px 12px; cursor: pointer;
    }
    .component-item:hover { background: var(--spectrum-gray-200); }
    .component-item[aria-current='page'] { border-color: var(--spectrum-blue-600); background: var(--spectrum-blue-200); }
    .item-title { display: flex; justify-content: space-between; gap: 8px; font-weight: 700; }
    .item-meta { display: block; color: var(--spectrum-gray-700); font-size: 12px; margin-top: 5px; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 700; background: var(--spectrum-gray-300); }
    .pill.published { background: var(--spectrum-green-300); }
    .pill.review { background: var(--spectrum-orange-300); }
    .main { min-width: 0; padding: 22px; }
    .title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; margin-bottom: 16px; }
    .title-row h2 { font-size: 28px; margin: 0; letter-spacing: -.035em; }
    .title-row p { margin: 6px 0 0; color: var(--spectrum-gray-700); }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .tabs { display: flex; gap: 5px; overflow-x: auto; padding: 5px; border: 1px solid var(--spectrum-gray-300); border-radius: 12px; background: var(--spectrum-gray-100); margin-bottom: 16px; }
    .tab { border: 0; border-radius: 8px; background: transparent; color: var(--spectrum-gray-800); padding: 8px 12px; font: inherit; cursor: pointer; white-space: nowrap; }
    .tab[aria-selected='true'] { background: var(--spectrum-gray-50); box-shadow: 0 1px 4px rgb(0 0 0 / .12); font-weight: 700; }
    .panel { border: 1px solid var(--spectrum-gray-300); border-radius: 16px; background: var(--spectrum-gray-50); padding: 20px; box-shadow: 0 8px 26px rgb(20 30 50 / .06); }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .field { display: grid; gap: 7px; min-width: 0; }
    .field.full { grid-column: 1 / -1; }
    .field > span { font-size: 12px; font-weight: 700; }
    textarea, input[type='text'], select {
      width: 100%; border: 1px solid var(--spectrum-gray-400); border-radius: 8px;
      padding: 9px 10px; background: var(--spectrum-gray-50); color: var(--spectrum-gray-900);
      font: inherit; line-height: 1.5;
    }
    textarea:focus, input:focus, select:focus { outline: 3px solid var(--spectrum-blue-400); outline-offset: 1px; border-color: var(--spectrum-blue-700); }
    textarea { min-height: 110px; resize: vertical; }
    .property-list, .example-list { display: grid; gap: 12px; }
    .property-card, .example-card { border: 1px solid var(--spectrum-gray-300); border-radius: 12px; padding: 14px; background: var(--spectrum-gray-75, var(--spectrum-gray-100)); }
    .property-head, .example-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .property-head strong, .example-head strong { flex: 1; }
    .inline { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .empty { padding: 28px; border: 1px dashed var(--spectrum-gray-400); border-radius: 12px; text-align: center; color: var(--spectrum-gray-700); }
    .inspector { border-left: 1px solid var(--spectrum-gray-300); padding: 18px; display: grid; align-content: start; gap: 15px; }
    .preview { border-radius: 14px; border: 1px solid var(--spectrum-gray-400); padding: 18px; display: grid; place-items: center; min-height: 150px; transition: .2s; }
    .preview.dark { background: #1b1b1b; color: #f5f5f5; border-color: #444; }
    .preview.light { background: #fff; color: #111; }
    .preview.compact { padding: 9px; }
    .preview.regular { padding: 18px; }
    .preview.spacious { padding: 32px; }
    .demo-button { border: 0; border-radius: 8px; padding: 10px 16px; background: #1473e6; color: white; font: inherit; }
    .issue { border-left: 4px solid var(--spectrum-gray-500); border-radius: 8px; background: var(--spectrum-gray-100); padding: 10px 11px; margin-bottom: 8px; font-size: 12px; }
    .issue.error { border-color: var(--spectrum-red-600); }
    .issue.warning { border-color: var(--spectrum-orange-600); }
    .issue.info { border-color: var(--spectrum-blue-600); }
    .issue strong { display: block; margin-bottom: 3px; }
    .issue button { border: 0; background: transparent; color: var(--spectrum-blue-800); padding: 0; cursor: pointer; text-decoration: underline; }
    .diff { display: grid; gap: 7px; margin-top: 9px; }
    .diff-row { border: 1px solid var(--spectrum-gray-300); border-radius: 8px; padding: 9px; font-size: 11px; }
    .diff-row b { display: block; margin-bottom: 4px; text-transform: capitalize; }
    .before { color: var(--spectrum-red-800); white-space: pre-wrap; }
    .after { color: var(--spectrum-green-900); white-space: pre-wrap; }
    pre { white-space: pre-wrap; word-break: break-word; background: #202020; color: #f5f5f5; padding: 12px; border-radius: 8px; font-size: 12px; }
    .search-empty { padding: 20px 8px; color: var(--spectrum-gray-700); font-size: 13px; }
    .footer-hint { position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 30; background: #202020; color: white; border-radius: 999px; padding: 6px 12px; font-size: 11px; opacity: .9; }
    sp-toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; }
    .tab kbd {
      display: inline-block; margin-left: 7px; padding: 1px 6px; border-radius: 5px;
      background: var(--spectrum-gray-200); border: 1px solid var(--spectrum-gray-400);
      font-family: inherit; font-size: 10px; font-weight: 600; color: var(--spectrum-gray-700);
    }
    .tab[aria-selected='true'] kbd { background: var(--spectrum-gray-100); color: var(--spectrum-gray-800); }
    .shortcut-overlay {
      position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
      background: rgb(15 23 42 / .55); padding: 20px; backdrop-filter: blur(2px);
    }
    .shortcut-dialog {
      width: min(680px, 100%); max-height: 86vh; overflow: auto; display: grid; gap: 8px;
      background: var(--spectrum-gray-50); color: var(--spectrum-gray-900);
      border: 1px solid var(--spectrum-gray-300); border-radius: 16px; padding: 22px;
      box-shadow: 0 24px 70px rgb(0 0 0 / .35);
    }
    .shortcut-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
    .shortcut-dialog-head h2 { margin: 0; font-size: 19px; }
    .shortcut-dialog-head p { margin: 6px 0 0; font-size: 12px; color: var(--spectrum-gray-700); line-height: 1.55; }
    .icon-btn {
      border: 0; background: transparent; font-size: 22px; line-height: 1; cursor: pointer;
      color: var(--spectrum-gray-700); padding: 4px 10px; border-radius: 8px;
    }
    .icon-btn:hover { background: var(--spectrum-gray-200); }
    .shortcut-group-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
      color: var(--spectrum-gray-600); margin: 12px 0 2px;
    }
    .shortcut-row {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px;
      border: 1px solid var(--spectrum-gray-300); border-radius: 10px; background: #fff;
    }
    .shortcut-row.recording { border-color: var(--spectrum-blue-600); box-shadow: 0 0 0 3px var(--spectrum-blue-400); }
    .shortcut-name { font-size: 13px; font-weight: 600; min-width: 150px; }
    .shortcut-error { flex: 1; color: var(--spectrum-red-700, #b52b27); font-size: 12px; line-height: 1.4; }
    .shortcut-row-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .shortcut-key {
      min-width: 168px; text-align: center; border: 1px solid var(--spectrum-gray-500);
      border-radius: 8px; background: var(--spectrum-gray-100); color: var(--spectrum-gray-900);
      padding: 7px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .shortcut-key[aria-pressed='true'] {
      background: var(--spectrum-blue-200); border-color: var(--spectrum-blue-700); color: #0a3d7a;
      animation: shortcut-pulse 1.4s ease-in-out infinite;
    }
    @keyframes shortcut-pulse { 50% { box-shadow: 0 0 0 4px rgb(20 115 230 / .25); } }
    .btn-link {
      border: 0; background: transparent; color: var(--spectrum-blue-800); cursor: pointer;
      font: inherit; font-size: 12px; text-decoration: underline; padding: 4px;
    }
    .btn-link:disabled { color: var(--spectrum-gray-500); cursor: not-allowed; text-decoration: none; }
    .shortcut-dialog-foot { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
    .shortcut-spacer { flex: 1; }
    .btn-primary, .btn-secondary {
      border-radius: 8px; padding: 8px 16px; font: inherit; font-size: 13px; cursor: pointer;
    }
    .btn-primary { border: 1px solid var(--spectrum-blue-700); background: var(--spectrum-blue-600); color: #fff; }
    .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .btn-secondary { border: 1px solid var(--spectrum-gray-500); background: #fff; color: var(--spectrum-gray-900); }
    .btn-secondary:disabled { opacity: .5; cursor: not-allowed; }
    @media (max-width: 1180px) {
      .layout { grid-template-columns: 230px minmax(0, 1fr); }
      .inspector { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--spectrum-gray-300); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      header { flex-wrap: wrap; padding: 12px; }
      .brand { min-width: 100%; }
      .toolbar { flex-wrap: wrap; }
      .toolbar sp-search { min-width: 100%; }
      .layout { grid-template-columns: 1fr; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--spectrum-gray-300); }
      .inspector { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
      .field.full { grid-column: auto; }
      .main { padding: 14px; }
      .title-row { display: grid; }
      .actions { justify-content: flex-start; }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.store.addEventListener('change', this.onStoreChange);
    window.addEventListener('keydown', this.onKeyDown);
    // 捕获阶段先拿到按键：录制组合键时拦截浏览器默认行为，且不触发旧快捷键。
    window.addEventListener('keydown', this.onCaptureKeyDown, true);
  }

  disconnectedCallback() {
    this.store.removeEventListener('change', this.onStoreChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keydown', this.onCaptureKeyDown, true);
  }

  private onStoreChange = () => {
    this.requestUpdate();
  };

  /** 设置对话框打开期间吞掉全部应用快捷键，并处理录制与焦点约束。 */
  private onCaptureKeyDown = (event: KeyboardEvent) => {
    if (!this.shortcutsOpen) return;
    if (this.recordingAction) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.recordingAction = null;
      } else {
        this.captureBinding(event);
      }
      return;
    }
    // 设置期间旧快捷键一律不抢按键（含撤销/重做与保存）。
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeShortcuts();
      return;
    }
    // Tab 在对话框内循环，避免焦点跑到背后的编辑区。
    if (event.key === 'Tab') this.trapFocus(event);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (this.shortcutsOpen) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.store.redo() : this.store.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.store.redo();
      return;
    }
    // 输入说明文字时只有保存组合继续可用，其余快捷键不抢按键。
    const editable = isEditableTarget(event.target);
    for (const descriptor of SHORTCUT_DESCRIPTORS) {
      if (editable && descriptor.action !== 'saveVersion') continue;
      if (!eventMatchesBinding(event, this.shortcuts[descriptor.action])) continue;
      event.preventDefault();
      this.runShortcut(descriptor.action);
      return;
    }
  };

  private runShortcut(action: ShortcutAction) {
    switch (action) {
      case 'focusSearch':
        this.renderRoot.querySelector<HTMLElement>('sp-search')?.focus();
        break;
      case 'addComponent':
        this.store.addComponent();
        break;
      case 'saveVersion':
        this.store.createSnapshot('键盘保存');
        this.flash('已创建版本快照');
        break;
      default:
        if (TAB_BY_ACTION[action]) this.tab = TAB_BY_ACTION[action];
    }
  }

  // ── 快捷键设置对话框 ───────────────────────────────────────────

  private openShortcuts() {
    this.lastFocusedElement = document.activeElement as HTMLElement | null;
    this.draft = structuredClone(this.shortcuts);
    this.rowError.clear();
    this.recordingAction = null;
    this.shortcutsOpen = true;
    this.draftVersion += 1;
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>('.shortcut-dialog .btn-secondary')?.focus();
    });
  }

  private closeShortcuts() {
    this.shortcutsOpen = false;
    this.recordingAction = null;
    this.rowError.clear();
    this.lastFocusedElement?.focus?.();
  }

  private startRecording(action: ShortcutAction) {
    this.rowError.delete(action);
    this.recordingAction = action;
    this.draftVersion += 1;
  }

  private captureBinding(event: KeyboardEvent) {
    const action = this.recordingAction;
    if (!action) return;
    const binding = bindingFromEvent(event);
    // 仅按下修饰键时继续等待主键。
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    this.recordingAction = null;
    const invalid = bindingProblem(binding);
    if (invalid) {
      this.rowError.set(action, { message: invalid, kind: 'invalid' });
    } else {
      const conflict = findConflict(binding, action, this.draft);
      if (conflict) {
        this.rowError.set(action, {
          message: `与「${actionLabel(conflict)}」的 ${describeBinding(binding)} 冲突，已保留原设置`,
          kind: 'conflict',
          rejected: binding
        });
      } else {
        this.draft[action] = binding;
        this.rowError.delete(action);
      }
    }
    this.revalidateConflictErrors();
    this.draftVersion += 1;
  }

  private restoreRow(action: ShortcutAction) {
    const descriptor = SHORTCUT_DESCRIPTORS.find((item) => item.action === action);
    if (!descriptor) return;
    this.recordingAction = null;
    const binding = descriptor.defaultBinding;
    const conflict = findConflict(binding, action, this.draft);
    if (conflict) {
      this.rowError.set(action, {
        message: `默认组合 ${describeBinding(binding)} 与「${actionLabel(conflict)}」冲突，已保留原设置`,
        kind: 'conflict',
        rejected: { ...binding }
      });
    } else {
      this.draft[action] = { ...binding };
      this.rowError.delete(action);
    }
    this.revalidateConflictErrors();
    this.draftVersion += 1;
  }

  private restoreAllDefaults() {
    const next = Object.fromEntries(
      SHORTCUT_DESCRIPTORS.map((descriptor) => [descriptor.action, { ...descriptor.defaultBinding }])
    ) as ShortcutMap;
    this.draft = next;
    this.recordingAction = null;
    // 默认键位彼此不冲突，所有冲突提示一并失效。
    for (const [action, error] of this.rowError) {
      if (error.kind === 'conflict') this.rowError.delete(action);
    }
    this.draftVersion += 1;
  }

  private saveShortcutSettings() {
    this.shortcuts = this.draft;
    saveShortcuts(this.shortcuts);
    this.shortcutsOpen = false;
    this.recordingAction = null;
    this.rowError.clear();
    this.lastFocusedElement?.focus?.();
    this.flash('键位设置已保存并在本机生效');
  }

  /** 冲突源被改走后，清掉其他行上已失效的冲突提示。 */
  private revalidateConflictErrors() {
    for (const [action, error] of this.rowError) {
      if (error.kind !== 'conflict' || !error.rejected) continue;
      // 被拒绝的组合如今不再被任何其他命令占用时，提示即可消失。
      if (!findConflict(error.rejected, action, this.draft)) this.rowError.delete(action);
    }
  }

  private get draftChanged(): boolean {
    return SHORTCUT_DESCRIPTORS.some(
      (descriptor) => !sameBinding(this.draft[descriptor.action], this.shortcuts[descriptor.action])
    );
  }

  private trapFocus(event: KeyboardEvent) {
    const dialog = this.renderRoot.querySelector<HTMLElement>('.shortcut-dialog');
    if (!dialog) return;
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const list = [...focusable];
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  protected render(): TemplateResult {
    const selected = this.store.selected;
    const issues = this.store.validate();
    const selectedIssues = selected ? issues.filter((item) => item.componentId === selected.id) : [];
    const filtered = this.filteredComponents;
    return html`
      <sp-theme color=${this.previewTheme === 'dark' ? 'dark' : 'light'} scale=${this.previewDensity === 'compact' ? 'medium' : 'large'}>
        <div class="app">
          <header>
            <div class="brand">
              <h1>Component Contract Studio</h1>
              <p>规范、无障碍与示例失效追踪</p>
            </div>
            <div class="toolbar">
              <sp-search
                placeholder="搜索组件、属性、键盘行为或示例"
                aria-label="全文搜索"
                aria-keyshortcuts=${ariaShortcut(this.shortcuts.focusSearch)}
                .value=${this.query}
                @input=${(event: Event) => { this.query = (event.currentTarget as HTMLInputElement & { value?: string }).value ?? ''; }}
              ></sp-search>
              <sp-button variant="secondary" ?disabled=${!this.store.canUndo} @click=${() => this.store.undo()}>撤销</sp-button>
              <sp-button variant="secondary" ?disabled=${!this.store.canRedo} @click=${() => this.store.redo()}>重做</sp-button>
              <sp-button variant="accent" aria-keyshortcuts=${ariaShortcut(this.shortcuts.saveVersion)} @click=${() => { this.store.createSnapshot('工具栏保存'); this.flash('版本已保存'); }}>保存版本</sp-button>
              <sp-button variant="secondary" @click=${() => this.openShortcuts()}>键位设置</sp-button>
              <span class="save-state">本地自动保存 · ${selected?.revision ?? 0} 版</span>
            </div>
          </header>
          <div class="layout">
            <aside class="sidebar" aria-label="组件目录">
              <div class="sidebar-heading">
                <h2>组件目录</h2>
                <sp-action-button size="s" label="新建组件" aria-keyshortcuts=${ariaShortcut(this.shortcuts.addComponent)} @click=${() => this.store.addComponent()}>＋</sp-action-button>
              </div>
              <div class="component-list">
                ${filtered.length ? repeat(filtered, (item) => item.id, (item) => html`
                  <button class="component-item" aria-current=${item.id === this.store.state.selectedId ? 'page' : nothing} @click=${() => this.store.select(item.id)}>
                    <span class="item-title">
                      <span>${item.name}</span>
                      <span class="pill ${item.status}">${this.statusLabel(item.status)}</span>
                    </span>
                    <span class="item-meta">${item.category} · ${item.properties.length} 个属性 · ${item.examples.length} 个示例</span>
                  </button>
                `) : html`<div class="search-empty">没有匹配的组件。可尝试属性名、键盘行为或代码文本。</div>`}
              </div>
            </aside>
            <main class="main">${selected ? this.renderEditor(selected) : html`<div class="empty">新建或选择组件开始编辑。</div>`}</main>
            <aside class="inspector" aria-label="预览与检查">
              ${this.renderPreview(selected)}
              ${this.renderValidation(selectedIssues)}
            </aside>
          </div>
          ${this.toast ? html`<sp-toast open variant="positive" timeout="3000">${this.toast}</sp-toast>` : nothing}
          <div class="footer-hint">${this.footerHint}</div>
          ${this.shortcutsOpen ? this.renderShortcutsDialog() : nothing}
        </div>
      </sp-theme>
    `;
  }

  private get footerHint(): string {
    const s = this.shortcuts;
    const range = `${describeBinding(s.tabOverview, '1')}–${describeBinding(s.tabHistory, '5')}`;
    return [
      '⌘/Ctrl+Z 撤销',
      '⇧⌘/Ctrl+Z 重做',
      `${describeBinding(s.focusSearch)} 搜索`,
      `${describeBinding(s.addComponent)} 新建`,
      `${describeBinding(s.saveVersion)} 保存`,
      `${range} 切换面板`
    ].join(' · ');
  }

  private renderShortcutsDialog(): TemplateResult {
    const globalDescriptors = SHORTCUT_DESCRIPTORS.filter((descriptor) => descriptor.group === 'global');
    const tabDescriptors = SHORTCUT_DESCRIPTORS.filter((descriptor) => descriptor.group === 'tab');
    const allDefault = SHORTCUT_DESCRIPTORS.every((descriptor) =>
      sameBinding(this.draft[descriptor.action], descriptor.defaultBinding)
    );
    return html`
      <div class="shortcut-overlay" @mousedown=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.closeShortcuts(); }}>
        <div class="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-dialog-title">
          <div class="shortcut-dialog-head">
            <div>
              <h2 id="shortcut-dialog-title">键位设置</h2>
              <p>点击某项后按下新的组合键。与浏览器保留键或其他命令冲突时会提示并保留原设置；保存后立即在本机生效。</p>
            </div>
            <button class="icon-btn" aria-label="关闭键位设置" @click=${() => this.closeShortcuts()}>×</button>
          </div>
          <div class="shortcut-group-title">全局命令</div>
          ${globalDescriptors.map((descriptor) => this.renderShortcutRow(descriptor.action, descriptor.label))}
          <div class="shortcut-group-title">五个编辑区</div>
          ${tabDescriptors.map((descriptor) => this.renderShortcutRow(descriptor.action, descriptor.label))}
          <div class="shortcut-dialog-foot">
            <button class="btn-secondary" @click=${() => this.restoreAllDefaults()} ?disabled=${allDefault}>全部恢复默认</button>
            <span class="shortcut-spacer"></span>
            <button class="btn-secondary" @click=${() => this.closeShortcuts()}>取消</button>
            <button class="btn-primary" @click=${() => this.saveShortcutSettings()} ?disabled=${!this.draftChanged}>保存设置</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderShortcutRow(action: ShortcutAction, label: string): TemplateResult {
    const binding = this.draft[action];
    const descriptor = SHORTCUT_DESCRIPTORS.find((item) => item.action === action);
    const isDefault = descriptor ? sameBinding(binding, descriptor.defaultBinding) : false;
    const recording = this.recordingAction === action;
    const error = this.rowError.get(action);
    return html`
      <div class="shortcut-row ${recording ? 'recording' : ''}">
        <span class="shortcut-name">${label}</span>
        ${error ? html`<span class="shortcut-error" role="alert">${error.message}</span>` : nothing}
        <span class="shortcut-row-actions">
          <button
            class="shortcut-key"
            aria-pressed=${recording}
            aria-label=${`${label}快捷键，当前为 ${describeBinding(binding)}，点击后按新组合`}
            @click=${() => this.startRecording(action)}
          >${recording ? '请按下新组合（Esc 取消）…' : describeBinding(binding)}</button>
          <button class="btn-link" ?disabled=${isDefault || recording} @click=${() => this.restoreRow(action)}>恢复默认</button>
        </span>
      </div>
    `;
  }

  private renderEditor(component: ComponentSpec): TemplateResult {
    return html`
      <div class="title-row">
        <div>
          <h2>${component.name}</h2>
          <p>${component.purpose}</p>
        </div>
        <div class="actions">
          <select aria-label="组件状态" .value=${component.status} @change=${(event: Event) => this.store.updateComponent({ status: (event.currentTarget as HTMLSelectElement).value as ComponentSpec['status'] })}>
            <option value="draft">草稿</option>
            <option value="review">待审</option>
            <option value="published">已发布</option>
          </select>
          <sp-button variant="secondary" @click=${() => this.store.createSnapshot('编辑器保存')}>保存快照</sp-button>
          ${this.hasStaleExamples(component) ? html`<sp-button variant="accent" @click=${() => { this.store.migrateExamples(); this.flash('示例已迁移到当前契约'); }}>迁移示例</sp-button>` : nothing}
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="编辑区域">
        ${this.renderTab('overview', '概述')}
        ${this.renderTab('api', '属性与状态')}
        ${this.renderTab('accessibility', '无障碍')}
        ${this.renderTab('examples', '示例')}
        ${this.renderTab('history', '版本')}
      </div>
      ${this.tab === 'overview' ? this.renderOverview(component) : nothing}
      ${this.tab === 'api' ? this.renderApi(component) : nothing}
      ${this.tab === 'accessibility' ? this.renderAccessibility(component) : nothing}
      ${this.tab === 'examples' ? this.renderExamples(component) : nothing}
      ${this.tab === 'history' ? this.renderHistory(component) : nothing}
    `;
  }

  private renderTab(tab: EditorTab, label: string): TemplateResult {
    const action = TAB_ACTIONS.find((item) => TAB_BY_ACTION[item] === tab);
    const binding = action ? this.shortcuts[action] : undefined;
    return html`<button
      class="tab"
      role="tab"
      aria-selected=${this.tab === tab}
      aria-keyshortcuts=${binding ? ariaShortcut(binding) : nothing}
      @click=${() => { this.tab = tab; }}
    ><span class="tab-label">${label}</span>${binding ? html`<kbd>${describeBinding(binding)}</kbd>` : nothing}</button>`;
  }

  private renderOverview(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel" aria-label="组件概述">
        <div class="form-grid">
          <label class="field"><span>组件名称</span><input type="text" .value=${component.name} @change=${(event: Event) => this.store.updateComponent({ name: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>分类</span><input type="text" .value=${component.category} @change=${(event: Event) => this.store.updateComponent({ category: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field full"><span>用途</span><textarea .value=${component.purpose} @change=${(event: Event) => this.store.updateComponent({ purpose: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>使用规则</span><textarea .value=${component.usage} @change=${(event: Event) => this.store.updateComponent({ usage: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>禁用场景</span><textarea .value=${component.disabledScenarios} @change=${(event: Event) => this.store.updateComponent({ disabledScenarios: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderApi(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>属性契约</h2>
          <sp-button size="s" variant="secondary" @click=${() => this.store.addProperty()}>新增属性</sp-button>
        </div>
        <div class="property-list">
          ${component.properties.length ? repeat(component.properties, (item) => item.id, (property) => this.renderProperty(property)) : html`<div class="empty">尚未定义属性。</div>`}
        </div>
        <div class="form-grid" style="margin-top: 18px">
          <label class="field full"><span>状态说明</span><textarea .value=${component.states} @change=${(event: Event) => this.store.updateComponent({ states: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>交互签名（修改后会标记关联示例失效）</span><textarea .value=${component.interactionSignature} @change=${(event: Event) => this.store.updateComponent({ interactionSignature: (event.currentTarget as HTMLTextAreaElement).value }, true)}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderProperty(property: PropertySpec): TemplateResult {
    return html`
      <article class="property-card">
        <div class="property-head">
          <strong>${property.name || '未命名属性'}</strong>
          <sp-action-button size="s" label="删除属性" @click=${() => this.store.removeProperty(property.id)}>删除</sp-action-button>
        </div>
        <div class="form-grid">
          <label class="field"><span>名称</span><input type="text" .value=${property.name} @change=${(event: Event) => this.store.updateProperty(property.id, { name: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>类型</span><input type="text" .value=${property.type} @change=${(event: Event) => this.store.updateProperty(property.id, { type: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>默认值</span><input type="text" .value=${property.defaultValue} @change=${(event: Event) => this.store.updateProperty(property.id, { defaultValue: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="inline"><input type="checkbox" .checked=${property.required} @change=${(event: Event) => this.store.updateProperty(property.id, { required: (event.currentTarget as HTMLInputElement).checked })} /> 必填属性</label>
          <label class="field full"><span>属性说明</span><textarea .value=${property.description} @change=${(event: Event) => this.store.updateProperty(property.id, { description: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </article>
    `;
  }

  private renderAccessibility(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel">
        <div class="form-grid">
          <label class="field full"><span>键盘行为</span><textarea .value=${component.keyboardBehavior} @change=${(event: Event) => this.store.updateComponent({ keyboardBehavior: (event.currentTarget as HTMLTextAreaElement).value }, true)}></textarea></label>
          <label class="field full"><span>读屏说明</span><textarea .value=${component.screenReader} @change=${(event: Event) => this.store.updateComponent({ screenReader: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>禁用场景</span><textarea .value=${component.disabledScenarios} @change=${(event: Event) => this.store.updateComponent({ disabledScenarios: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderExamples(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>关联示例</h2>
          <sp-button size="s" variant="secondary" @click=${() => this.store.addExample()}>新增示例</sp-button>
        </div>
        <div class="example-list">
          ${component.examples.length ? repeat(component.examples, (item) => item.id, (example) => this.renderExample(component, example)) : html`<div class="empty">尚无示例。新增后会追踪属性依赖和版本契约。</div>`}
        </div>
      </section>
    `;
  }

  private renderExample(component: ComponentSpec, example: ComponentExample): TemplateResult {
    return html`
      <article class="example-card">
        <div class="example-head">
          <strong>${example.title}</strong>
          <span class="pill ${example.stale ? 'review' : 'published'}">${example.stale ? '需要迁移' : `r${example.createdFromRevision}`}</span>
          <sp-action-button size="s" label="复制代码" @click=${() => this.copy(example.code)}>复制</sp-action-button>
          <sp-action-button size="s" label="删除示例" @click=${() => this.store.removeExample(example.id)}>删除</sp-action-button>
        </div>
        ${example.stale ? html`<div class="issue warning"><strong>关联失效</strong>${example.staleReason}</div>` : nothing}
        <div class="form-grid">
          <label class="field full"><span>标题</span><input type="text" .value=${example.title} @change=${(event: Event) => this.store.updateExample(example.id, { title: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field full"><span>代码</span><textarea .value=${example.code} @change=${(event: Event) => this.store.updateExample(example.id, { code: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <div class="field full">
            <span>依赖属性</span>
            <div class="inline" style="flex-wrap: wrap">
              ${component.properties.map((property) => html`
                <label class="inline"><input type="checkbox" .checked=${example.propertyIds.includes(property.id)} @change=${(event: Event) => {
                  const values = new Set(example.propertyIds);
                  (event.currentTarget as HTMLInputElement).checked ? values.add(property.id) : values.delete(property.id);
                  this.store.updateExample(example.id, { propertyIds: [...values] });
                }} /> ${property.name}</label>
              `)}
              ${!component.properties.length ? html`<span>当前组件没有属性。</span>` : nothing}
            </div>
          </div>
          <div class="field full"><pre>${example.code}</pre></div>
        </div>
      </article>
    `;
  }

  private renderHistory(component: ComponentSpec): TemplateResult {
    const snapshot = component.snapshots[0];
    const rows = diffAgainstSnapshot(component, snapshot);
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>版本与迁移</h2>
          <sp-button size="s" variant="secondary" @click=${() => this.store.createSnapshot('历史面板保存')}>保存当前版本</sp-button>
        </div>
        <p>当前为 r${component.revision}。最近快照：${snapshot ? `r${snapshot.revision} · ${new Date(snapshot.savedAt).toLocaleString('zh-CN')}` : '暂无'}。</p>
        ${snapshot ? html`
          <h3>与最近快照的差异</h3>
          ${rows.length ? html`<div class="diff">${rows.map((row) => html`<div class="diff-row"><b>${row.field}</b><span class="before">- ${row.before || '（空）'}</span><br /><span class="after">+ ${row.after || '（空）'}</span></div>`)}</div>` : html`<div class="issue info">当前内容与最近快照一致。</div>`}
        ` : html`<div class="empty">保存一次版本后即可比较字段、属性和示例变化。</div>`}
        ${this.hasStaleExamples(component) ? html`<div class="issue warning" style="margin-top: 14px"><strong>检测到待迁移示例</strong>迁移会保留代码内容，清理已删除属性引用并更新契约版本。<br /><button @click=${() => this.store.migrateExamples()}>立即迁移</button></div>` : nothing}
      </section>
    `;
  }

  private renderPreview(component?: ComponentSpec): TemplateResult {
    if (!component) return html`<section class="panel"><h2>预览</h2><p>选择组件后显示主题与密度预览。</p></section>`;
    return html`
      <section class="panel">
        <div class="property-head"><h2>实时预览</h2><button class="tab" @click=${() => { this.previewTheme = this.previewTheme === 'light' ? 'dark' : 'light'; }}>${this.previewTheme === 'light' ? '深色' : '浅色'}</button></div>
        <div class="inline" style="margin-bottom: 10px">
          <label>密度</label>
          <select .value=${this.previewDensity} @change=${(event: Event) => { this.previewDensity = (event.currentTarget as HTMLSelectElement).value as PreviewDensity; }}>
            <option value="compact">紧凑</option>
            <option value="regular">标准</option>
            <option value="spacious">宽松</option>
          </select>
        </div>
        <div class="preview ${this.previewTheme} ${this.previewDensity}">
          ${component.category === 'Forms'
            ? html`<label style="width:100%"><span style="display:block;font-size:12px;margin-bottom:6px">${component.properties.find((item) => item.name === 'label')?.defaultValue ?? '字段标签'}</span><input style="width:100%;padding:10px;border:1px solid #888;border-radius:8px" placeholder="输入内容" /></label>`
            : html`<button class="demo-button">${component.properties.find((item) => item.name === 'label')?.defaultValue ?? component.name}</button>`}
        </div>
      </section>
    `;
  }

  private renderValidation(issues: ValidationIssue[]): TemplateResult {
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>规范检查</h2>
          <sp-button size="s" variant="secondary" @click=${() => { this.showValidation = !this.showValidation; }}>${this.showValidation ? '收起' : '展开'}</sp-button>
        </div>
        ${this.showValidation ? (issues.length ? issues.map((issue) => html`
          <div class="issue ${issue.level}"><strong>${issue.target}</strong>${issue.message}</div>
        `) : html`<div class="issue info"><strong>当前组件通过检查</strong>没有发现属性、示例或无障碍说明问题。</div>`) : nothing}
      </section>
    `;
  }

  private get filteredComponents(): ComponentSpec[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.store.state.components;
    return this.store.state.components.filter((component) => JSON.stringify(component).toLowerCase().includes(query));
  }

  private hasStaleExamples(component: ComponentSpec): boolean {
    return component.examples.some((example) => example.stale);
  }

  private statusLabel(status: ComponentSpec['status']): string {
    return { draft: '草稿', review: '待审', published: '已发布' }[status];
  }

  private async copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      this.flash('代码已复制');
    } catch {
      this.flash('复制失败，请手动选择代码');
    }
  }

  private flash(message: string) {
    this.toast = message;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast = ''; }, 3000);
  }
}

customElements.define('spec-a11y-workbench', SpecA11yWorkbench);
