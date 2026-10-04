/**
 * tools/cdp.mjs —— 极简 Chrome DevTools Protocol 客户端（零依赖）
 *
 * 只做四件事：连浏览器、开标签页、在页面里求值、关标签页。
 * 不引 puppeteer 的理由：这个项目全程零 npm 依赖，为了开两个标签页装一整套
 * 浏览器自动化框架，与「轻量可控」这条底线冲突。CDP 本来就是纯 JSON-RPC，
 * Node 22 自带 WebSocket —— 需要的全部就这些。
 */

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 等 CDP 的 HTTP 端点起来，返回 browser 级 WebSocket 地址 */
export async function browserWs(port = 9222, timeoutMs = 20000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return { url: j.webSocketDebuggerUrl, ver: j.Browser };
    } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error('Chrome CDP 端口 ' + port + ' 没起来（' + last + '）');
}

export class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.waits = new Map(); }

  static async connect(port = 9222) {
    const { url, ver } = await browserWs(port);
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket 连接失败: ' + url));
    });
    const c = new CDP(ws);
    c.browserVersion = ver;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id);
        c.waits.delete(m.id);
        if (m.error) rej(new Error(m.error.message + ' (' + m.method + ')'));
        else res(m.result);
      }
    };
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.waits.has(id)) { this.waits.delete(id); rej(new Error('CDP 调用超时: ' + method)); }
      }, 20000);
    });
  }

  /** 开一个真标签页，返回可寻址的会话 */
  async openPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }

  /** 在页面里求值（支持 await Promise） */
  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面里抛错: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result && r.result.value;
  }

  /** 轮询直到表达式返回真值，返回 { value, waitedMs } */
  async waitFor(sessionId, expression, timeoutMs = 20000, everyMs = 250) {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < timeoutMs) {
      v = await this.evaluate(sessionId, expression);
      if (v) return { value: v, waitedMs: Date.now() - t0 };
      await sleep(everyMs);
    }
    throw new Error('等待超时（' + timeoutMs + 'ms）: ' + expression + ' —— 最后取值 ' + JSON.stringify(v));
  }

  async closePage(targetId) { try { await this.send('Target.closeTarget', { targetId }); } catch {} }
  disconnect() { try { this.ws.close(); } catch {} }
}
