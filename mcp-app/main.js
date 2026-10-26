// The panel's host for MCP Apps hosts (ChatGPT web and desktop, the Codex app, Claude conversations): the
// host proxies tools/call to the AiNecto MCP server with the user's own connection (bridge.js). Built into
// mcp-app/dist/ainecto-panel.html, which ainecto-api serves as ui://ainecto/panel.
import { createBridge, initializeParams } from './bridge.js';
import { startPanel } from './panel.js';
import { contextText } from '../plugins/ainecto-panel/hooks/inbox.js';

const VERSION = '0.1.0';

const bridge = createBridge({
  post: (message) => window.parent.postMessage(message, '*'),
  listen: (onMessage) =>
    window.addEventListener('message', (event) => {
      if (event.source === window.parent) onMessage(event.data);
    }),
  log: (line) => console.warn(`[ainecto-panel] ${line}`),
});

/** Theme and style variables the host sends. */
function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme === 'light' || ctx.theme === 'dark') {
    document.documentElement.dataset.theme = ctx.theme;
    document.documentElement.style.colorScheme = ctx.theme;
  }
  const vars = ctx.styles?.variables;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
    }
  }
}

function reportSize() {
  let last = '';
  let queued = false;
  // The content's own size (the body), not the viewport: a host with a flexible height sizes the frame to it.
  const send = () => {
    queued = false;
    const box = document.body.getBoundingClientRect();
    const width = Math.ceil(box.width);
    const height = Math.ceil(box.height);
    const key = `${width}x${height}`;
    if (key === last) return;
    last = key;
    bridge.notify('ui/notifications/size-changed', { width, height });
  };
  new ResizeObserver(() => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(send);
    }
  }).observe(document.body);
}

startPanel({
  async connect({ showToolResult, stop }) {
    bridge.onNotification('ui/notifications/tool-result', showToolResult);
    bridge.onNotification('ui/notifications/host-context-changed', (ctx) => applyHostContext(ctx));
    bridge.onRequest('ui/resource-teardown', () => {
      stop();
      return {};
    });
    bridge.onRequest('ping', () => ({}));
    const init = await bridge.request('ui/initialize', initializeParams(VERSION));
    applyHostContext(init?.hostContext);
    bridge.notify('ui/notifications/initialized', {});
    reportSize();
    return { name: init?.hostInfo?.name ?? '' };
  },
  callTool: (name, args) => bridge.request('tools/call', { name, arguments: args }),
  async openLink(url) {
    try {
      await bridge.request('ui/open-link', { url });
    } catch (err) {
      console.warn(`[ainecto-panel] ui/open-link refused: ${err?.message ?? err}`);
      window.open(url, '_blank', 'noopener');
    }
  },
  sendToClaude: (ctx) => bridge.request('ui/message', { role: 'user', content: { type: 'text', text: contextText(ctx) } }).then(() => 'staged'),
});
