// The interview setup page (questions from the CV) and the interview room.
//
// The model only voices the interviewer. This file decides what happens next:
// when to follow up, when to move on, when to give feedback and how to score.
// That keeps small free models on track.

import { $, el, api, toast, track, fill, parseJSON, chat, activeConnection, describe, openAIDialog, AIError } from './app.js';
import * as voice from './voice.js';

const LEVELS = { intern: 'intern', fresher: 'fresh graduate', junior: 'junior', mid: 'mid-level', senior: 'senior', lead: 'lead or manager' };
const PERSONAS = {
  friendly: 'warm and encouraging, relaxed pace, patient with pauses',
  neutral: 'professional and neutral, polite and efficient',
  skeptical: 'a skeptical senior interviewer: terse, probes every claim and asks for evidence',
};
const LANGS = {
  en: { rule: 'Speak English.', name: 'English', feedback: 'English', stt: 'en-US', tts: 'en', again: "Let's take that one again.", thanks: 'Thank you.' },
  bn: {
    rule: 'Speak natural, polite Bangla in Bengali script, the way an interviewer in Dhaka would. Keep technical terms in English.',
    name: 'Bangla (Bengali script)', feedback: 'Bangla (Bengali script)', stt: 'bn-BD', tts: 'bn', again: 'চলুন, প্রশ্নটা আবার করি।', thanks: 'ধন্যবাদ।',
  },
  mixed: {
    rule: 'Speak the way many Bangladeshi professionals do in interviews: mostly Bangla in Bengali script, with English words for technical terms.',
    name: 'Bangla with English terms', feedback: 'simple Bangla (Bengali script) with English terms', stt: 'bn-BD', tts: 'bn', again: 'চলুন, প্রশ্নটা আবার করি।', thanks: 'ধন্যবাদ।',
  },
};
const MAX_FOLLOWUPS = { easy: 1, normal: 1, hard: 2 };
const SOURCE_LABEL = { opener: 'opener', cv: 'from your CV', jd: 'from the job post', role: 'for the role', you: 'your question' };

const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (x) => Math.round(x * 10) / 10;

function promptVars(run) {
  const o = run.options;
  const p = run.pack;
  const lang = LANGS[o.lang] || LANGS.en;
  return {
    interviewer_name: p.interviewer.name,
    interviewer_role: p.interviewer.role,
    company_part: o.company ? ` at ${o.company}` : '',
    target_role: o.role,
    level: LEVELS[o.level] || o.level,
    pack_title: p.title,
    pack_brief: p.brief,
    persona: PERSONAS[o.persona] || PERSONAS.neutral,
    language_rule: lang.rule,
    language_name: lang.name,
    feedback_language: lang.feedback,
    max_sentences: 3,
    pack_rules: (p.rules || []).map((r) => `- ${r}\n`).join(''),
    user_instructions: o.instructions ? `- The candidate asked for this: ${o.instructions}\n` : '',
    candidate_context: candidateContext(run),
  };
}

function candidateContext(run) {
  const parts = [];
  const p = run.profile;
  if (p) {
    if (p.name) parts.push(`Name: ${p.name}`);
    if (p.headline) parts.push(`Currently: ${p.headline}`);
    if (p.skills?.length) parts.push(`Skills: ${p.skills.join(', ')}`);
    if (p.highlights?.length) parts.push(`From the CV: ${p.highlights.join('; ')}`);
  }
  if (run.jd) parts.push(`Job description excerpt: ${run.jd}`);
  return parts.length ? parts.join('\n') : 'No CV or job description was given.';
}

// ======================================================================= setup page

