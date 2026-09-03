import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, waitForPageTarget } from './cdp-client.mjs';

const execFileAsync = promisify(execFile);
const smokeDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(smokeDirectory, '..', '..');
const port = Number(process.env.CDP_PORT || 9400 + (process.pid % 200));
const attach = process.env.SMOKE_ATTACH === '1';
const logTail = [];
let child;
let cdp;

function rememberLog(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue;
    logTail.push(line);
    if (logTail.length > 120) logTail.shift();
  }
}

async function stopProcessTree(childProcess) {
  if (!childProcess || childProcess.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(childProcess.pid), '/T', '/F'], {
        windowsHide: true,
      });
    } catch {
      // The Tauri process may already have stopped itself.
    }
  } else {
    childProcess.kill('SIGTERM');
  }
}

async function runWindowDriver(action, extra = []) {
  const script = join(smokeDirectory, 'window-driver.ps1');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Action', action,
    ...extra,
  ], {
    cwd: root,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const json = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(json);
}

async function waitForStableApplication(client, timeoutMs = 60_000) {
  const started = Date.now();
  let stableSince = 0;
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await client.evaluate(
        `document.readyState === 'complete' && !!document.querySelector('.app')`,
        5_000,
      );
      if (ready) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1_000) return;
      } else {
        stableSince = 0;
      }
    } catch (error) {
      // The first Vite navigation can replace WebView2's execution context.
      lastError = error;
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待稳定的应用页面超时${lastError ? `：${lastError}` : ''}`);
}

const narrowSmokeExpression = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (read, timeout = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = read();
      if (value) return value;
      await sleep(50);
    }
    return null;
  };
  const controls = [...document.querySelectorAll('.win-btn')];
  const controlRects = controls.map((button) => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, visible: getComputedStyle(button).display !== 'none' };
  });
  const tablist = document.querySelector('.compact-pane-switch');
  const resourcesButton = [...document.querySelectorAll('.graph-toolbar button')]
    .find((button) => /Resources|资源/i.test(button.textContent || ''));
  resourcesButton?.click();
  const resources = await until(() => document.querySelector('.graph-resources-dialog'));
  const grid = resources?.querySelector('.graph-resource-grid');
  const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length : 0;
  const result = {
    viewport: [innerWidth, innerHeight],
    controls: controlRects,
    controlsInside: controls.length === 3 && controlRects.every((rect) => rect.visible && rect.width > 0 && rect.left >= -1 && rect.right <= innerWidth + 1),
    compactTabsVisible: !!tablist && getComputedStyle(tablist).display !== 'none',
    resourcesOpen: !!resources,
    resourceColumns: columns,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
  };
  if (resources) resources.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  result.passed = result.viewport[0] === 520
    && result.controlsInside
    && result.compactTabsVisible
    && result.resourcesOpen
    && result.resourceColumns === 1
    && !result.horizontalOverflow;
  return result;
})()`;

try {
  if (process.platform !== 'win32') {
    throw new Error('smoke:desktop 当前使用 Win32 物理窗口驱动，仅支持 Windows');
  }

  if (!attach) {
    const browserArguments = [
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      `--remote-debugging-port=${port}`,
    ].filter(Boolean).join(' ');
    const commandShell = process.env.ComSpec || 'cmd.exe';
    child = spawn(commandShell, ['/d', '/s', '/c', 'npm.cmd run tauri -- dev'], {
      cwd: root,
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', rememberLog);
    child.stderr.on('data', rememberLog);
  }

  const target = await waitForPageTarget(port);
  cdp = await CdpClient.connect(target);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitForStableApplication(cdp);

  // 画廊启动分流（画廊功能）：smoke 环境无历史会话，桌面端启动会自动打开作品库
  // 遮罩（fixed 定位、z-index 210 盖住整个窗口）。browser-smoke 的 topbarSafePoint
  // 依赖 document.elementFromPoint 命中顶栏元素，遮罩不关会误判失败——这里点画廊
  // 里的“新建项目”关闭画廊并重置到默认项目（等同 File 菜单新建）。
  const galleryDismiss = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (read, timeout = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = read();
        if (value) return value;
        await sleep(50);
      }
      return null;
    };
    const overlay = await until(() => document.querySelector('.gallery-overlay'), 4000);
    if (!overlay) return { present: false };
    const newButton = overlay.querySelector('.gallery-new');
    if (!newButton) return { present: true, ok: false, reason: 'gallery-new-missing' };
    newButton.click();
    const dialog = await until(() => document.querySelector('.app-decision-overlay'), 1500);
    if (dialog) {
      const confirmButton = dialog.querySelector('button[type="submit"]');
      if (!confirmButton) return { present: true, ok: false, reason: 'unsaved-confirm-missing' };
      confirmButton.click();
    }
    if (!await until(() => !document.querySelector('.gallery-overlay'))) {
      return { present: true, ok: false, reason: 'gallery-still-open' };
    }
    await sleep(400);
    return { present: true, ok: true };
  })()`, 15_000);
  assert.equal(galleryDismiss.ok !== false, true, `关闭启动画廊失败：${JSON.stringify(galleryDismiss)}`);

  const browserExpression = readFileSync(join(smokeDirectory, 'browser-smoke.js'), 'utf8');
  const browser = await cdp.evaluate(browserExpression, 120_000);
  assert.equal(browser.passed, true, `浏览器 smoke 失败：${JSON.stringify(browser, null, 2)}`);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 520,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const narrow = await cdp.evaluate(narrowSmokeExpression, 30_000);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  assert.equal(narrow.passed, true, `520px 窄窗 smoke 失败：${JSON.stringify(narrow, null, 2)}`);

  // --- 键盘 iKeyboard 端到端（设计 §7.3）：CDP 按键 → 悬停采集 → 256×2 数据纹理上传 ---
  // 先重置到默认项目：避免上次会话遗留的 graph 编排模式/通道状态让 setCodeChannel
  // 静默失效（graph 模式下 setCodeChannel 直接 return）。
  // 画廊分流：若作品库仍开着（无会话启动的自动弹出），点画廊里的“新建项目”；
  // 否则走 File 菜单“新建项目”。两条路径在未保存改动时都会弹确认框，点确认。
  // 注意不走 location.reload()——导航会打断 CDP 执行上下文且旧 WebSocket 可能假死。
  const kbReset = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (read, timeout = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = read();
        if (value) return value;
        await sleep(50);
      }
      return null;
    };
    const confirmUnsaved = async () => {
      const dialog = await until(() => document.querySelector('.app-decision-overlay'), 1500);
      if (!dialog) return true;
      const confirmButton = dialog.querySelector('button[type="submit"]');
      if (!confirmButton) return false;
      confirmButton.click();
      return true;
    };
    const gallery = document.querySelector('.gallery-overlay');
    let viaGallery = false;
    if (gallery) {
      viaGallery = true;
      const galleryNew = await until(() => gallery.querySelector('.gallery-new'), 4000);
      if (!galleryNew) return { ok: false, reason: 'gallery-new-missing' };
      galleryNew.click();
      if (!await confirmUnsaved()) return { ok: false, reason: 'unsaved-confirm-missing' };
      if (!await until(() => !document.querySelector('.gallery-overlay'))) {
        return { ok: false, reason: 'gallery-still-open' };
      }
    } else {
      const menuButton = [...document.querySelectorAll('.rail-btn')]
        .find((button) => /项目|project/i.test(button.getAttribute('aria-label') || button.getAttribute('title') || ''));
      if (!menuButton) return { ok: false, reason: 'file-menu-button-missing' };
      menuButton.click();
      const pop = await until(() => document.querySelector('.menu-pop'));
      if (!pop) return { ok: false, reason: 'file-menu-pop-missing' };
      const newItem = pop.querySelector('.menu-item');
      if (!newItem) return { ok: false, reason: 'new-project-item-missing' };
      newItem.click();
      if (!await confirmUnsaved()) return { ok: false, reason: 'unsaved-confirm-missing' };
    }
    const ready = await until(() => document.querySelector('.preview-pane canvas') && document.querySelectorAll('.rail-btn').length > 0, 10000);
    if (!ready) return { ok: false, reason: 'app-not-ready-after-new-project' };
    await sleep(800);
    return { ok: true, viaGallery };
  })()`, 20_000);
  assert.equal(kbReset.ok, true, `重置到默认项目失败：${JSON.stringify(kbReset)}`);

  // 钩住 texSubImage2D 捕获 256×2 键盘纹理上传（音频纹理是 512×2，不会混淆）。
  await cdp.evaluate(`(() => {
    window.__kbdUploads = [];
    const proto = WebGL2RenderingContext.prototype;
    const orig = proto.texSubImage2D;
    proto.texSubImage2D = function (...args) {
      try {
        const width = args[4];
        const height = args[5];
        const pixels = args[8];
        if (width === 256 && height === 2 && pixels && pixels.length) {
          const copy = new Uint8Array(pixels.length);
          copy.set(pixels);
          window.__kbdUploads.push(copy);
          if (window.__kbdUploads.length > 60) window.__kbdUploads.shift();
        }
      } catch { /* 采样失败不影响渲染 */ }
      return orig.apply(this, args);
    };
    return true;
  })()`);

  // 打开 Pass 菜单，把 Image ch0 指到 KB 通道（真实 UI 链路：select change → setCodeChannel → 重编译）。
  const kbAssign = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (read, timeout = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = read();
        if (value) return value;
        await sleep(50);
      }
      return null;
    };
    // 按 title/aria-label 双语匹配定位 Pass 菜单按钮（aria-expanded 会误中文件菜单按钮）。
    const railButton = [...document.querySelectorAll('.rail-btn')]
      .find((button) => /pass/i.test(button.getAttribute('aria-label') || button.getAttribute('title') || ''));
    if (!railButton) return { ok: false, reason: 'pass-menu-button-missing' };
    railButton.click();
    const pop = await until(() => document.querySelector('.pass-pop'));
    if (!pop) return { ok: false, reason: 'pass-pop-missing' };
    const select = pop.querySelector('.pass-ch select');
    if (!select) return { ok: false, reason: 'channel-select-missing' };
    if (![...select.options].some((option) => option.value === 'keyboard')) {
      return { ok: false, reason: 'keyboard-option-missing', options: [...select.options].map((option) => option.value) };
    }
    select.value = 'keyboard';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    railButton.click();
    return { ok: true, selectValue: select.value };
  })()`, 15_000);
  assert.equal(kbAssign.ok, true, `分配 KB 通道失败：${JSON.stringify(kbAssign)}`);

  // 等待编译生效：键盘纹理被创建后每帧上传，出现首个 256×2 上传即代表编译通过。
  const kbCompiled = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if ((window.__kbdUploads ?? []).length > 0) return { ok: true, uploads: window.__kbdUploads.length };
      await sleep(100);
    }
    return { ok: false, uploads: 0 };
  })()`, 20_000);
  assert.equal(kbCompiled.ok, true, `键盘纹理未开始上传（编译未生效）：${JSON.stringify(kbCompiled)}`);

  // 悬停画布（CDP 可信鼠标事件触发 pointerenter，满足悬停采集门控）。
  const canvasPoint = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.preview-pane canvas') ?? document.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  assert.ok(canvasPoint, '预览画布不存在');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: canvasPoint.x, y: canvasPoint.y, buttons: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 按下 'A'：keydown 帧的上传里 row0[65]（本帧按下边沿）与 row1[65]（切换锁存）同为 255；
  // 运行时在每次 draw() 末尾清 row0（Shadertoy iKeyboard 边沿语义），所以边沿只存在于
  // keydown 后的第一帧上传中 —— 需扫描环形缓冲找边沿帧，再用最后一帧验证锁存保留。
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA',
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a',
  });
  const kbDown = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    let edgeSeen = false;
    let steady = false;
    while (Date.now() - started < 5000) {
      const uploads = window.__kbdUploads ?? [];
      if (!edgeSeen) {
        edgeSeen = uploads.some((u) => u[65] === 255 && u[256 + 65] === 255);
        if (!edgeSeen) { await sleep(20); continue; }
      }
      // 边沿帧之后：等下一帧上传确认 row0 被清、row1 锁存保留（稳态）。
      const last = uploads.at(-1);
      if (last && last[65] === 0 && last[256 + 65] === 255) { steady = true; break; }
      await sleep(20);
    }
    const last = (window.__kbdUploads ?? []).at(-1);
    return {
      ok: edgeSeen && steady,
      edgeSeen,
      steady,
      keyA: last?.[65],
      toggleA: last?.[256 + 65],
      uploads: (window.__kbdUploads ?? []).length,
    };
  })()`, 10_000);
  assert.equal(kbDown.ok, true, `按下 'A' 后键盘纹理未反映按下状态：${JSON.stringify(kbDown)}`);

  // 松开 'A'：切换锁存 row1[65] 应回落为 0（row0 边沿在松开前就已随帧清零）。
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA',
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  const kbUp = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const uploads = window.__kbdUploads ?? [];
      const last = uploads.at(-1);
      if (last && last[256 + 65] === 0) return { ok: true, uploads: uploads.length };
      await sleep(50);
    }
    const last = (window.__kbdUploads ?? []).at(-1);
    return { ok: false, keyA: last?.[65], toggleA: last?.[256 + 65], uploads: (window.__kbdUploads ?? []).length };
  })()`, 10_000);
  assert.equal(kbUp.ok, true, `松开 'A' 后键盘纹理切换行未清零：${JSON.stringify(kbUp)}`);

  // 按住 'B' 不松开（held 状态）：keydown 帧上传含 row0[66]=255 边沿（下一帧即被清），
  // 锁存 row1[66]=255 持续保留 —— 边沿帧扫描环形缓冲验证，稳态用最后一帧验证。
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'b', code: 'KeyB',
    windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, text: 'b', unmodifiedText: 'b',
  });
  const kbHeld = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    let edgeSeen = false;
    let steady = false;
    while (Date.now() - started < 5000) {
      const uploads = window.__kbdUploads ?? [];
      if (!edgeSeen) {
        edgeSeen = uploads.some((u) => u[66] === 255 && u[256 + 66] === 255);
        if (!edgeSeen) { await sleep(20); continue; }
      }
      // 边沿帧之后：等下一帧上传确认 row0 被清、row1 锁存保留（held 稳态）。
      const last = uploads.at(-1);
      if (last && last[66] === 0 && last[256 + 66] === 255) { steady = true; break; }
      await sleep(20);
    }
    const last = (window.__kbdUploads ?? []).at(-1);
    return {
      ok: edgeSeen && steady,
      edgeSeen,
      steady,
      keyB: last?.[66],
      toggleB: last?.[256 + 66],
    };
  })()`, 10_000);
  assert.equal(kbHeld.ok, true, `按住 'B' 后键盘纹理未反映 held 状态：${JSON.stringify(kbHeld)}`);

  // 鼠标移出画布：悬停采集解除触发 releaseHeld，清 held 键锁存 row1[66] → 0
  // （row0 本就在稳态上传中为 0，无需断言）。
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  const kbLeave = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const uploads = window.__kbdUploads ?? [];
      const last = uploads.at(-1);
      if (last && last[256 + 66] === 0) return { ok: true };
      await sleep(50);
    }
    const last = (window.__kbdUploads ?? []).at(-1);
    return { ok: false, keyB: last?.[66], toggleB: last?.[256 + 66] };
  })()`, 10_000);
  assert.equal(kbLeave.ok, true, `移出画布后 held 键未释放：${JSON.stringify(kbLeave)}`);

  const point = browser.topbarSafePoint;
  await cdp.evaluate(`(() => {
    window.__slpWindowSmokeEvents = [];
    for (const type of ['mousedown', 'mousemove', 'mouseup']) {
      window.addEventListener(type, (event) => {
        if (type === 'mousemove' && (event.buttons & 1) === 0) return;
        if (window.__slpWindowSmokeEvents.length >= 80) window.__slpWindowSmokeEvents.shift();
        window.__slpWindowSmokeEvents.push({
          type,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          buttons: event.buttons,
          target: event.target instanceof Element ? event.target.className : '',
        });
      }, true);
    }
    return true;
  })()`);
  const windowResult = await runWindowDriver('DragFromMaximized', [
    '-StartXRatio', String(point.xRatio),
    '-StartYRatio', String(point.yRatio),
  ]);
  const inputEvents = await cdp.evaluate('window.__slpWindowSmokeEvents ?? []');
  const windowEvidence = JSON.stringify({ windowResult, inputEvents });
  assert.equal(windowResult.restored, true, `从最大化窗口拖动后未还原：${windowEvidence}`);
  assert.equal(windowResult.moved, true, `从最大化窗口拖动后位置未变化：${windowEvidence}`);
  assert.equal(windowResult.sizePreserved, true, `从最大化窗口拖动后普通窗口尺寸未保持：${windowEvidence}`);

  const result = {
    environment: {
      platform: process.platform,
      runtime: 'Tauri WebView2',
      cdpPort: port,
      attached: attach,
    },
    browser,
    narrow,
    keyboard: {
      reset: kbReset,
      assign: kbAssign,
      compiled: kbCompiled,
      keyDown: kbDown,
      keyUp: kbUp,
      held: kbHeld,
      leaveRelease: kbLeave,
    },
    window: { ...windowResult, inputEvents },
    passed: true,
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  if (logTail.length) {
    console.error('\n--- Tauri smoke log tail ---');
    console.error(logTail.join('\n'));
  }
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (!attach) await stopProcessTree(child);
}
