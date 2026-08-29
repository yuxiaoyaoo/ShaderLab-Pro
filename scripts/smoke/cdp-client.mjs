const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPageTarget(port, timeoutMs = 240_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && /localhost:1420/.test(target.url))
          ?? targets.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`等待 WebView2 CDP target 超时${lastError ? `：${lastError}` : ''}`);
}

export class CdpClient {
  static async connect(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 WebView2 CDP WebSocket 超时')), 15_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`连接 WebView2 CDP 失败：${event.type}`));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} 失败：${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP 连接已关闭：${pending.method}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 60_000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? JSON.stringify(result.exceptionDetails);
      throw new Error(`WebView smoke 脚本异常：${detail}`);
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}