function setupPage() {
  const data = JSON.parse($('#setup-data').textContent);
  const form = $('#setup-form');
  const packs = Object.fromEntries(data.packs.map((p) => [p.slug, p]));
  let cv = '';
  let plan = null;
  let profile = null;
  let countTouched = false;

  const pack = () => packs[form.elements.pack.value] || data.packs[0];
  const jd = () => $('#jd').value.trim();

  const last = (() => {
    try {
      return JSON.parse(localStorage.getItem('mohora.setup.last') || 'null');
    } catch {
      return null;
    }
  })();
  const preset = data.previous || last || {};
  for (const name of ['role', 'level', 'company', 'persona', 'difficulty', 'lang', 'input', 'mode']) {
    if (preset[name] && form.elements[name]) form.elements[name].value = preset[name];
  }
  const packSlug = data.selected || preset.pack;
  if (packs[packSlug]) form.elements.pack.value = packSlug;
  if (data.previous?.questions?.length) plan = data.previous.questions.map((q) => ({ why: '', competency: '', ...q }));

  try {
    const saved = JSON.parse(localStorage.getItem('mohora.cv') || 'null');
    if (saved?.text) {
      setCV(saved.text, `Using the CV saved on this device (${saved.name}).`);
      $('#cv-remember').checked = true;
    }
  } catch {}

  if (!voice.canListen) {
    form.elements.input.value = 'text';
    form.querySelector('input[name="input"][value="voice"]').disabled = true;
    $('#voice-note').textContent = 'Speaking needs Chrome or Edge. In this browser you type your answers.';
  }

  function onPackChange() {
    const p = pack();
    $('#who-mono').textContent = initials(p.interviewer.name);
    $('#who-name').textContent = p.interviewer.name;
    $('#who-role').textContent = `${p.interviewer.role}, interviewing you`;
    $('#who-note').textContent = `${p.title}: ${p.summary}`;
    $('#jd-optional').textContent = p.needs_jd ? '(needed for this type)' : '(optional)';
    if (!countTouched) form.elements.count.value = p.default_count || 5;
    markStale();
  }

  function markStale() {
    if (!plan) return;
    $('#plan-status').textContent = 'You changed the settings. Prepare the questions again, or start with these.';
    estimate();
  }

  function setCV(text, note) {
    cv = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
    $('#cv-status').textContent = note;
    $('#cv-status').className = 'small status-ok';
    $('#cv-clear').hidden = !cv;
    $('#mix-field').hidden = !cv;
    if ($('#cv-remember').checked) saveCV();
    markStale();
  }

  function saveCV(name = 'pasted text') {
    if (!cv) return;
    try {
      localStorage.setItem('mohora.cv', JSON.stringify({ name, text: cv }));
    } catch {}
  }

  async function readFile(file) {
    const status = $('#cv-status');
    status.className = 'small';
    status.textContent = `Reading ${file.name}…`;
    try {
      const { text, note } = await extractText(file);
      if (text.trim().length < 80) throw new Error('No text found in this file. If it is a scanned image, paste the text instead.');
      setCV(text, `Read ${file.name} (${note}, ${text.length.toLocaleString()} characters).`);
      if ($('#cv-remember').checked) saveCV(file.name);
    } catch (err) {
      status.className = 'small status-bad';
      status.textContent = err.message;
    }
  }

  $('#cv-file').addEventListener('change', (e) => e.target.files[0] && readFile(e.target.files[0]));
  const drop = $('#cv-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });
  $('#cv-paste').addEventListener('click', () => {
    const area = $('#cv-text');
    area.hidden = !area.hidden;
    if (!area.hidden) area.focus();
  });
  $('#cv-text').addEventListener('change', (e) => setCV(e.target.value, e.target.value.trim() ? 'Using the text you pasted.' : ''));
  $('#cv-clear').addEventListener('click', () => {
    cv = '';
    $('#cv-text').value = '';
    $('#cv-file').value = '';
    $('#cv-status').textContent = '';
    $('#cv-clear').hidden = true;
    $('#mix-field').hidden = true;
    localStorage.removeItem('mohora.cv');
    $('#cv-remember').checked = false;
    markStale();
  });
  $('#cv-remember').addEventListener('change', (e) => (e.target.checked ? saveCV() : localStorage.removeItem('mohora.cv')));

  form.addEventListener('change', (e) => {
    if (e.target.name === 'pack') return onPackChange();
    if (e.target.name === 'count') countTouched = true;
    if (['role', 'level', 'company', 'lang', 'mix', 'count', 'jd', 'instructions', 'own'].includes(e.target.name)) markStale();
    estimate();
  });

  function options() {
    const f = new FormData(form);
    const text = (name) => String(f.get(name) || '').trim();
    return {
      role: text('role').slice(0, 120),
      level: text('level'),
      company: text('company').slice(0, 120),
      persona: text('persona'),
      difficulty: text('difficulty'),
      lang: text('lang'),
      input: text('input') || 'text',
      mode: text('mode'),
      mix: cv ? text('mix') || 'both' : 'role',
      count: Math.min(12, Math.max(2, Number(f.get('count')) || 5)),
      instructions: text('instructions').slice(0, 600),
      own: text('own').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10),
    };
  }

  function fromBank(p, count) {
    // Opener first, then one question per competency, easier ones first.
    const picked = [{ q: p.opener, competency: '', source: 'opener', why: 'Warms up and frames the rest' }];
    const pool = [...(p.bank || [])].sort(() => Math.random() - 0.5).sort((a, b) => (a.d || 2) - (b.d || 2));
    const seen = new Set();
    for (const item of pool) {
      if (picked.length >= count) break;
      if (seen.has(item.c) && pool.length - seen.size > count) continue;
      seen.add(item.c);
      picked.push({ q: item.q, competency: item.c, source: 'role', why: '' });
    }
    return picked;
  }

  async function buildPlan() {
    const o = options();
    const p = pack();
    const status = $('#plan-status');
    const error = $('#setup-error');
    error.hidden = true;
    if (!o.role) return showSetupError('Add the job title first, so the questions fit the job.');
    if (p.needs_jd && !jd()) return showSetupError('This interview type needs a job description. Paste it in step 3.');

    const own = o.own.map((q) => ({ q, competency: '', source: 'you', why: 'You asked for this one' }));
    const count = Math.max(1, o.count - own.length);
    const needsAI = p.needs_plan || cv || jd() || o.instructions;
    const button = $('#plan-btn');

    if (!needsAI) {
      profile = null;
      plan = fromBank(p, count);
    } else {
      const conn = activeConnection();
      if (!conn) {
        openAIDialog();
        return showSetupError('Connect an AI first. It writes questions from your CV.');
      }
      button.disabled = true;
      status.className = 'small';
      status.textContent = cv ? 'Reading your CV and writing questions…' : 'Writing questions…';
      const mixRule = { both: 'Mix questions about the CV with standard questions for the role, roughly half each.', cv: 'Base most questions on the CV.', role: 'Use standard questions for the role. Do not use the CV.' }[o.mix];
      const vars = promptVars({ pack: p, options: o, profile: null, jd: '' });
      const prompt = fill(data.prompts.plan, {
        ...vars,
        competencies: (p.competencies || []).join(', ') || 'whatever matters most for this role',
        count,
        mix_rule: cv ? mixRule : 'There is no CV. Use the role and the job description.',
        focus: o.instructions || 'nothing specific',
        bank_examples: (p.bank || []).slice(0, 5).map((b) => `- ${b.q}`).join('\n') || '(none)',
        jd: jd().slice(0, 6000),
        cv: cv.slice(0, 9000),
        opener: p.opener,
      });
      try {
        const raw = await chat(conn, [{ role: 'user', content: prompt }], { json: true, model: conn.coachModel || conn.model, maxTokens: 1600, temperature: 0.6 });
        const result = parseJSON(raw);
        const questions = (result?.questions || []).filter((q) => q && typeof q.q === 'string' && q.q.trim());
        if (!questions.length) throw new AIError("The AI didn't send back a question list. Try again, or pick another model.", 'parse');
        plan = questions.slice(0, count).map((q, i) => ({
          q: q.q.trim(),
          competency: String(q.competency || ''),
          source: i === 0 ? 'opener' : ['cv', 'jd', 'role'].includes(q.source) ? q.source : 'role',
          why: String(q.why || ''),
        }));
        profile = cv && result.profile && typeof result.profile === 'object' ? result.profile : null;
        track('plan_built', { pack: p.slug, cv: Boolean(cv), jd: Boolean(jd()) });
      } catch (err) {
        status.textContent = '';
        button.disabled = false;
        return showSetupError(err.message);
      }
      button.disabled = false;
    }
    plan.splice(1, 0, ...own);
    status.className = 'small status-ok';
    status.textContent = 'Ready. Edit anything you like.';
    button.textContent = 'Prepare again';
    renderProfile();
    renderPlan();
  }

  function renderProfile() {
    const box = $('#profile');
    box.hidden = !profile;
    if (!profile) return;
    box.replaceChildren(
      el('p', { class: 'faint small', style: 'margin:0' }, 'What the interviewer noticed in your CV'),
      el('h3', { style: 'margin:.2rem 0 .3rem' }, [profile.name, profile.headline].filter(Boolean).join(', ')),
      el('div', { class: 'profile-skills' }, (profile.skills || []).slice(0, 8).map((s) => el('span', { class: 'tag' }, s))),
      profile.highlights?.length ? el('ul', { class: 'small muted', style: 'margin:.7rem 0 0;padding-left:1.1rem' }, profile.highlights.slice(0, 4).map((h) => el('li', {}, h))) : '');
  }

  function renderPlan() {
    const list = $('#plan');
    list.replaceChildren(...plan.map((item, i) => {
      const area = el('textarea', { rows: 2, 'aria-label': `Question ${i + 1}` });
      area.value = item.q;
      area.addEventListener('input', () => (item.q = area.value));
      return el('li', {},
        el('div', {}, area, item.why ? el('div', { class: 'why' }, item.why) : ''),
        el('div', { style: 'text-align:right' },
          el('span', { class: `tag tag-${item.source}` }, SOURCE_LABEL[item.source] || item.source),
          el('div', {}, el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { plan.splice(i, 1); renderPlan(); } }, 'Remove'))));
    }));
    $('#plan-add').hidden = false;
    $('#start-btn').disabled = plan.length === 0;
    estimate();
  }

  function addOwn() {
    const input = $('#add-q');
    const q = input.value.trim();
    if (!q) return;
    plan ||= [];
    plan.push({ q, competency: '', source: 'you', why: 'You asked for this one' });
    input.value = '';
    renderPlan();
  }
  $('#add-q-btn').addEventListener('click', addOwn);
  $('#add-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addOwn();
    }
  });

  function showSetupError(message) {
    const box = $('#setup-error');
    box.textContent = message;
    box.hidden = false;
  }

  function estimate() {
    const o = options();
    const n = plan?.length || o.count;
    const turns = 2 + n * (1 + MAX_FOLLOWUPS[o.difficulty || 'normal'] * 0.7);
    const calls = Math.round(turns + n + 1 + (pack().needs_plan || cv ? 1 : 0));
    const tokens = Math.round((turns * 1900 + n * 1800 + 1500 + (cv ? 1600 + cv.length / 3.5 : 0)) / 1000);
    $('#estimate').textContent = `About ${calls} calls and ${tokens}k tokens on your AI account. Free tiers usually cover this.`;
  }

  function drawAI() {
    const conn = activeConnection();
    $('#ai-box').replaceChildren(conn
      ? el('p', { class: 'small', style: 'margin:0' }, 'Interviewer runs on ', el('b', {}, describe(conn)), '. ', el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: openAIDialog }, 'Change'))
      : el('div', { class: 'stack', style: '--gap:.6rem' },
        el('p', { class: 'small', style: 'margin:0' }, el('b', {}, 'No AI connected yet. '), 'Sign in with OpenRouter, or paste a free Gemini or Groq key.'),
        el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: openAIDialog }, 'Connect an AI')));
  }
  window.addEventListener('ai-change', drawAI);

  $('#plan-btn').addEventListener('click', buildPlan);
  $('#start-btn').addEventListener('click', async () => {
    const o = options();
    const p = pack();
    $('#setup-error').hidden = true;
    const questions = (plan || []).map((q) => ({ ...q, q: q.q.trim() })).filter((q) => q.q);
    if (!o.role) return showSetupError('Add the job title first.');
    if (!questions.length) return showSetupError('Prepare the questions first.');
    if (!activeConnection()) {
      openAIDialog();
      return showSetupError('Connect an AI first.');
    }
    const button = $('#start-btn');
    button.disabled = true;
    button.textContent = 'Opening the room…';
    try {
      const config = {
        role: o.role, level: o.level, company: o.company, persona: o.persona, difficulty: o.difficulty,
        lang: o.lang, input: o.input, mode: o.mode, has_cv: Boolean(cv), has_jd: Boolean(jd()),
        questions: questions.map(({ q, source }) => ({ q, source })),
      };
      const { id } = await api('/api/sessions', { method: 'POST', body: { pack: p.slug, config } });
      const run = { pack: p, options: o, plan: questions, profile, jd: jd().slice(0, 1500) };
      sessionStorage.setItem(`mohora.run.${id}`, JSON.stringify(run));
      const { role, level, persona, difficulty, lang, input, mode } = o;
      localStorage.setItem('mohora.setup.last', JSON.stringify({ role, level, persona, difficulty, lang, input, mode, pack: p.slug }));
      location.href = `/app/room/${id}`;
    } catch (err) {
      showSetupError(err.message);
      button.disabled = false;
      button.textContent = 'Start the interview';
    }
  });

  onPackChange();
  drawAI();
  if (plan) renderPlan();
  else estimate();
}

