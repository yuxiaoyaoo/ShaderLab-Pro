(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (read, label, timeout = 20_000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const value = read();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const pressEscape = (target) => target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  }));
  const buttonByText = (root, pattern) => [...root.querySelectorAll('button')]
    .find((button) => pattern.test(button.textContent?.trim() ?? ''));

  const runtimeErrors = [];
  const onError = (event) => runtimeErrors.push(String(event.error ?? event.message));
  const onRejection = (event) => runtimeErrors.push(String(event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  const initialLocale = document.documentElement.lang;
  const app = await until(() => document.querySelector('.app'), 'application shell');
  await until(() => window.__slp?.updater?.failed && document.querySelector('.monaco-editor'), 'DEV API and Monaco');
  const languageButton = document.querySelector('.rail-language');
  if (document.documentElement.lang !== 'en') {
    languageButton.click();
    await until(() => document.documentElement.lang === 'en', 'English locale');
  }

  const lazy = {};
  const templateButton = document.querySelector('[aria-label="Open template library"]');
  templateButton.click();
  lazy.templates = !!await until(() => document.querySelector('#template-dialog-title'), 'template dialog');
  pressEscape(document.querySelector('[aria-labelledby="template-dialog-title"]'));
  await until(() => !document.querySelector('#template-dialog-title'), 'template dialog close');

  const settingsButton = document.querySelector('[aria-label="Open AI service settings"]');
  settingsButton.click();
  lazy.agentSettings = !!await until(() => document.querySelector('.agent-settings'), 'agent settings');
  pressEscape(document.querySelector('.agent-settings'));
  await until(() => !document.querySelector('.agent-settings'), 'agent settings close');

  const chatButton = document.querySelector('[aria-label="Open AI assistant"]');
  chatButton.click();
  lazy.chat = !!await until(() => document.querySelector('.chat-panel'), 'chat panel');
  document.querySelector('.chat-close').click();
  await until(() => !document.querySelector('.chat-panel'), 'chat panel close');

  const exportButton = await until(() => {
    const button = document.querySelector('[aria-label="Open export settings"]');
    return button && !button.disabled ? button : null;
  }, 'enabled export button', 30_000);
  exportButton.click();
  lazy.export = !!await until(() => document.querySelector('#export-dialog-title'), 'export dialog');
  pressEscape(document.querySelector('[aria-labelledby="export-dialog-title"]'));
  await until(() => !document.querySelector('#export-dialog-title'), 'export dialog close');

  const passButton = document.querySelector('[aria-label="Render pass structure"]');
  passButton.click();
  const passMenu = await until(() => document.querySelector('.pass-pop'), 'pass menu');
  passMenu.querySelector('.btn.primary').click();
  lazy.passGraph = !!await until(() => document.querySelector('.pass-graph-panel'), 'pass graph');
  document.querySelector('.pass-graph-panel header .btn:last-child').click();
  await until(() => !document.querySelector('.pass-graph-panel'), 'pass graph close');

  window.__slp.notify({
    code: 'updater.download-failed',
    rawDetail: 'Authorization: Bearer desktop-smoke-secret C:\\Users\\SmokeUser\\shader.glsl',
  }, 'error');
  const toastDetail = await until(() => document.querySelector('.toast .product-message-detail'), 'safe toast detail');
  const toastSecurity = {
    redacted: toastDetail.textContent.includes('[REDACTED]'),
    secretAbsent: !toastDetail.textContent.includes('desktop-smoke-secret')
      && !toastDetail.textContent.includes('SmokeUser'),
  };

  window.__slp.updater.failed();
  const failedDialog = await until(() => document.querySelector('.update-dialog'), 'failed updater dialog');
  const updaterEn = failedDialog.querySelector('[data-update-error-summary]').textContent.trim();
  const updaterDetail = failedDialog.querySelector('[data-update-error-detail]')?.textContent.trim() ?? '';
  const updaterCode = failedDialog.querySelector('[data-update-error-code]')?.textContent.trim() ?? '';
  languageButton.click();
  await until(() => document.documentElement.lang === 'zh-CN', 'Chinese updater locale');
  const updaterZh = await until(() => {
    const summary = document.querySelector('.update-dialog [data-update-error-summary]')?.textContent.trim() ?? '';
    return summary && summary !== updaterEn ? summary : null;
  }, 'Chinese updater redraw');
  document.querySelector('.update-dialog [data-act="later"]').click();
  await until(() => !document.querySelector('.update-dialog'), 'failed updater close');

  window.__slp.updater.prompt();
  const promptDialog = await until(() => document.querySelector('.update-dialog'), 'prompt updater dialog');
  const promptSafe = promptDialog.textContent.includes('SLP_UPDATER_DEV_SIMULATION');
  promptDialog.querySelector('[data-act="later"]').click();
  await until(() => !document.querySelector('.update-dialog'), 'prompt updater close');

  window.__slp.updater.ready();
  const readyDialog = await until(() => document.querySelector('.update-dialog'), 'ready updater dialog');
  const readyRestart = !!readyDialog.querySelector('[data-act="restart"]');
  readyDialog.querySelector('[data-act="later"]').click();
  await until(() => !document.querySelector('.update-dialog'), 'ready updater close');

  languageButton.click();
  await until(() => document.documentElement.lang === 'en', 'English locale restore');

  if (document.querySelector('.app-decision-dialog')) throw new Error('Unexpected application decision dialog');
  const wasDirty = window.__slp.project.state().dirty;
  const templateRecognized = window.__slp.applyTemplate('graph-gradient');
  if (templateRecognized !== true) throw new Error('Missing built-in template: graph-gradient');
  if (wasDirty) {
    const createDialog = await until(() => document.querySelector('.app-decision-dialog'), 'Graph template confirmation');
    const confirmButton = createDialog.querySelector('button[type="submit"]')
      ?? createDialog.querySelector('.modal-actions button:last-child');
    if (!confirmButton || confirmButton.disabled) throw new Error('Graph template confirmation is unavailable');
    confirmButton.click();
  }
  await until(() => {
    const project = window.__slp.project.state();
    const image = window.__slp.project.passes().image;
    const toolbar = document.querySelector('.graph-toolbar');
    return project.name === 'graph-gradient' && image.authoring?.kind === 'graph' && toolbar;
  }, 'Graph workspace', 30_000);
  const resourceButton = buttonByText(document.querySelector('.graph-toolbar'), /^Resources$/i);
  resourceButton.focus();
  resourceButton.click();
  const resources = await until(() => document.querySelector('.graph-resources-dialog'), 'Graph resources');
  await sleep(100);
  const focusables = [...resources.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null);
  const firstFocusable = focusables[0];
  const lastFocusable = focusables.at(-1);
  lastFocusable.focus();
  lastFocusable.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    bubbles: true,
    cancelable: true,
  }));
  const focusWrapped = document.activeElement === firstFocusable;

  const raymarchButton = buttonByText(resources, /Raymarch/i);
  raymarchButton.click();
  const stackedDecision = await until(() => document.querySelector('.app-decision-dialog'), 'stacked app decision');
  pressEscape(stackedDecision);
  await until(() => !document.querySelector('.app-decision-dialog'), 'stacked app decision close');
  const underlyingModalPreserved = !!document.querySelector('.graph-resources-dialog');
  pressEscape(document.querySelector('.graph-resources-dialog'));
  await until(() => !document.querySelector('.graph-resources-dialog'), 'Graph resources close');
  const focusRestored = document.activeElement === resourceButton;

  const tablist = document.querySelector('.compact-pane-switch');
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const compactTabs = tabs.length === 2
    && tabs.every((tab) => tab.hasAttribute('aria-selected') && tab.hasAttribute('aria-controls'))
    && tabs.filter((tab) => tab.tabIndex === 0).length === 1;

  const topbar = document.querySelector('.topbar');
  const topbarRect = topbar.getBoundingClientRect();
  const interactive = 'button, input, select, textarea, label, a[href], [role="button"], [contenteditable="true"], [data-no-drag], .menu-root, .menu-pop';
  let safePoint = null;
  for (let y = topbarRect.top + 8; y < topbarRect.bottom - 8 && !safePoint; y += 8) {
    for (let x = topbarRect.left + 8; x < topbarRect.right - 150; x += 12) {
      const hit = document.elementFromPoint(x, y);
      if (hit && topbar.contains(hit) && !hit.closest(interactive)) {
        safePoint = { x, y, xRatio: x / innerWidth, yRatio: y / innerHeight };
        break;
      }
    }
  }

  if (initialLocale === 'zh-CN' && document.documentElement.lang !== 'zh-CN') languageButton.click();
  if (initialLocale === 'en' && document.documentElement.lang !== 'en') languageButton.click();
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);

  const result = {
    appMounted: !!app,
    tauri: '__TAURI_INTERNALS__' in window,
    lazy,
    toastSecurity,
    updater: {
      en: updaterEn,
      zh: updaterZh,
      localeRedraw: !!updaterEn && !!updaterZh && updaterEn !== updaterZh,
      detail: updaterDetail,
      code: updaterCode,
      promptSafe,
      readyRestart,
    },
    accessibility: {
      focusWrapped,
      focusRestored,
      underlyingModalPreserved,
      compactTabs,
    },
    topbarSafePoint: safePoint,
    runtimeErrors,
  };
  result.passed = result.appMounted
    && result.tauri
    && Object.values(lazy).every(Boolean)
    && toastSecurity.redacted
    && toastSecurity.secretAbsent
    && result.updater.localeRedraw
    && updaterDetail.includes('SLP_UPDATER_DEV_SIMULATION_FAILURE')
    && updaterCode === 'updater.download-failed'
    && promptSafe
    && readyRestart
    && focusWrapped
    && focusRestored
    && underlyingModalPreserved
    && compactTabs
    && !!safePoint
    && runtimeErrors.length === 0;
  return result;
})()
