/**
 * 自动更新模块
 *
 * 与 PRD §11.3 对齐：
 * - 启动时 + 每 24 小时检查一次（可通过对话框开关关闭）
 * - 后台下载 → 提示安装 → 重启生效
 * - 离线 / 端点不可用时静默跳过，不打扰用户
 * - 检查仅请求版本信息，不发送任何用户数据
 *
 * 模块自包含（原生 DOM 对话框），不依赖组件树，便于独立维护。
 */
import { check, type Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';

const ENABLED_KEY = 'slp.updater.enabled';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 6000;
const CHECK_TIMEOUT_MS = 15000;

let activeUpdater: Update | null = null;
let dialogEl: HTMLElement | null = null;
let previousFocus: HTMLElement | null = null;
let checking = false;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 自动检查开关（默认开启），存储于 localStorage */
export function isAutoUpdateEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** 启动时 + 每 24 小时调度一次静默检查 */
export function initAutoUpdater(): void {
  if (!isTauri()) return;
  window.setTimeout(() => void runAutoCheck(), STARTUP_DELAY_MS);
  window.setInterval(() => void runAutoCheck(), CHECK_INTERVAL_MS);
}

async function runAutoCheck(): Promise<void> {
  if (!isAutoUpdateEnabled() || checking) return;
  // 离线时不检查、不弹窗
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const update = await checkForUpdates();
  if (update) showUpdateDialog(update);
}

/** 手动检查一次，返回可用更新（无更新或失败返回 null） */
export async function checkForUpdates(): Promise<Update | null> {
  checking = true;
  try {
    return await check({ timeout: CHECK_TIMEOUT_MS });
  } catch (err) {
    // 离线 / 端点不可用：静默失败
    console.info('[updater] check failed:', err);
    return null;
  } finally {
    checking = false;
  }
}

/** 立即重装后重启应用（后端命令） */
export function restartApp(): void {
  void invoke('restart_app');
}

// ---------------------------------------------------------------------------
// 更新对话框（原生 DOM，样式与 .modal 系列一致）
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: 'prompt' }
  | { kind: 'downloading'; received: number }
  | { kind: 'failed'; message: string }
  | { kind: 'ready' };

function trapUpdateDialogFocus(event: KeyboardEvent): void {
  if (!dialogEl || event.key !== 'Tab') return;
  const items = [...dialogEl.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((item) => item.offsetParent !== null);
  if (items.length === 0) {
    event.preventDefault();
    dialogEl.querySelector<HTMLElement>('.update-dialog')?.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function showUpdateDialog(update: Update): void {
  if (dialogEl) return;
  activeUpdater = update;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '300';
  overlay.addEventListener('keydown', trapUpdateDialogFocus);
  dialogEl = overlay;
  document.body.appendChild(overlay);
  render();
}

function render(): void {
  if (!dialogEl || !activeUpdater) return;
  const u = activeUpdater;
  const state = cachedState;

  const stateBody =
    state.kind === 'downloading'
      ? `<div class="update-progress"><div class="progress-track"><div class="progress-fill is-indeterminate"></div></div>
         <div class="update-progress-label" id="update-progress-label">正在后台下载更新…（0.0 MB）</div></div>`
      : state.kind === 'failed'
        ? `<div class="update-error">下载失败：${escapeHtml(state.message)}</div>
           <div class="update-actions">
             <button class="btn" data-act="later">稍后</button>
             <button class="btn primary" data-act="retry">重试</button>
           </div>`
        : state.kind === 'ready'
          ? `<div class="update-actions">
               <button class="btn" data-act="later">稍后</button>
               <button class="btn primary" data-act="restart">立即重启</button>
             </div>`
          : `<p class="update-body">${escapeHtml(u.body ?? '更新内容说明未提供。')}</p>
             <div class="update-actions">
               <button class="btn" data-act="later">稍后</button>
               <button class="btn primary" data-act="install">立即安装</button>
             </div>`;

  dialogEl.innerHTML = `
    <div class="modal update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" tabindex="-1">
      <h3 id="update-dialog-title">发现新版本</h3>
      <div class="update-meta">
        当前 v${escapeHtml(u.currentVersion)} → <strong>v${escapeHtml(u.version)}</strong>
      </div>
      ${stateBody}
      <label class="update-toggle">
        <input type="checkbox" data-act="toggle" ${isAutoUpdateEnabled() ? 'checked' : ''} />
        自动检查更新
      </label>
    </div>`;

  dialogEl.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', () => onAction(el.dataset.act ?? '', el as HTMLInputElement));
  });

  if (!dialogEl.contains(document.activeElement)) {
    requestAnimationFrame(() => {
      const first = dialogEl?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])');
      (first ?? dialogEl?.querySelector<HTMLElement>('.update-dialog'))?.focus();
    });
  }
}

// 简单状态缓存，避免在异步回调中丢失
let cachedState: DialogState = { kind: 'prompt' };

function onAction(act: string, el?: HTMLInputElement): void {
  if (!dialogEl || !activeUpdater) return;
  if (act === 'toggle') {
    setAutoUpdateEnabled(el?.checked ?? false);
    return;
  }
  if (act === 'later') {
    closeDialog();
    return;
  }
  if (act === 'install' || act === 'retry') {
    void startInstall();
    return;
  }
  if (act === 'restart') {
    restartApp();
  }
}

async function startInstall(): Promise<void> {
  if (!activeUpdater) return;
  cachedState = { kind: 'downloading', received: 0 };
  // 首次进入下载状态时整体渲染一次（含进度条骨架），此后仅热更新进度文本
  if (!dialogEl?.querySelector('.update-progress')) render();
  const u = activeUpdater;
  // downloadAndInstall 内建进度校验，失败则回滚后抛错，不会破坏现有安装
  void u
    .downloadAndInstall((ev) => {
      if (ev.event === 'Progress') {
        const prev = cachedState.kind === 'downloading' ? cachedState.received : 0;
        cachedState = {
          kind: 'downloading',
          received: prev + ev.data.chunkLength / (1024 * 1024),
        };
        const label = dialogEl?.querySelector<HTMLElement>('#update-progress-label');
        if (label) {
          label.textContent = `正在后台下载更新…（${cachedState.received.toFixed(1)} MB）`;
        }
      }
    })
    .then(() => {
      cachedState = { kind: 'ready' };
      render();
    })
    .catch((err) => {
      cachedState = { kind: 'failed', message: String(err) };
      render();
    });
}

function closeDialog(): void {
  if (dialogEl) {
    dialogEl.removeEventListener('keydown', trapUpdateDialogFocus);
    dialogEl.remove();
    dialogEl = null;
  }
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
  activeUpdater = null;
  cachedState = { kind: 'prompt' };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] as string);
}