async function extractText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (file.size > 8_000_000) throw new Error('That file is over 8 MB. Try a smaller file or paste the text.');
  if (ext === 'pdf') {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
    }
    return { text: pages.join('\n'), note: `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}` };
  }
  if (ext === 'docx') {
    await new Promise((resolve, reject) => {
      if (window.mammoth) return resolve();
      const script = el('script', { src: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js' });
      script.onload = resolve;
      script.onerror = () => reject(new Error("Couldn't load the Word reader. Paste the text instead."));
      document.head.append(script);
    });
    const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: result.value, note: 'Word document' };
  }
  if (['txt', 'md'].includes(ext)) return { text: await file.text(), note: 'text file' };
  throw new Error('Use a PDF, a Word (.docx) file or plain text.');
}

// ======================================================================= interview room

function roomPage() {
  const page = JSON.parse($('#room-data').textContent);
  const sid = page.session;
  const prompts = page.prompts;
  const storeKey = `mohora.run.${sid}`;
  let run = null;
  try {
    run = JSON.parse(sessionStorage.getItem(storeKey) || 'null');
  } catch {}
  if (!run) {
    $('#lobby').hidden = true;
    $('#lost').hidden = false;
    return;
  }

  const o = run.options;
  const pack = run.pack;
  const lang = LANGS[o.lang] || LANGS.en;
  const settings = voice.voiceSettings();
  const vars = promptVars(run);
  const voiceWanted = o.input === 'voice';
  let useVoice = voiceWanted && voice.canListen;

  run.state ||= {
    phase: 'lobby', qi: 0, elapsed: 0, hints: 2, turns: [], wrap: [], pending: null, lastNote: '',
    blocks: run.plan.map((q) => ({ ...q, asked: '', turns: [], followups: 0, eval: null, evalError: null, attempts: [], skipped: false })),
  };
  const st = run.state;
  const evals = new Map();
  const aiLog = [];
  let listener = null;
  let stopMeter = null;
  let level = 0;
  let lastSpokeAt = 0;
  let clock = null;
  let paused = false;
  let reviewMetrics = null;
  let saveTimer = null;

  const persist = () => {
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(run));
    } catch {}
  };

  // ---------------------------------------------------------- view

  const who = pack.interviewer;
  $('#ai-mono').textContent = initials(who.name);
  $('#ai-name').textContent = `${who.name}, ${who.role}`;
  $('#title').textContent = `${pack.title}: ${o.role}`;
  $('#meter').replaceChildren(...Array.from({ length: 9 }, () => el('i')));

  function setAI(state, speaking = false) {
    $('#ai-state').textContent = state;
    $('#tile-ai').classList.toggle('speaking', speaking);
  }

  function setYou(state, listening = false) {
    $('#you-state').textContent = state;
    $('#tile-you').classList.toggle('listening', listening);
  }

  function caption(speaker, text, interim = '') {
    $('#caption').replaceChildren(el('span', { class: 'who' }, speaker), text, interim ? el('span', { class: 'interim' }, ` ${interim}`) : '');
  }

  function updatePhase() {
    const n = st.blocks.length;
    $('#phase').replaceChildren(el('span', { 'aria-current': 'step' },
      st.phase === 'wrap' || st.phase === 'done' ? 'Wrapping up' : `Question ${Math.min(st.qi + 1, n)} of ${n}`));
  }

  function setControls(answering) {
    for (const id of ['done', 'repeat', 'skip', 'hint', 'type-toggle', 'send', 'mic']) $(`#${id}`).disabled = !answering;
    $('#mic').hidden = !useVoice;
    $('#done').hidden = !useVoice;
    $('#type-toggle').hidden = !useVoice;
    $('#hint').hidden = o.mode !== 'practice' || st.hints <= 0;
    $('#skip').hidden = st.phase === 'wrap';
  }

  function drawMeter() {
    const bars = $('#meter').children;
    const shape = [0.35, 0.6, 0.85, 1, 0.9, 1, 0.8, 0.55, 0.3];
    for (let i = 0; i < bars.length; i++) bars[i].style.height = `${8 + level * shape[i] * 92}%`;
  }

  function tick() {
    if (paused || !['live', 'wrap'].includes(st.phase)) return;
    st.elapsed += 1000;
    const s = Math.floor(st.elapsed / 1000);
    $('#clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s % 10 === 0) persist();
  }

  function renderTurns() {
    if ($('#drawer').hidden) return;
    $('#turns').replaceChildren(...st.turns.map((t) => el('p', { class: 'turn' }, el('b', {}, t.who === 'ai' ? who.name : 'You'), t.text)));
    $('#ai-log').replaceChildren(...aiLog.map((entry) => el('details', {},
      el('summary', {}, `${entry.at}: ${entry.purpose === 'coach' ? 'feedback' : 'interviewer'} (${entry.model || 'default model'})${entry.error ? ', failed' : ''}`),
      el('pre', {}, entry.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')),
      el('pre', {}, entry.error ? `Error: ${entry.error}` : entry.reply || '(waiting)'))));
  }

  function showError(err, retry) {
    $('#error-text').textContent = err.message || String(err);
    $('#error').hidden = false;
    $('#error-retry').onclick = () => {
      $('#error').hidden = true;
      retry();
    };
    setAI('');
  }

  const overTime = () => {
    const perQuestion = ((pack.minutes || 20) * 60000) / (pack.default_count || 5);
    return st.elapsed > perQuestion * st.blocks.length * 1.3;
  };

  // ---------------------------------------------------------- talking to the model

  async function ask(purpose, messages, opts) {
    const conn = activeConnection();
    if (!conn) throw new AIError('No AI is connected. Use “Change AI” to connect one.', 'auth');
    const model = purpose === 'coach' ? conn.coachModel || conn.model : conn.model;
    const entry = { purpose, model, at: new Date().toLocaleTimeString(), messages, reply: '', error: '' };
    aiLog.push(entry);
    try {
      entry.reply = await chat(conn, messages, { ...opts, model });
      return entry.reply;
    } catch (err) {
      entry.error = err.message;
      throw err;
    } finally {
      renderTurns();
    }
  }

  function buildMessages(note) {
    const messages = [{ role: 'system', content: fill(prompts.interviewer, vars) }];
    for (const t of st.turns.slice(-10)) {
      messages.push(t.who === 'ai'
        ? { role: 'assistant', content: JSON.stringify({ say: t.text, intent: t.intent || 'next' }) }
        : { role: 'user', content: `Candidate: ${t.text}` });
    }
    const covered = st.blocks.slice(0, st.qi).map((b, i) => `${i + 1}. ${b.q}`).join('\n');
    const director = `Director note (the candidate can't see this): ${note}${covered ? `\nQuestions already covered:\n${covered}` : ''}`;
    if (messages.at(-1).role === 'user') messages.at(-1).content += `\n\n---\n${director}`;
    else messages.push({ role: 'user', content: director });
    return messages;
  }

  // Turn whatever came back into one short, speakable reply.
  function shape(raw) {
    const data = parseJSON(raw);
    let say = typeof data?.say === 'string' ? data.say : '';
    let intent = data?.intent;
    if (!say) {
      const m = raw.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      try {
        say = m ? JSON.parse(`"${m[1]}"`) : raw;
      } catch {
        say = raw;
      }
      intent ||= raw.match(/"intent"\s*:\s*"(\w+)"/)?.[1];
    }
    say = say
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_#>`~]/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!say) throw new AIError('The AI sent an empty reply. Try again, or pick another model.', 'parse');
    const sentences = say.match(/[^.!?।]+[.!?।]+["')]*|[^.!?।]+$/g) || [say];
    if (sentences.length > 4) say = [sentences[0], ...sentences.slice(-2)].join(' ').replace(/\s+/g, ' ').trim();
    return { say, intent: ['follow_up', 'next', 'clarify', 'wrap_up'].includes(intent) ? intent : 'next' };
  }

  // The model proposes; the interview plan decides.
  function enforce(reply) {
    const isLast = st.qi >= st.blocks.length - 1;
    const block = st.blocks[st.qi];
    const nextQ = st.blocks[st.qi + 1]?.q;
    if (reply.intent === 'next' && isLast) reply.intent = 'wrap_up';
    if (reply.intent === 'wrap_up' && !isLast) return { intent: 'next', say: `${lang.thanks} ${nextQ}` };
    if (reply.intent === 'follow_up' && block.followups > MAX_FOLLOWUPS[o.difficulty]) {
      return isLast ? { intent: 'wrap_up', say: reply.say } : { intent: 'next', say: `${lang.thanks} ${nextQ}` };
    }
    return reply;
  }

  function moveOnNote() {
    if (st.qi >= st.blocks.length - 1) {
      return 'This was the last question. Briefly acknowledge the answer, then say those are all your questions and ask whether they have any questions for you. Use intent "wrap_up".';
    }
    return `Briefly acknowledge the answer, then ask the next question in your own words: "${st.blocks[st.qi + 1].q}". Use intent "next".`;
  }

  function directorNote() {
    const block = st.blocks[st.qi];
    const clarify = ' If the candidate asked you to repeat or explain the question instead of answering it, do only that (intent "clarify").';
    if (block.followups >= MAX_FOLLOWUPS[o.difficulty] || overTime()) return `Move on now, no more follow-ups on this question. ${moveOnNote()}${clarify}`;
    return `The candidate answered question ${st.qi + 1} of ${st.blocks.length} ("${block.q}"). If the answer is vague, misses a concrete result, hides who did what, or invites an obvious deeper question, ask ONE short follow-up about that (intent "follow_up"). Otherwise: ${moveOnNote()}${clarify}`;
  }

  function addTurn(speaker, text, extra = {}) {
    const turn = { who: speaker, text, ...extra };
    st.turns.push(turn);
    if (st.phase === 'wrap') {
      st.wrap.push(turn);
    } else {
      const block = st.blocks[st.qi];
      block.turns.push(turn);
      if (speaker === 'ai' && !block.asked) block.asked = text;
    }
    persist();
    renderTurns();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api(`/api/sessions/${sid}`, { method: 'PATCH', body: { transcript: st.turns.map(({ who: w, text: t }) => ({ who: w, text: t })) } }).catch(() => {});
    }, 1500);
  }

  async function aiSays(text, { listenAfter = true } = {}) {
    caption(who.name, text);
    setAI('Speaking', true);
    setControls(false);
    if (voiceWanted && voice.canSpeak) {
      await voice.speak(text, { lang: lang.tts, rate: settings.rate || 1, voice: settings[`voice_${lang.tts}`] || '' });
    } else {
      await new Promise((r) => setTimeout(r, Math.min(2500, 400 + text.length * 12)));
    }
    setAI('');
    lastSpokeAt = performance.now();
    if (listenAfter && !paused && st.phase !== 'done') readyForAnswer();
  }

  function readyForAnswer() {
    setControls(true);
    if (useVoice) {
      setYou('Your turn');
      if (settings.auto_listen !== false) startListening();
    } else {
      showAnswerBox('');
    }
  }

  async function intro() {
    const first = st.blocks[0].q;
    const name = run.profile?.name ? ` The candidate's name is ${run.profile.name}.` : '';
    const note = `Open the interview. Greet the candidate, introduce yourself in one sentence, then ask the first question in your own words: "${first}". Use intent "next".${name}`;
    setAI('Joining');
    try {
      const reply = shape(await ask('interviewer', buildMessages(note), { json: true, maxTokens: 400, temperature: 0.7 }));
      addTurn('ai', reply.say, { intent: 'next' });
      updatePhase();
      await aiSays(reply.say);
    } catch (err) {
      showError(err, intro);
    }
  }

  async function next(note) {
    st.lastNote = note;
    persist();
    setControls(false);
    setAI('Thinking');
    let reply;
    try {
      reply = enforce(shape(await ask('interviewer', buildMessages(note), { json: true, maxTokens: 400, temperature: 0.7 })));
    } catch (err) {
      return showError(err, () => next(note));
    }
    $('#error').hidden = true;
    const closes = reply.intent === 'next' || reply.intent === 'wrap_up';
    const block = st.blocks[st.qi];
    if (closes && block.turns.some((t) => t.who === 'you')) evaluate(st.qi);
    if (closes && o.mode === 'practice' && !block.skipped) {
      st.pending = reply;
      persist();
      setAI('');
      return showFeedback(st.qi);
    }
    return deliver(reply);
  }

  async function deliver(reply) {
    st.pending = null;
    if (reply.intent === 'next') st.qi += 1;
    else if (reply.intent === 'wrap_up') st.phase = 'wrap';
    else if (reply.intent === 'follow_up') st.blocks[st.qi].followups += 1;
    addTurn('ai', reply.say, { intent: reply.intent });
    updatePhase();
    await aiSays(reply.say);
  }

  async function submitAnswer(text, metrics) {
    text = text.trim().slice(0, 4000);
    if (!text) return toast('Say or type an answer first, or skip the question.');
    hideAnswerBox();
    $('#hint-box').hidden = true;
    caption('You', text);
    setYou('');
    addTurn('you', text, { metrics });
    if (st.phase === 'wrap') return closeInterview();
    return next(directorNote());
  }

  async function closeInterview() {
    const note = 'The candidate has replied to your last question. If they asked you something, answer briefly and plausibly in character, keeping details general. Then thank them and close the interview in one or two warm sentences. Use intent "wrap_up".';
    setControls(false);
    setAI('Thinking');
    try {
      const reply = shape(await ask('interviewer', buildMessages(note), { json: true, maxTokens: 300, temperature: 0.7 }));
      addTurn('ai', reply.say, { intent: 'wrap_up' });
      await aiSays(reply.say, { listenAfter: false });
    } catch {
      // A missing goodbye isn't worth blocking the report for.
    }
    finish();
  }

  // ---------------------------------------------------------- listening and typing

  function startListening() {
    if (!useVoice || listener?.active) return;
    voice.stopSpeaking();
    listener = new voice.Listener({
      lang: lang.stt,
      silenceMs: (settings.silence || 0) * 1000,
      onText: (finalText, interim) => caption('You', finalText, interim),
      onSilence: () => finishSpeaking(),
      onError: (code) => {
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) {
          toast("The microphone is blocked or missing, so you'll type instead. You can allow it from the address bar.", true);
          useVoice = false;
          stopListening();
          setControls(true);
          showAnswerBox('');
        } else if (code === 'network') {
          toast('Speech recognition lost its connection. Keep talking, or type instead.', true);
        }
      },
    });
    listener.start();
    $('#mic').classList.add('on');
    $('#mic').textContent = 'Listening…';
    setYou('Listening', true);
  }

  function stopListening() {
    $('#mic').classList.remove('on');
    $('#mic').textContent = 'Start speaking';
    setYou('');
    if (!listener?.active) return { text: '', ms: 0, firstAt: 0 };
    return listener.stop();
  }

  function finishSpeaking() {
    const heard = stopListening();
    if (!heard.text) {
      toast("Nothing was heard. Press Start speaking and try again, or type instead.");
      return;
    }
    const latency = heard.firstAt && lastSpokeAt ? round1((heard.firstAt - lastSpokeAt) / 1000) : null;
    const metrics = { ...voice.analyze(heard.text, { lang: o.lang, ms: heard.ms }), latency, spoken: true };
    if (o.mode === 'practice') {
      // Speech recognition makes mistakes, especially in Bangla. Let the candidate fix them.
      reviewMetrics = metrics;
      showAnswerBox(heard.text, 'Fix any words the microphone got wrong, then send.');
      return;
    }
    submitAnswer(heard.text, metrics);
  }

  function showAnswerBox(text, info = '') {
    const box = $('#answer-box');
    const area = $('#answer');
    box.hidden = false;
    area.value = text;
    setYou(useVoice ? 'Checking the transcript' : 'Typing');
    $('#answer-info').textContent = info || (text ? '' : 'Write the answer you would say out loud.');
    area.focus();
  }

  function hideAnswerBox() {
    $('#answer-box').hidden = true;
    $('#answer').value = '';
  }

  function sendTyped() {
    const text = $('#answer').value;
    const metrics = reviewMetrics
      ? { ...reviewMetrics, ...voice.analyze(text, { lang: o.lang, ms: reviewMetrics.ms }) }
      : { ...voice.analyze(text, { lang: o.lang }), typed: true };
    reviewMetrics = null;
    submitAnswer(text, metrics);
  }

  // ---------------------------------------------------------- feedback

  function normalizeEval(data) {
    if (!data || typeof data !== 'object') return null;
    const scores = {};
    for (const r of pack.rubric) {
      const value = Number(data.scores?.[r.id]);
      if (value >= 1 && value <= 5) scores[r.id] = Math.round(value * 2) / 2;
    }
    const values = Object.values(scores);
    if (!values.length) return null;
    const list = (x, n) => (Array.isArray(x) ? x : []).map(String).filter(Boolean).slice(0, n);
    const quotes = (Array.isArray(data.quotes) ? data.quotes : [])
      .filter((q) => q && typeof q.text === 'string' && q.text.trim())
      .slice(0, 6)
      .map((q) => ({ text: q.text.trim(), type: q.type === 'strong' ? 'strong' : 'weak', note: String(q.note || '') }));
    return {
      scores, overall: round1(mean(values)), worked: list(data.worked, 2), improve: list(data.improve, 2),
      fix_next: String(data.fix_next || ''), quotes, rewrite: String(data.rewrite || ''),
    };
  }

  function evaluate(i) {
    if (evals.has(i)) return evals.get(i);
    const block = st.blocks[i];
    const transcript = block.turns.map((t) => `${t.who === 'ai' ? 'Interviewer' : 'Candidate'}: ${t.text}`).join('\n');
    const prompt = fill(prompts.coach, {
      ...vars,
      rubric_lines: pack.rubric.map((r) => `- ${r.id} (${r.label}): ${r.hint || ''}`).join('\n'),
      question: block.q,
      transcript,
      score_shape: `{${pack.rubric.map((r) => `"${r.id}": 1-5`).join(', ')}}`,
    });
    const promise = ask('coach', [{ role: 'user', content: prompt }], { json: true, maxTokens: 1300, temperature: 0.3 })
      .then((raw) => {
        const result = normalizeEval(parseJSON(raw));
        if (!result) throw new AIError("The feedback couldn't be read. Try again, or pick a stronger feedback model.", 'parse');
        block.eval = result;
        block.evalError = null;
        persist();
        return result;
      })
      .catch((err) => {
        block.evalError = err.message;
        evals.delete(i);
        persist();
        throw err;
      });
    promise.catch(() => {});
    evals.set(i, promise);
    return promise;
  }

  async function showFeedback(i) {
    const box = $('#feedback-body');
    const block = st.blocks[i];
    const isLast = i >= st.blocks.length - 1;
    $('#feedback').hidden = false;
    box.replaceChildren(el('h2', {}, `Question ${i + 1}`), el('p', { class: 'muted' }, 'Scoring your answer…'));
    let result;
    try {
      result = block.eval || (await evaluate(i));
    } catch (err) {
      box.replaceChildren(
        el('h2', {}, `Question ${i + 1}`),
        el('p', { class: 'error-box' }, err.message),
        el('div', { class: 'row' },
          el('button', { class: 'btn', type: 'button', onclick: () => showFeedback(i) }, 'Try again'),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: carryOn }, 'Carry on without it')));
      return;
    }
    const bars = pack.rubric.map((r) => {
      const v = result.scores[r.id];
      return [el('span', {}, r.label), el('div', { class: `bar${v <= 2 ? ' low' : v >= 4 ? ' high' : ''}` }, el('i', { style: `--v:${v || 0}` })), el('span', { class: 'num' }, v ?? '–')];
    });
    box.replaceChildren(
      el('div', { class: 'spread' }, el('h2', { style: 'margin:0' }, `Question ${i + 1}`), el('span', { class: 'score' }, result.overall, el('small', {}, ' / 5'))),
      el('p', { class: 'muted small', style: 'margin:.3rem 0 1rem' }, block.q),
      el('div', { class: 'rubric' }, bars.flat()),
      result.worked.length ? el('div', { style: 'margin-top:1.1rem' }, el('b', {}, 'What worked'), el('ul', {}, result.worked.map((w) => el('li', {}, w)))) : '',
      result.improve.length ? el('div', {}, el('b', {}, 'What to improve'), el('ul', {}, result.improve.map((w) => el('li', {}, w)))) : '',
      result.fix_next ? el('p', { class: 'pen' }, result.fix_next) : '',
      el('div', { class: 'row', style: 'margin-top:1rem' },
        el('button', { class: 'btn', type: 'button', onclick: () => redo(i) }, 'Redo this question'),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: carryOn }, isLast ? 'Finish the interview' : 'Next question')));
  }

  function carryOn() {
    $('#feedback').hidden = true;
    if (st.pending) deliver(st.pending);
  }

  function redo(i) {
    const block = st.blocks[i];
    block.attempts.push({ turns: block.turns, eval: block.eval });
    block.turns = [];
    block.eval = null;
    block.evalError = null;
    block.followups = 0;
    evals.delete(i);
    st.pending = null;
    $('#feedback').hidden = true;
    const line = `${lang.again} ${block.q}`;
    addTurn('ai', line, { intent: 'clarify' });
    aiSays(line);
  }

  async function hint() {
    const block = st.blocks[st.qi];
    $('#hint').disabled = true;
    try {
      const raw = await ask('coach', [{ role: 'user', content: fill(prompts.hint, { ...vars, question: block.q }) }], { json: true, maxTokens: 250, temperature: 0.4 });
      st.hints -= 1;
      const box = $('#hint-box');
      box.textContent = parseJSON(raw)?.hint || raw;
      box.hidden = false;
      setControls(true);
    } catch (err) {
      toast(err.message, true);
      $('#hint').disabled = false;
    }
  }

  // ---------------------------------------------------------- the report

  function deliverySummary() {
    const answers = st.turns.filter((t) => t.who === 'you' && t.metrics);
    const spoken = answers.filter((t) => t.metrics.wpm);
    const words = answers.reduce((a, t) => a + (t.metrics.words || 0), 0);
    const fillers = {};
    for (const t of answers) for (const [k, v] of Object.entries(t.metrics.fillers || {})) fillers[k] = (fillers[k] || 0) + v;
    const fillerCount = Object.values(fillers).reduce((a, b) => a + b, 0);
    const latencies = answers.map((t) => t.metrics.latency).filter((x) => x != null && x >= 0 && x < 120);
    return {
      words,
      wpm: spoken.length ? Math.round(mean(spoken.map((t) => t.metrics.wpm))) : null,
      filler_count: fillerCount,
      filler_rate: words ? round1((fillerCount / words) * 100) : 0,
      fillers: Object.fromEntries(Object.entries(fillers).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      latency_s: latencies.length ? round1(mean(latencies)) : null,
      spoken: spoken.length > 0,
      terms: voice.fillersFor(o.lang),
    };
  }

  async function summarize(delivery) {
    const answered = st.blocks.filter((b) => b.eval);
    if (!answered.length) return null;
    const results = answered.map((b) => [
      `Question: ${b.q}`,
      `Score: ${b.eval.overall}/5`,
      `Worked: ${b.eval.worked.join('; ')}`,
      `Improve: ${b.eval.improve.join('; ')}`,
      `Candidate's words: ${b.turns.filter((t) => t.who === 'you').map((t) => t.text).join(' ').slice(0, 700)}`,
    ].join('\n')).join('\n\n');
    const deliveryText = delivery.spoken
      ? `${delivery.wpm} words per minute, ${delivery.filler_count} filler words in ${delivery.words} words`
      : `typed answers, ${delivery.words} words in total`;
    try {
      const raw = await ask('coach', [{ role: 'user', content: fill(prompts.summary, { ...vars, results, delivery: deliveryText }) }], { json: true, maxTokens: 700, temperature: 0.4 });
      const data = parseJSON(raw);
      if (data?.headline) {
        return {
          headline: String(data.headline),
          best_moment: data.best_moment?.quote ? { quote: String(data.best_moment.quote), why: String(data.best_moment.why || '') } : null,
          fix_next: String(data.fix_next || ''),
          strengths: (data.strengths || []).map(String).slice(0, 3),
          focus: (data.focus || []).map(String).slice(0, 3),
        };
      }
    } catch {}
    const sorted = [...answered].sort((a, b) => b.eval.overall - a.eval.overall);
    const strong = sorted[0].eval.quotes.find((q) => q.type === 'strong');
    return {
      headline: '',
      best_moment: strong ? { quote: strong.text, why: strong.note } : null,
      fix_next: sorted.at(-1).eval.fix_next,
      strengths: sorted[0].eval.worked,
      focus: sorted.at(-1).eval.improve,
    };
  }

  async function finish() {
    if (st.finishing) return;
    st.finishing = true;
    stopListening();
    voice.stopSpeaking();
    clearInterval(clock);
    stopMeter?.();
    st.phase = 'done';
    persist();
    $('#feedback').hidden = true;
    const overlay = $('#finishing');
    const text = $('#finishing-text');
    overlay.hidden = false;

    const answered = st.blocks.map((b, i) => [b, i]).filter(([b]) => b.turns.some((t) => t.who === 'you'));
    for (const [b, i] of answered) if (!b.eval) evaluate(i);
    let done = 0;
    text.textContent = `Scoring your answers (0 of ${answered.length})…`;
    await Promise.allSettled(answered.map(([, i]) => (evals.get(i) || Promise.resolve()).finally(() => {
      text.textContent = `Scoring your answers (${++done} of ${answered.length})…`;
    })));
    for (const [b, i] of answered) {
      if (!b.eval) await evaluate(i).catch(() => {});
    }
    text.textContent = 'Writing the summary…';
    const delivery = deliverySummary();
    const summary = await summarize(delivery);
    const scored = st.blocks.filter((b) => b.eval);
    const rubric = pack.rubric.map((r) => {
      const values = scored.map((b) => b.eval.scores[r.id]).filter((v) => v != null);
      return { id: r.id, label: r.label, avg: values.length ? round1(mean(values)) : null };
    });
    const overall = scored.length ? round1(mean(scored.map((b) => b.eval.overall))) : null;
    const conn = activeConnection();
    const report = {
      version: 1, overall, rubric, summary, delivery,
      blocks: st.blocks.map((b) => ({
        q: b.q, source: b.source, why: b.why, competency: b.competency, attempts: b.attempts.length,
        skipped: !b.turns.some((t) => t.who === 'you'),
        eval_error: b.eval ? null : b.evalError,
        turns: b.turns.map((t) => ({ who: t.who, text: t.text })),
        eval: b.eval,
      })),
      interviewer: who,
      options: { role: o.role, level: o.level, company: o.company, persona: o.persona, difficulty: o.difficulty, lang: o.lang, input: o.input, mode: o.mode },
      ai: conn ? { provider: conn.provider, model: conn.model, coach: conn.coachModel || conn.model } : null,
    };
    const body = {
      status: 'completed',
      duration_s: Math.round(st.elapsed / 1000),
      overall,
      scores: Object.fromEntries(rubric.map((r) => [r.id, r.avg])),
      metrics: { words: delivery.words, wpm: delivery.wpm, filler_rate: delivery.filler_rate, latency_s: delivery.latency_s },
      transcript: st.turns.map((t) => ({ who: t.who, text: t.text })),
      report,
    };
    const save = async () => {
      try {
        await api(`/api/sessions/${sid}`, { method: 'PATCH', body });
        sessionStorage.removeItem(storeKey);
        location.href = `/app/session/${sid}`;
      } catch (err) {
        text.replaceChildren(`The report couldn't be saved: ${err.message} `, el('button', { class: 'btn btn-small', type: 'button', onclick: save }, 'Try again'));
      }
    };
    save();
  }

  // ---------------------------------------------------------- lobby and controls

  function drawLobby() {
    const conn = activeConnection();
    const resuming = st.turns.length > 0;
    $('#lobby-mono').textContent = initials(who.name);
    $('#lobby-name').textContent = who.name;
    $('#lobby-role').textContent = `${who.role}${o.company ? `, ${o.company}` : ''}`;
    $('#lobby-title').textContent = resuming ? 'Pick up where you left off' : 'Ready when you are';
    const facts = [
      `${st.blocks.length} questions for ${o.role}, about ${Math.round(((pack.minutes || 20) / (pack.default_count || 5)) * st.blocks.length)} minutes`,
      o.mode === 'practice' ? 'Feedback after each question, and you can redo it' : 'Feedback only at the end',
      useVoice ? 'You answer by speaking. Captions show what was heard.' : 'You answer by typing',
      `Language: ${lang.name}`,
    ];
    if (voiceWanted && !voice.canListen) facts.push("This browser can't listen, so you'll type. Chrome or Edge can listen.");
    $('#lobby-facts').replaceChildren(...facts.map((f) => el('li', {}, f)));
    $('#lobby-ai').replaceChildren(conn
      ? el('p', { class: 'small', style: 'margin:0' }, 'Running on ', el('b', {}, describe(conn)), '. ', el('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: openAIDialog }, 'Change'))
      : el('p', { class: 'error-box small', style: 'margin:0' }, 'No AI connected on this device. ', el('button', { class: 'btn btn-small', type: 'button', onclick: openAIDialog }, 'Connect an AI')));
    $('#lobby-mic').hidden = !useVoice;
    $('#begin').textContent = resuming ? 'Carry on' : 'Start the interview';
    $('#begin').disabled = !conn;
  }
  window.addEventListener('ai-change', drawLobby);

  async function ensureMeter() {
    if (stopMeter || !useVoice) return;
    try {
      stopMeter = await voice.micLevel((v) => {
        level = level * 0.6 + v * 0.4;
        drawMeter();
      });
    } catch {
      // The meter is decoration; recognition reports real microphone problems itself.
    }
  }

  $('#mic-check').addEventListener('click', async () => {
    const result = $('#mic-check-result');
    result.textContent = 'Say something…';
    await ensureMeter();
    if (!stopMeter) {
      result.textContent = "The microphone isn't available. Check the browser permission.";
      return;
    }
    let heard = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (level > 0.12) heard = true;
      if (heard || Date.now() - started > 5000) {
        clearInterval(timer);
        result.textContent = heard ? 'Microphone works.' : "Nothing heard. Check the microphone in your system settings.";
      }
    }, 150);
  });

  $('#begin').addEventListener('click', async () => {
    $('#lobby').hidden = true;
    if (st.phase === 'lobby') st.phase = 'live';
    if (useVoice) {
      await voice.voicesReady();
      ensureMeter();
    }
    clock = setInterval(tick, 1000);
    updatePhase();
    if (st.phase === 'done') return finish();
    if (st.pending) return showFeedback(st.qi);
    const last = st.turns.at(-1);
    if (!last) return intro();
    if (last.who === 'ai') return aiSays(last.text);
    return st.phase === 'wrap' ? closeInterview() : next(st.lastNote || directorNote());
  });

  $('#mic').addEventListener('click', () => (listener?.active ? finishSpeaking() : startListening()));
  $('#done').addEventListener('click', finishSpeaking);
  $('#send').addEventListener('click', sendTyped);
  $('#answer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendTyped();
  });
  $('#type-toggle').addEventListener('click', () => {
    const heard = stopListening();
    showAnswerBox(heard.text);
  });
  $('#repeat').addEventListener('click', () => {
    const lastAI = [...st.turns].reverse().find((t) => t.who === 'ai');
    if (lastAI) {
      stopListening();
      aiSays(lastAI.text);
    }
  });
  $('#skip').addEventListener('click', () => {
    stopListening();
    hideAnswerBox();
    const block = st.blocks[st.qi];
    if (!block.turns.some((t) => t.who === 'you')) block.skipped = true;
    const isLast = st.qi >= st.blocks.length - 1;
    const note = isLast
      ? 'The candidate chose to skip this question. Say that is fine in a few words, then say those are all your questions and ask whether they have any questions for you. Use intent "wrap_up".'
      : `The candidate chose to skip this question. Say that is fine in a few words, then ask the next question in your own words: "${st.blocks[st.qi + 1].q}". Use intent "next".`;
    next(note);
  });
  $('#hint').addEventListener('click', hint);

  function pause() {
    paused = true;
    stopListening();
    voice.stopSpeaking();
    $('#paused').hidden = false;
  }
  $('#pause').addEventListener('click', pause);
  $('#resume').addEventListener('click', () => {
    paused = false;
    $('#paused').hidden = true;
    const last = st.turns.at(-1);
    if (last?.who === 'ai') aiSays(last.text);
  });
  $('#end').addEventListener('click', async () => {
    const answered = st.turns.some((t) => t.who === 'you');
    if (!answered) {
      if (!confirm('End the interview? Nothing has been answered yet, so there will be no report.')) return;
      sessionStorage.removeItem(storeKey);
      await api(`/api/sessions/${sid}`, { method: 'PATCH', body: { status: 'abandoned' } }).catch(() => {});
      location.href = document.querySelector('meta[name="signed-in"]') ? '/app' : '/';
      return;
    }
    if (confirm('End now? You get a report for the questions you answered.')) finish();
  });

  const toggleDrawer = () => {
    const drawer = $('#drawer');
    drawer.hidden = !drawer.hidden;
    $('#toggle-drawer').setAttribute('aria-expanded', String(!drawer.hidden));
    renderTurns();
  };
  $('#toggle-drawer').addEventListener('click', toggleDrawer);
  $('#close-drawer').addEventListener('click', toggleDrawer);
  $('#error-ai').addEventListener('click', openAIDialog);

  document.addEventListener('keydown', (e) => {
    const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape' && !$('#lobby').hidden) return;
    if (e.key === 'Escape' && ['live', 'wrap'].includes(st.phase) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      return paused ? $('#resume').click() : pause();
    }
    if (typing) return;
    if (e.code === 'Space' && useVoice && !$('#mic').disabled) {
      e.preventDefault();
      $('#mic').click();
    } else if (e.key.toLowerCase() === 't') {
      toggleDrawer();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (['live', 'wrap'].includes(st.phase) && !st.finishing) {
      persist();
      e.preventDefault();
    }
  });

  updatePhase();
  setControls(false);
  drawLobby();
}

if ($('#setup-form')) setupPage();
if ($('#room-data')) roomPage();
