// Shared browser code: AI connections, model calls, and small page helpers.
// Keys live in this browser only. Calls go straight from here to the provider.

const STORE = 'mohora.ai';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csrf = () => $('meta[name="csrf"]')?.content || '';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function toast(message, bad = false) {
  const box = $('.toasts');
  if (!box) return;
  const item = el('div', { class: bad ? 'toast bad' : 'toast', role: bad ? 'alert' : 'status', text: message });
  box.append(item);
  setTimeout(() => item.remove(), bad ? 8000 : 3500);
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? 'Some fields are invalid.' : data.detail;
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  return data;
}

export function track(name, props = {}) {
  api('/api/events', { method: 'POST', body: { name, props } }).catch(() => {});
}

// Prompt templates use {name} placeholders and {{ }} for literal braces, like Python's str.format.
export function fill(template, vars) {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, key) => (m === '{{' ? '{' : m === '}}' ? '}' : String(vars[key] ?? '')));
}

// Models sometimes wrap JSON in prose or code fences, so fall back to the outermost {...}.
export function parseJSON(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ providers

export const PROVIDERS = [
  {
    id: 'openrouter', group: 'account', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', relay: true,
    blurb: 'One sign-in for GPT, Claude, Gemini, Llama, DeepSeek and free models.',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'puter', group: 'account', name: 'Puter', beta: true,
    blurb: 'Free account, no key. Use GPT, Claude or Gemini; usage counts against your Puter account.',
  },
  {
    id: 'chatgpt', group: 'account', name: 'ChatGPT', soon: true,
    blurb: 'Use your Plus or Pro plan. Waiting for OpenAI to open plan sign-in to this site.',
  },
  {
    id: 'gemini', group: 'key', name: 'Google Gemini', free: true, relay: true,
    base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Free key with your Google account.',
    how: ['Open Google AI Studio and sign in.', 'Click “Create API key”.', 'Copy the key and paste it below.'],
  },
  {
    id: 'groq', group: 'key', name: 'Groq', free: true, relay: true,
    base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys',
    blurb: 'Free key, very fast open models.',
    how: ['Sign in at console.groq.com.', 'Open API Keys and create one.', 'Paste it below.'],
  },
  {
    id: 'openai', group: 'key', name: 'OpenAI', relay: true,
    base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'GPT models. Needs API credit; a ChatGPT subscription doesn’t include it.',
    how: ['Open platform.openai.com/api-keys.', 'Create a secret key.', 'Paste it below.'],
  },
  {
    id: 'anthropic', group: 'key', name: 'Anthropic', api: 'anthropic', relay: true,
    base: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude models. Needs API credit.',
    how: ['Open the Anthropic Console.', 'Go to API Keys and create one.', 'Paste it below.'],
  },
  { id: 'deepseek', group: 'key', name: 'DeepSeek', relay: true, base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', blurb: 'Low-cost models.' },
  { id: 'mistral', group: 'key', name: 'Mistral', relay: true, base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', blurb: 'Free tier available.' },
  { id: 'xai', group: 'key', name: 'xAI', relay: true, base: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', blurb: 'Grok models.' },
  { id: 'cerebras', group: 'key', name: 'Cerebras', free: true, relay: true, base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', blurb: 'Free tier, fast open models.' },
  { id: 'custom', group: 'key', name: 'Other server', custom: true, base: '', blurb: 'Any OpenAI-compatible API: Together, Fireworks, vLLM, your own.' },
  {
    id: 'ollama', group: 'local', name: 'Ollama', local: true, base: 'http://localhost:11434/v1',
    blurb: 'Free, runs on your computer.',
    how: ['Install Ollama and get a model, for example: ollama pull llama3.2', 'Let this site talk to it: set OLLAMA_ORIGINS to {origin} and restart Ollama.', 'Click Connect.'],
  },
  {
    id: 'lmstudio', group: 'local', name: 'LM Studio', local: true, base: 'http://localhost:1234/v1',
    blurb: 'Free, runs on your computer.',
    how: ['Load a model and open the Developer tab.', 'Start the server and turn on “Enable CORS”.', 'Click Connect.'],
  },
];

export const provider = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS.find((p) => p.id === 'custom');
export const describe = (conn) => `${conn.label || provider(conn.provider).name}${conn.model ? `, ${conn.model}` : ''}`;

function readStore(storage) {
  try {
    return JSON.parse(storage.getItem(STORE) || '{}');
  } catch {
    return {};
  }
}

function loadState() {
  const kept = readStore(localStorage);
  const temp = readStore(sessionStorage);
  return { connections: [...(kept.connections || []), ...(temp.connections || [])], active: temp.active || kept.active || null };
}

function saveState(state) {
  const pick = (remember) => ({ connections: state.connections.filter((c) => !!c.remember === remember), active: state.active });
  try {
    localStorage.setItem(STORE, JSON.stringify(pick(true)));
    sessionStorage.setItem(STORE, JSON.stringify(pick(false)));
  } catch {}
  window.dispatchEvent(new CustomEvent('ai-change'));
}

export const connections = () => loadState().connections;

export function activeConnection() {
  const state = loadState();
  return state.connections.find((c) => c.id === state.active) || state.connections[0] || null;
}

export function saveConnection(conn) {
  const state = loadState();
  const i = state.connections.findIndex((c) => c.id === conn.id);
  if (i >= 0) state.connections[i] = conn;
  else state.connections.push(conn);
  state.active = conn.id;
  saveState(state);
}

function removeConnection(id) {
  const state = loadState();
  state.connections = state.connections.filter((c) => c.id !== id);
  if (state.active === id) state.active = state.connections[0]?.id || null;
  saveState(state);
}

function setActive(id) {
  const state = loadState();
  state.active = id;
  saveState(state);
}

function newConnection(providerId, fields = {}) {
  return { id: crypto.randomUUID(), provider: providerId, key: '', base: '', model: '', coachModel: '', remember: true, relay: false, ...fields };
}

// ------------------------------------------------------------------ model calls

export class AIError extends Error {
  constructor(message, kind = 'request', status = 0, detail = '') {
    super(message);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

const baseUrl = (conn) => (conn.base || provider(conn.provider).base || '').replace(/\/+$/, '');

async function request(conn, path, payload, method = 'POST') {
  const p = provider(conn.provider);
  let res;
  try {
    if (conn.relay) {
      res = await fetch('/api/relay', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ provider: conn.provider, path, key: conn.key, payload: method === 'GET' ? null : payload }),
      });
    } else {
      const headers = { 'Content-Type': 'application/json' };
      if (p.api === 'anthropic') {
        headers['x-api-key'] = conn.key;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      } else if (conn.key) {
        headers.Authorization = `Bearer ${conn.key}`;
      }
      if (conn.provider === 'openrouter') {
        headers['HTTP-Referer'] = location.origin;
        headers['X-Title'] = $('meta[name="application-name"]')?.content || 'Mohora';
      }
      res = await fetch(baseUrl(conn) + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(payload) });
    }
  } catch {
    const fix = p.local
      ? 'Check that it is running and allows this site (CORS).'
      : p.relay
        ? 'It may block calls from browsers. Turn on “Route through this site” for this connection.'
        : 'Check the address and that the server allows calls from browsers (CORS).';
    throw new AIError(`Your browser couldn't reach ${p.name}. ${fix}`, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;

  const detail = String(data.error?.message || data.error?.metadata?.raw || data.message || data.detail
    || (typeof data.error === 'string' ? data.error : '') || res.statusText || '');
  const kind = [401, 403].includes(res.status) ? 'auth' : res.status === 429 ? 'quota' : res.status === 404 ? 'model' : res.status >= 500 ? 'server' : 'request';
  const lead = {
    auth: `${p.name} rejected the key.`,
    quota: `${p.name} says you've reached a rate or usage limit. Wait a minute or pick another model.`,
    model: `${p.name} couldn't find that model.`,
    server: `${p.name} had a problem on its side. Try again.`,
    request: `${p.name} refused the request.`,
  }[kind];
  throw new AIError(detail ? `${lead} (${detail.slice(0, 220)})` : lead, kind, res.status, detail.toLowerCase());
}

function mergeRoles(messages) {
  const out = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === m.role && m.role !== 'system') last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

async function completions(conn, body) {
  // Different providers reject different parameters. Drop what they complain about and retry.
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(conn, '/chat/completions', body);
    } catch (err) {
      if (err.status !== 400 || attempt > 3) throw err;
      if (body.response_format && /response_format|json/.test(err.detail)) {
        delete body.response_format;
        conn.noJsonMode = true;
      } else if ('max_tokens' in body && /max_tokens/.test(err.detail)) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      } else if ('temperature' in body && /temperature/.test(err.detail)) {
        delete body.temperature;
      } else {
        throw err;
      }
    }
  }
}

export async function chat(conn, messages, { json = false, model, maxTokens = 700, temperature = 0.7 } = {}) {
  model = model || conn.model;
  messages = mergeRoles(messages);
  if (conn.provider === 'puter') return puterChat(messages, model);
  if (provider(conn.provider).api === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    let rest = messages.filter((m) => m.role !== 'system');
    if (rest[0]?.role !== 'user') rest = mergeRoles([{ role: 'user', content: 'Begin.' }, ...rest]);
    const data = await request(conn, '/messages', { model, system, messages: rest, max_tokens: maxTokens, temperature });
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (json && !conn.noJsonMode) body.response_format = { type: 'json_object' };
  const data = await completions(conn, body);
  return data.choices?.[0]?.message?.content || '';
}

const NOT_CHAT = /embed|whisper|tts|dall-e|image|moderation|guard|audio|realtime|transcribe|rerank|sora|veo|imagen|lyria|aqa|computer-use|-search/i;

export async function listModels(conn) {
  if (conn.provider === 'puter') return [];
  const data = await request(conn, '/models', null, 'GET');
  const items = (data.data || data.models || []).map((m) => ({
    id: String(m.id || m.name || '').replace(/^models\//, ''),
    free: m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : false,
  }));
  return items.filter((m) => m.id && !NOT_CHAT.test(m.id)).sort((a, b) => a.id.localeCompare(b.id));
}

// Small, fast models make the best interviewers: replies come back before the pause feels awkward.
const PREFERRED = [/gemini-[\d.]+-flash(?!-lite)/, /flash-lite/, /gpt-[\w.]*mini/, /haiku/, /llama-3\.3-70b|llama-3\.1-8b|llama3/, /qwen/, /mistral-small|ministral/, /deepseek-chat/, /grok-[\w.]*mini/, /llama/];

export function pickDefault(models) {
  const pool = models.some((m) => m.free) ? models.filter((m) => m.free) : models;
  for (const re of PREFERRED) {
    const hit = pool.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return pool[0]?.id || '';
}

export async function testConnection(conn) {
  const started = performance.now();
  await chat(conn, [{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 16, temperature: 0 });
  return Math.round(performance.now() - started);
}

let puterLoading;
function loadPuter() {
  puterLoading ||= new Promise((resolve, reject) => {
    if (window.puter) return resolve(window.puter);
    const script = el('script', { src: 'https://js.puter.com/v2/' });
    script.onload = () => resolve(window.puter);
    script.onerror = () => {
      puterLoading = null;
      reject(new AIError("Couldn't load Puter. Check your internet connection.", 'network'));
    };
    document.head.append(script);
  });
  return puterLoading;
}

async function puterChat(messages, model) {
  const puter = await loadPuter();
  let res;
  try {
    res = await puter.ai.chat(messages, model ? { model } : undefined);
  } catch (err) {
    throw new AIError(`Puter refused the request (${err?.error?.message || err?.message || 'unknown error'}).`, 'request');
  }
  if (typeof res === 'string') return res;
  const content = res?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join('');
  return res?.text || String(res ?? '');
}

// ------------------------------------------------------------------ OpenRouter sign-in (OAuth PKCE)

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function openRouterSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('mohora.openrouter', JSON.stringify({ verifier, back: location.pathname + location.search }));
  const callback = encodeURIComponent(`${location.origin}/connect/openrouter`);
  location.href = `https://openrouter.ai/auth?callback_url=${callback}&code_challenge=${challenge}&code_challenge_method=S256`;
}

async function finishOpenRouter() {
  const status = $('#connect-status');
  const fail = (message) => {
    status.textContent = message;
    $('#connect-back').hidden = false;
  };
  const code = new URLSearchParams(location.search).get('code');
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('mohora.openrouter') || 'null');
  } catch {}
  if (!code || !saved) return fail('This sign-in link has expired. Start again from the AI settings.');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: saved.verifier, code_challenge_method: 'S256' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.key) throw new Error(data.error?.message || 'OpenRouter did not return a key.');
    const conn = newConnection('openrouter', { key: data.key, label: 'OpenRouter account' });
    status.textContent = 'Connected. Choosing a model…';
    conn.model = pickDefault(await listModels(conn).catch(() => []));
    conn.coachModel = conn.model;
    saveConnection(conn);
    sessionStorage.removeItem('mohora.openrouter');
    track('ai_connected', { provider: 'openrouter', via: 'sign-in' });
    location.replace(saved.back || '/app/settings');
  } catch (err) {
    fail(`Couldn't finish the sign-in: ${err.message}`);
  }
}

// ------------------------------------------------------------------ connection manager UI

export function mountConnections(root) {
  let editing = null;

  const draw = () => root.replaceChildren(editing ? editor(editing) : overview());
  window.addEventListener('ai-change', () => !editing && draw());

  function overview() {
    const list = connections();
    const active = activeConnection();
    return el('div', {},
      list.length
        ? el('ul', { class: 'conn-list' }, list.map((c) => connectionRow(c, active?.id === c.id)))
        : el('p', { class: 'muted' }, 'No AI connected yet. Pick one below. Google Gemini and Groq both give free keys.'),
      el('div', { class: 'providers' },
        group('Sign in with an account', 'account'),
        group('Use an API key', 'key'),
        group('Run it on your computer', 'local')));
  }

  function connectionRow(conn, isActive) {
    const result = el('span', { class: 'small' });
    return el('li', {},
      el('label', { class: 'check', style: 'margin:0' },
        el('input', { type: 'radio', name: 'active-ai', checked: isActive, onchange: () => setActive(conn.id) }),
        el('span', { class: 'sr-only' }, 'Use this one')),
      el('div', { class: 'grow' },
        el('b', {}, conn.label || provider(conn.provider).name),
        el('div', { class: 'small muted' }, conn.model || 'provider default model', conn.remember ? '' : ', forgotten when you close the browser', conn.relay ? ', routed through this site' : ''),
        result),
      el('button', {
        class: 'btn btn-small', type: 'button',
        onclick: async () => {
          result.className = 'small';
          result.textContent = 'Testing…';
          try {
            const ms = await testConnection(conn);
            result.className = 'small status-ok';
            result.textContent = `Works. Replied in ${(ms / 1000).toFixed(1)} s.`;
          } catch (err) {
            result.className = 'small status-bad';
            result.textContent = err.message;
          }
        },
      }, 'Test'),
      el('button', { class: 'btn btn-small', type: 'button', onclick: () => { editing = { ...conn }; draw(); } }, 'Edit'),
      el('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => { removeConnection(conn.id); draw(); } }, 'Remove'));
  }

  function group(title, id) {
    return el('div', {},
      el('h3', {}, title),
      el('div', { class: 'prov-grid' }, PROVIDERS.filter((p) => p.group === id).map((p) =>
        el('button', {
          class: 'prov', type: 'button', disabled: p.soon,
          onclick: () => { editing = newConnection(p.id, { base: p.base || '' }); draw(); },
        },
        el('b', {}, p.name, p.free ? el('span', { class: 'tag', style: 'margin-left:.4rem;display:inline' }, 'free') : '', p.beta ? el('span', { class: 'tag', style: 'margin-left:.4rem;display:inline' }, 'beta') : '', p.soon ? el('span', { class: 'tag', style: 'margin-left:.4rem;display:inline' }, 'soon') : ''),
        el('span', {}, p.blurb)))));
  }

  function editor(conn) {
    const p = provider(conn.provider);
    const isNew = !connections().some((c) => c.id === conn.id);
    const status = el('p', { class: 'small', role: 'status' });
    const key = el('input', { type: 'password', id: 'ai-key', autocomplete: 'off', spellcheck: 'false', placeholder: conn.key ? 'Saved. Paste a new key to replace it.' : 'Paste your key' });
    const base = el('input', { type: 'url', id: 'ai-base', value: conn.base || p.base || '', placeholder: 'https://…/v1' });
    const remember = el('input', { type: 'checkbox', checked: conn.remember !== false });
    const relay = el('input', { type: 'checkbox', checked: !!conn.relay });
    const model = el('input', { type: 'text', id: 'ai-model', value: conn.model || '', list: 'ai-models', placeholder: conn.provider === 'puter' ? 'Leave empty for Puter’s default' : 'Choose after connecting' });
    const coach = el('input', { type: 'text', id: 'ai-coach', value: conn.coachModel || '', list: 'ai-models', placeholder: 'Same as the interviewer' });
    const datalist = el('datalist', { id: 'ai-models' });
    const modelBox = el('div', { hidden: !conn.model && conn.provider !== 'puter' },
      el('div', { class: 'field' }, el('label', { for: 'ai-model' }, 'Interviewer model'), model,
        el('p', { class: 'hint' }, 'A fast model keeps the conversation natural. You can type any model name.')),
      el('div', { class: 'field' }, el('label', { for: 'ai-coach' }, 'Feedback model'), coach,
        el('p', { class: 'hint' }, 'Writes your scores and feedback. A stronger model gives sharper feedback.')));
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', hidden: modelBox.hidden }, 'Save');

    const collect = () => ({
      ...conn,
      key: key.value.trim() || conn.key,
      base: base.value.trim(),
      remember: remember.checked,
      relay: relay.checked,
      model: model.value.trim(),
      coachModel: coach.value.trim(),
      label: conn.label || p.name,
    });

    async function connect() {
      const draft = collect();
      if (!draft.key && !p.local && !['puter', 'custom'].includes(p.id)) {
        status.className = 'small status-bad';
        status.textContent = 'Paste a key first.';
        return;
      }
      status.className = 'small';
      status.textContent = 'Checking…';
      try {
        if (p.id === 'puter') {
          const puter = await loadPuter();
          if (!puter.auth.isSignedIn()) await puter.auth.signIn();
        } else {
          const models = await listModels(draft);
          datalist.replaceChildren(...models.map((m) => el('option', { value: m.id }, m.free ? 'free' : '')));
          if (!draft.model) draft.model = pickDefault(models);
          model.value = draft.model;
          if (!models.length) status.textContent = 'Connected, but the provider gave no model list. Type a model name.';
        }
        if (draft.model || p.id === 'puter') await testConnection(draft);
        Object.assign(conn, draft);
        status.className = 'small status-ok';
        status.textContent = draft.model || p.id === 'puter' ? 'Connected and tested. Check the models, then save.' : status.textContent;
        modelBox.hidden = false;
        saveBtn.hidden = false;
      } catch (err) {
        status.className = 'small status-bad';
        status.textContent = err.message;
        track('ai_test_failed', { provider: p.id, kind: err.kind || 'error' });
      }
    }

    saveBtn.addEventListener('click', () => {
      const final = collect();
      if (!final.model && p.id !== 'puter') {
        status.className = 'small status-bad';
        status.textContent = 'Choose a model.';
        return;
      }
      saveConnection(final);
      if (isNew) track('ai_connected', { provider: p.id, via: p.id === 'puter' ? 'sign-in' : 'key' });
      toast(`${p.name} is ready.`);
      editing = null;
      draw();
    });

    // Puter's sign-in opens a popup, which browsers only allow right after a click,
    // so load its script now rather than when the button is pressed.
    if (p.id === 'puter') loadPuter().catch(() => {});
    const how = (p.how || []).map((step) => el('li', {}, step.replace('{origin}', location.origin)));
    const showKey = p.id !== 'puter' && !p.local;
    return el('div', { class: 'stack' },
      el('div', { class: 'spread' },
        el('h3', { style: 'margin:0' }, isNew ? `Connect ${p.name}` : `Edit ${p.name}`),
        el('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { editing = null; draw(); } }, 'Back')),
      el('p', { class: 'muted' }, p.blurb),
      p.id === 'openrouter' && isNew
        ? el('div', { class: 'stack' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: openRouterSignIn }, 'Sign in with OpenRouter'),
          el('p', { class: 'small muted' }, 'You’ll come back here with your account connected. Free models need no credit. Or paste an OpenRouter key below.'))
        : '',
      how.length ? el('ol', { class: 'how' }, how) : '',
      p.keyUrl ? el('p', { class: 'small' }, el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener' }, `Get a ${p.name} key`)) : '',
      showKey ? el('div', { class: 'field' }, el('label', { for: 'ai-key' }, 'API key'), key) : '',
      p.custom || p.local || !isNew ? el('div', { class: 'field' }, el('label', { for: 'ai-base' }, 'Server address'), base) : '',
      showKey ? el('label', { class: 'check' }, remember, el('span', {}, 'Remember on this device', el('span', { class: 'hint', style: 'display:block' }, 'Off: the key is forgotten when you close the browser.'))) : '',
      p.relay ? el('label', { class: 'check' }, relay, el('span', {}, 'Route through this site', el('span', { class: 'hint', style: 'display:block' }, 'Only if direct calls fail. The key passes through this server for each request and is never stored.'))) : '',
      el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: connect }, p.id === 'puter' ? 'Sign in with Puter' : 'Connect'), saveBtn),
      status,
      modelBox,
      datalist);
  }

  draw();
}

export function openAIDialog() {
  const dialog = $('#ai-dialog');
  if (!dialog) return;
  const body = $('.ai-dialog-body', dialog);
  if (!body.dataset.mounted) {
    mountConnections(body);
    body.dataset.mounted = '1';
  }
  dialog.showModal();
}

// ------------------------------------------------------------------ pages

async function landingDemo() {
  const root = $('#demo');
  const scripts = JSON.parse($('#demo-scripts').textContent);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const classes = { f: 'm-filler', s: 'm-strong', w: 'm-weak', h: '' };
  let turn = 0;
  await sleep(4500);
  for (;;) {
    const s = scripts[turn++ % scripts.length];
    const bangla = /[ঀ-৿]/.test(s.q);
    root.lang = bangla ? 'bn' : 'en';
    $('#demo-who-q').textContent = s.who;
    $('#demo-count').textContent = s.count;
    $('#demo-q').textContent = s.q;
    const text = $('#demo-text');
    const note = $('#demo-note');
    note.classList.remove('on');
    text.replaceChildren();
    const marks = [];
    for (const [kind, words] of s.a) {
      const target = kind ? el('mark', { class: classes[kind] }) : text;
      if (kind) {
        text.append(target);
        marks.push(target);
      }
      for (const piece of words.split(/(\s+)/)) {
        target.append(piece);
        if (piece.trim()) await sleep(95);
      }
    }
    await sleep(600);
    for (const m of marks) {
      m.classList.add('on');
      await sleep(380);
    }
    await sleep(400);
    note.textContent = s.note;
    note.classList.add('on');
    await sleep(6000);
  }
}

function dashboardStatus() {
  const box = $('#ai-status');
  const draw = () => {
    const conn = activeConnection();
    box.replaceChildren(conn
      ? el('p', { style: 'margin:0' }, 'Interviews run on ', el('b', {}, describe(conn)), '. ', el('a', { href: '/app/settings#ai' }, 'Change'))
      : el('div', { class: 'stack' }, el('p', { style: 'margin:0' }, 'Connect an AI before your first interview. Gemini and Groq give free keys; OpenRouter lets you sign in.'),
        el('button', { class: 'btn btn-small', type: 'button', onclick: openAIDialog }, 'Connect an AI')));
  };
  window.addEventListener('ai-change', draw);
  draw();
}

function settingsPage() {
  mountConnections($('#connections'));

  const voiceForm = $('#voice-form');
  const saved = JSON.parse(localStorage.getItem('mohora.voice') || '{}');
  const fillVoices = () => {
    const voices = window.speechSynthesis?.getVoices() || [];
    for (const [lang, select] of [['en', $('#voice-en')], ['bn', $('#voice-bn')]]) {
      const options = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
      select.replaceChildren(el('option', { value: '' }, 'Pick automatically'), ...options.map((v) => el('option', { value: v.name, selected: saved[`voice_${lang}`] === v.name }, `${v.name} (${v.lang})`)));
      if (!options.length) select.append(el('option', { value: '', disabled: true }, lang === 'bn' ? 'No Bangla voice on this device' : 'No English voice found'));
    }
  };
  fillVoices();
  window.speechSynthesis?.addEventListener('voiceschanged', fillVoices);
  for (const [name, value] of Object.entries(saved)) {
    const input = voiceForm.elements[name];
    if (input && input.type === 'checkbox') input.checked = !!value;
    else if (input && input.tagName !== 'SELECT') input.value = value;
  }
  voiceForm.addEventListener('change', () => {
    const data = {
      voice_en: $('#voice-en').value, voice_bn: $('#voice-bn').value,
      rate: Number(voiceForm.elements.rate.value), silence: Number(voiceForm.elements.silence.value),
      auto_listen: voiceForm.elements.auto_listen.checked,
    };
    localStorage.setItem('mohora.voice', JSON.stringify(data));
    toast('Voice settings saved.');
  });
  $('#voice-test').addEventListener('click', () => {
    const u = new SpeechSynthesisUtterance('Thanks for coming in today. Shall we start?');
    const voice = speechSynthesis.getVoices().find((v) => v.name === $('#voice-en').value);
    if (voice) u.voice = voice;
    u.rate = Number(voiceForm.elements.rate.value) || 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });

  $('#save-transcripts').addEventListener('change', async (e) => {
    try {
      await api('/api/me', { method: 'POST', body: { prefs: { save_transcripts: e.target.checked } } });
      toast(e.target.checked ? 'Transcripts will be saved with your reports.' : 'New reports will be saved without transcripts.');
    } catch (err) {
      toast(err.message, true);
      e.target.checked = !e.target.checked;
    }
  });
}

function onboarding() {
  const form = $('#goal-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api('/api/me', { method: 'POST', body: { goal: data } });
      localStorage.setItem('mohora.setup.last', JSON.stringify({ role: data.role, level: data.level, pack: data.pack }));
      $('#step-goal').hidden = true;
      $('#step-ai').hidden = false;
      $$('.steps span').forEach((s, i) => (i === 1 ? s.setAttribute('aria-current', 'step') : s.removeAttribute('aria-current')));
      mountConnections($('#onboard-ai'));
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function feedbackForm() {
  const form = $('#feedback-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api('/api/feedback', { method: 'POST', body: { ...data, page: location.pathname } });
      form.reset();
      toast('Thanks. Your message reached the site owner.');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

if ($('#demo-scripts')) landingDemo();
if ($('#connect-status')) finishOpenRouter();
if ($('#ai-status')) dashboardStatus();
if ($('#connections')) settingsPage();
if ($('#goal-form')) onboarding();
if ($('#feedback-form')) feedbackForm();
for (const button of $$('[data-open-ai]')) button.addEventListener('click', openAIDialog);
for (const button of $$('[data-print]')) button.addEventListener('click', () => window.print());
$('#voice-form')?.addEventListener('submit', (e) => e.preventDefault());
for (const dialog of $$('dialog')) {
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
}
