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
