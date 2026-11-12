// The interview setup wizard: CV first, then the job, what to practise, how to talk,
// and finally the questions, which are written by the user's own AI and can be edited.

import { $, $$, el, api, track, fill, parseJSON, chat, activeConnection, describe, openAIDialog, AIError } from './app.js';
import { Avatar } from './avatar.js';
import * as voice from './voice.js';
import { MAX_FOLLOWUPS, SOURCE_LABEL, TALK, promptVars } from './room.js';

const data = JSON.parse($('#setup-data').textContent);
const form = $('#setup-form');
const packs = Object.fromEntries(data.packs.map((p) => [p.slug, p]));
const state = { step: 1, reached: 1, cv: '', profile: null, roles: [], topics: [], plan: null, stale: false, journey: null, touched: new Set() };

const val = (name) => form.elements[name]?.value ?? '';
const jd = () => $('#jd').value.trim();
const coachModel = (conn) => conn.coachModel || conn.model;

function options() {
  const talk = val('talk') || 'text';
  const mode = TALK[talk];
  // Interviews that aren't about a job (visa, IELTS, viva) describe themselves instead of using the job title.
  const about = val('scope') === 'journey' ? null : packs[val('pack')]?.about;
  return {
    role: (about ? val('subject').trim() || about.default : val('role').trim()).slice(0, 120),
    level: val('level') || 'junior',
    company: val('company').trim().slice(0, 120),
    persona: val('persona'),
    difficulty: val('difficulty'),
    lang: val('lang'),
    talk,
    ask: mode.ask,
    input: voice.canListen ? mode.input : 'text',
    camera: mode.camera,
    mode: val('mode'),
    interviewer: val('interviewer'),
    count: Math.min(12, Math.max(2, Number(val('count')) || 5)),
    instructions: val('instructions').trim().slice(0, 600),
    own: val('own').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10),
    scope: val('scope'),
    stages: $$('input[name="stage"]:checked').map((i) => i.value),
  };
}

function currentPack() {
  const o = options();
  if (o.scope === 'journey') {
    const index = state.journey?.index ?? 0;
    return packs[(state.journey?.stages || o.stages)[index]] || data.packs[0];
  }
  return packs[val('pack')] || data.packs[0];
}

function showError(message) {
  const box = $('#setup-error');
  box.textContent = message;
  box.hidden = !message;
  if (message) $(`[data-step="${state.step}"] .wiz-nav`).before(box);
}

// ------------------------------------------------------------------ steps

function validate(step) {
  const o = options();
  if (step === 2 && !o.role) return 'Add the job title, so the questions fit the job.';
  if (step === 3 && o.scope === 'journey') {
    if (!data.has_pass) return 'The whole hiring process needs Pro. Choose “One interview” to practise a single step for free.';
    if (!o.stages.length) return 'Keep at least one step of the hiring process.';
  }
  if (step === 3 && o.scope === 'single' && currentPack().needs_jd && !jd()) return 'This interview type needs a job description. Go back to step 2 and paste it.';
  if (step === 3 && o.scope === 'single' && currentPack().pro && !data.has_pass) {
    if (!data.signed_in) return 'Sign in to try this interview type once for free.';
    if (data.tried.includes(currentPack().slug)) return "You've used your free try of this interview type. Pro unlocks it.";
  }
  return '';
}

function go(step) {
  for (let s = state.step; s < step; s++) {
    const problem = validate(s);
    if (problem) return showError(problem);
  }
  showError('');
  state.step = step;
  state.reached = Math.max(state.reached, step);
  for (const section of $$('[data-step]', form)) section.hidden = Number(section.dataset.step) !== step;
  $$('#stepper button').forEach((b) => {
    const n = Number(b.dataset.goto);
    b.toggleAttribute('aria-current', n === step);
    if (n === step) b.setAttribute('aria-current', 'step');
    b.classList.toggle('done', n < step);
    b.disabled = n > state.reached;
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (step === 5) {
    renderTopics();
    if (!state.plan || state.stale) buildPlan();
  }
}

form.addEventListener('click', (e) => {
  if (e.target.closest('[data-next]')) go(state.step + 1);
  if (e.target.closest('[data-back]')) go(state.step - 1);
});
$('#stepper').addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b && !b.disabled) go(Number(b.dataset.goto));
});

// ------------------------------------------------------------------ AI connection

function drawAI() {
  const conn = activeConnection();
  $('#ai-box').replaceChildren(conn
    ? el('div', { class: 'spread' },
      el('span', { class: 'small' }, 'Your interviewer runs on ', el('b', {}, describe(conn)), '.'),
      el('button', { type: 'button', class: 'btn btn-small', onclick: openAIDialog }, 'Change'))
    : el('div', { class: 'spread' },
      el('span', { class: 'small' }, el('b', {}, 'Connect an AI first. '), 'Sign in with OpenRouter, or paste a free Gemini or Groq key.'),
      el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: openAIDialog }, 'Connect an AI')));
}
window.addEventListener('ai-change', () => {
  drawAI();
  if (state.cv && !state.profile) analyzeCV();
});

// ------------------------------------------------------------------ CV

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

function setStatus(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.className = `small${kind ? ` status-${kind}` : ''}`;
}

function setCV(text, note, name = 'pasted text') {
  state.cv = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
  state.profile = null;
  state.stale = true;
  setStatus('#cv-status', note, 'ok');
  $('#cv-clear').hidden = !state.cv;
  $('#skip-cv').hidden = Boolean(state.cv);
  if ($('#cv-remember').checked) saveCV(name);
  try {
    sessionStorage.setItem('mohora.cv.session', state.cv);
  } catch {}
  if (state.cv) analyzeCV();
}

function saveCV(name) {
  try {
    localStorage.setItem('mohora.cv', JSON.stringify({ name, text: state.cv }));
  } catch {}
}

async function readFile(file) {
  setStatus('#cv-status', `Reading ${file.name}…`);
  try {
    const { text, note } = await extractText(file);
    if (text.trim().length < 80) throw new Error('No text found in this file. If it is a scanned image, paste the text instead.');
    setCV(text, `Read ${file.name} (${note}).`, file.name);
  } catch (err) {
    setStatus('#cv-status', err.message, 'bad');
  }
}

async function analyzeCV() {
  const conn = activeConnection();
  const box = $('#found');
  if (!conn) {
    box.hidden = false;
    box.replaceChildren(el('p', { class: 'note small' }, 'Connect an AI above and we\'ll read your CV, suggest roles that fit and list the topics an interviewer will ask about.'));
    return;
  }
  box.hidden = false;
  box.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'muted', style: 'margin:0' }, 'Reading your CV…'), el('div', { class: 'progress', style: 'margin-top:.8rem' }, el('i', { style: '--p:60%' }))));
  try {
    const prompt = fill(data.prompts.profile, { cv: state.cv.slice(0, 9000) });
    const result = parseJSON(await chat(conn, [{ role: 'user', content: prompt }], { json: true, model: coachModel(conn), maxTokens: 1200, temperature: 0.3 }));
    if (!result?.profile) throw new AIError("The AI couldn't read the CV. Try again, or pick another model.", 'parse');
    state.profile = result.profile;
    state.roles = (result.roles || []).filter((r) => r?.title).slice(0, 5);
    state.topics = (result.topics || []).filter((t) => t?.label).slice(0, 10).map((t) => ({ ...t, on: true }));
    track('plan_built', { step: 'cv', topics: state.topics.length });
    if (!val('role') && state.roles[0]) applyRole(state.roles[0]);
    if (!state.touched.has('level') && result.profile.level && form.querySelector(`input[name="level"][value="${result.profile.level}"]`)) {
      form.elements.level.value = result.profile.level;
    }
    renderFound();
    renderRoleChips();
  } catch (err) {
    box.replaceChildren(el('div', { class: 'error-box' }, err.message, ' ', el('button', { type: 'button', class: 'btn btn-small', onclick: analyzeCV }, 'Try again')));
  }
}

function applyRole(role) {
  form.elements.role.value = role.title;
  if (role.level && form.querySelector(`input[name="level"][value="${role.level}"]`)) form.elements.level.value = role.level;
  state.stale = true;
  renderRoleChips();
}

function roleChip(role) {
  return el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(val('role') === role.title),
    title: role.why || '', onclick: () => applyRole(role),
  }, role.title, role.level ? el('small', {}, levelName(role.level)) : '');
}

const levelName = (level) => ({ intern: 'internship', fresher: 'fresh graduate', junior: 'junior', mid: 'mid-level', senior: 'senior', lead: 'lead' }[level] || level);

function renderFound() {
  const p = state.profile;
  $('#found').replaceChildren(el('div', { class: 'panel stack', style: '--gap:.9rem' },
    el('div', {},
      el('p', { class: 'faint small', style: 'margin:0' }, 'What we found in your CV'),
      el('h3', { style: 'margin:.2rem 0 0' }, [p.name, p.headline].filter(Boolean).join(', '))),
    p.skills?.length ? el('div', { class: 'chips' }, p.skills.slice(0, 10).map((s) => el('span', { class: 'tag' }, s))) : '',
    state.roles.length ? el('div', {}, el('b', { class: 'small' }, 'Roles that fit you'), el('div', { class: 'chips', style: 'margin-top:.45rem' }, state.roles.map(roleChip))) : '',
    state.topics.length ? el('p', { class: 'small muted', style: 'margin:0' }, `${state.topics.length} topics an interviewer is likely to ask about are ready for step 5.`) : ''));
}

function renderRoleChips() {
  $('#role-chips').replaceChildren(...state.roles.map(roleChip));
  if (state.profile) renderFound();
}

function renderTopics() {
  const field = $('#topics-field');
  field.hidden = !state.topics.length;
  $('#topics').replaceChildren(...state.topics.map((topic) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(topic.on), title: topic.detail || '',
    onclick: (e) => {
      topic.on = !topic.on;
      e.currentTarget.setAttribute('aria-pressed', String(topic.on));
      state.stale = true;
      setStatus('#plan-status', 'Topics changed. Prepare the questions again to use them.');
    },
  }, topic.label, topic.kind === 'gap' ? el('small', {}, 'gap') : '')));
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
$('#cv-text').addEventListener('change', (e) => e.target.value.trim() && setCV(e.target.value, 'Using the text you pasted.'));
$('#cv-clear').addEventListener('click', () => {
  Object.assign(state, { cv: '', profile: null, roles: [], topics: [], stale: true });
  $('#cv-text').value = '';
  $('#cv-file').value = '';
  setStatus('#cv-status', '');
  $('#cv-clear').hidden = true;
  $('#skip-cv').hidden = false;
  $('#found').hidden = true;
  $('#role-chips').replaceChildren();
  localStorage.removeItem('mohora.cv');
  sessionStorage.removeItem('mohora.cv.session');
  $('#cv-remember').checked = false;
});
$('#cv-remember').addEventListener('change', (e) => (e.target.checked ? saveCV('your CV') : localStorage.removeItem('mohora.cv')));

// ------------------------------------------------------------------ CV against the job

$('#match-btn').addEventListener('click', async () => {
  const conn = activeConnection();
  if (!state.cv) return setStatus('#match-status', 'Add your CV in step 1 first.', 'bad');
  if (!jd()) return setStatus('#match-status', 'Paste the job description first.', 'bad');
  if (!conn) return openAIDialog();
  setStatus('#match-status', 'Comparing…');
  const lang = { en: 'English', bn: 'Bangla (Bengali script)', mixed: 'simple Bangla with English terms' }[val('lang')] || 'English';
  try {
    const raw = await chat(conn, [{ role: 'user', content: fill(data.prompts.match, { cv: state.cv.slice(0, 9000), jd: jd().slice(0, 6000), feedback_language: lang }) }],
      { json: true, model: coachModel(conn), maxTokens: 1000, temperature: 0.3 });
    const m = parseJSON(raw);
    if (!m || typeof m.score !== 'number') throw new AIError("The comparison couldn't be read. Try again.", 'parse');
    const score = Math.max(0, Math.min(100, Math.round(m.score)));
    const list = (title, items) => (items?.length ? el('div', {}, el('b', { class: 'small' }, title), el('ul', { class: 'small', style: 'margin:.3rem 0 0' }, items.slice(0, 4).map((x) => el('li', {}, String(x))))) : '');
    const box = $('#match');
    box.hidden = false;
    box.replaceChildren(
      el('div', { class: 'spread' }, el('div', { class: 'match-score' }, el('b', {}, score), el('span', { class: 'faint' }, '/ 100 likely to pass screening')), el('span', { class: `tag ${score >= 70 ? 'tag-you' : score >= 45 ? 'tag-jd' : ''}` }, score >= 70 ? 'Strong match' : score >= 45 ? 'Partial match' : 'Weak match')),
      el('div', { class: `bar${score < 45 ? ' low' : score >= 70 ? ' high' : ''}`, style: 'margin:.7rem 0 1rem' }, el('i', { style: `--v:${score / 20}` })),
      m.verdict ? el('p', {}, String(m.verdict)) : '',
      el('div', { class: 'grid-2' }, list('Strengths', m.strengths), list('Missing for this job', m.gaps)),
      m.keywords?.length ? el('div', { style: 'margin-top:.8rem' }, el('b', { class: 'small' }, 'Words from the job post your CV lacks'), el('div', { class: 'chips', style: 'margin-top:.4rem' }, m.keywords.slice(0, 8).map((k) => el('span', { class: 'tag tag-jd' }, String(k))))) : '',
      list('Fix your CV for this job', m.fixes));
    setStatus('#match-status', '');
  } catch (err) {
    setStatus('#match-status', err.message, 'bad');
  }
});

// ------------------------------------------------------------------ questions

function fromBank(p, count) {
  const shuffled = [...(p.bank || [])].sort(() => Math.random() - 0.5);
  if (p.sections) {
    // A fixed running order, like the three parts of a speaking test.
    return p.sections
      .flatMap((section) => shuffled.filter((item) => item.c === section.c).slice(0, section.n))
      .map((item, i) => ({ q: item.q, competency: item.c, source: i === 0 ? 'opener' : 'role', why: '' }));
  }
  const picked = [{ q: p.opener, competency: '', source: 'opener', why: 'Warms up and frames the rest' }];
  const pool = shuffled.sort((a, b) => (a.d || 2) - (b.d || 2));
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
  const p = currentPack();
  showError('');
  if (!o.role) return showError('Add the job title in step 2 first.');
  const own = o.own.map((q) => ({ q, competency: '', source: 'you', why: 'You asked for this one' }));
  const count = Math.max(1, (o.scope === 'journey' ? p.default_count || 5 : o.count) - own.length);
  const topics = state.topics.filter((t) => t.on);
  const needsAI = !p.sections && (p.needs_plan || state.cv || jd() || o.instructions);
  const button = $('#plan-btn');

  if (!needsAI) {
    state.plan = fromBank(p, count);
  } else {
    const conn = activeConnection();
    if (!conn) {
      openAIDialog();
      return showError('Connect an AI first. It writes the questions.');
    }
    button.disabled = true;
    setStatus('#plan-status', state.cv ? 'Writing questions from your CV…' : 'Writing questions…');
    const mixRule = !state.cv
      ? 'There is no CV. Use the role and the job description.'
      : topics.length ? 'Ask about the chosen CV topics first, then add standard questions for the role.' : 'Use standard questions for the role, and the CV only where it helps.';
    const prompt = fill(data.prompts.plan, {
      ...promptVars({ pack: p, options: o, profile: null, jd: '' }),
      competencies: (p.competencies || []).join(', ') || 'whatever matters most for this role',
      count,
      mix_rule: mixRule,
      topics: topics.length ? topics.map((t) => `${t.label}${t.detail ? ` (${t.detail})` : ''}`).join('; ') : 'none chosen',
      focus: o.instructions || 'nothing specific',
      bank_examples: (p.bank || []).slice(0, 5).map((b) => `- ${b.q}`).join('\n') || '(none)',
      jd: jd().slice(0, 6000),
      cv: state.cv.slice(0, 9000),
      opener: p.opener,
    });
    try {
      const result = parseJSON(await chat(conn, [{ role: 'user', content: prompt }], { json: true, model: coachModel(conn), maxTokens: 1600, temperature: 0.6 }));
      const questions = (result?.questions || []).filter((q) => q && typeof q.q === 'string' && q.q.trim());
      if (!questions.length) throw new AIError("The AI didn't send back a question list. Try again, or pick another model.", 'parse');
      state.plan = questions.slice(0, count).map((q, i) => ({
        q: q.q.trim(), competency: String(q.competency || ''), why: String(q.why || ''),
        source: i === 0 ? 'opener' : ['cv', 'jd', 'role'].includes(q.source) ? q.source : 'role',
      }));
      track('plan_built', { pack: p.slug, cv: Boolean(state.cv), jd: Boolean(jd()) });
    } catch (err) {
      setStatus('#plan-status', '');
      button.disabled = false;
      return showError(err.message);
    }
    button.disabled = false;
  }
  state.plan.splice(1, 0, ...own);
  state.stale = false;
  setStatus('#plan-status', `${p.title}: ${state.plan.length} questions ready. Edit anything you like.`, 'ok');
  button.textContent = 'Write new questions';
  renderPlan();
}

function renderPlan() {
  $('#plan').replaceChildren(...state.plan.map((item, i) => {
    const area = el('textarea', { rows: 2, 'aria-label': `Question ${i + 1}` });
    area.value = item.q;
    area.addEventListener('input', () => (item.q = area.value));
    return el('li', {},
      el('div', {}, area, item.why ? el('div', { class: 'why' }, item.why) : ''),
      el('div', { style: 'text-align:right' },
        el('span', { class: `tag tag-${item.source}` }, SOURCE_LABEL[item.source] || item.source),
        el('div', {}, el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { state.plan.splice(i, 1); renderPlan(); } }, 'Remove'))));
  }));
  $('#plan-add').hidden = false;
  $('#start-btn').disabled = state.plan.length === 0;
  estimate();
}

function addOwn() {
  const input = $('#add-q');
  const q = input.value.trim();
  if (!q) return;
  state.plan ||= [];
  state.plan.push({ q, competency: '', source: 'you', why: 'You asked for this one' });
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
$('#plan-btn').addEventListener('click', buildPlan);

function estimate() {
  const o = options();
  const n = state.plan?.length || o.count;
  const turns = 2 + n * (1 + MAX_FOLLOWUPS[o.difficulty || 'normal'] * 0.7);
  const tokens = Math.round((turns * 1900 + n * 1800 + 1500 + (state.cv ? 1600 + state.cv.length / 3.5 : 0)) / 1000);
  $('#estimate').textContent = `About ${Math.round(turns + n + 2)} AI calls, ${tokens}k tokens`;
}

// ------------------------------------------------------------------ start

$('#start-btn').addEventListener('click', async () => {
  const o = options();
  const p = currentPack();
  const questions = (state.plan || []).map((q) => ({ ...q, q: q.q.trim() })).filter((q) => q.q);
  if (!o.role) return showError('Add the job title in step 2.');
  if (!questions.length) return showError('Prepare the questions first.');
  if (!activeConnection()) {
    openAIDialog();
    return showError('Connect an AI first.');
  }
  const button = $('#start-btn');
  button.disabled = true;
  button.textContent = 'Opening the room…';
  let journey = null;
  if (o.scope === 'journey') {
    journey = state.journey || { id: crypto.randomUUID().slice(0, 8), stages: o.stages, index: 0 };
  }
  try {
    const config = {
      role: o.role, level: o.level, company: o.company, persona: o.persona, difficulty: o.difficulty, lang: o.lang,
      talk: o.talk, ask: o.ask, input: o.input, camera: o.camera, mode: o.mode, interviewer: o.interviewer,
      has_cv: Boolean(state.cv), has_jd: Boolean(jd()), questions: questions.map(({ q, source }) => ({ q, source })),
      ...(journey ? { journey } : {}),
    };
    const { id } = await api('/api/sessions', { method: 'POST', body: { pack: p.slug, config } });
    const run = { pack: p, options: o, plan: questions, profile: state.profile, jd: jd().slice(0, 1500), journey };
    sessionStorage.setItem(`mohora.run.${id}`, JSON.stringify(run));
    const { own, instructions, ...kept } = o;
    localStorage.setItem('mohora.setup.last', JSON.stringify({ ...kept, pack: p.slug }));
    if (journey) {
      localStorage.setItem('mohora.journey', JSON.stringify({ ...journey, options: kept, jd: jd(), profile: state.profile, topics: state.topics, roles: state.roles }));
    }
    location.href = `/app/room/${id}`;
  } catch (err) {
    showError(err.message);
    button.disabled = false;
    button.textContent = 'Start the interview';
  }
});

// ------------------------------------------------------------------ wiring and presets

function onScope() {
  const journey = val('scope') === 'journey';
  $('#scope-single').hidden = journey;
  $('#scope-journey').hidden = !journey;
  $('#count-field').hidden = journey;
  state.stale = true;
}

function onPack() {
  const p = currentPack();
  if (!state.touched.has('count')) form.elements.count.value = p.default_count || 5;
  $('#jd-optional').textContent = p.needs_jd ? '(needed for Job description match)' : '(optional)';
  if (!state.touched.has('talk') && p.ask === 'text' && p.input === 'text') form.elements.talk.value = 'text';
  const single = val('scope') === 'single';
  const about = single ? p.about : null;
  $('#subject-field').hidden = !about?.label;
  $('#subject-label').textContent = about?.label || '';
  $('#subject').placeholder = about?.placeholder || '';
  $('#role-hint').hidden = !about;
  $('#role-hint').textContent = about ? `Not needed for ${p.title}. You can leave this empty.` : '';
  $('#pack-note').hidden = !(single && p.note);
  $('#pack-note').textContent = p.note || '';
  if (p.lang) form.elements.lang.value = p.lang;
  state.stale = true;
}

form.addEventListener('change', (e) => {
  const name = e.target.name;
  if (name) state.touched.add(name);
  if (name === 'scope') onScope();
  if (['pack', 'stage', 'scope'].includes(name)) onPack();
  if (name === 'persona') avatars.forEach((a) => a.setMood(val('persona')));
  if (['role', 'subject', 'level', 'company', 'lang', 'count', 'jd', 'instructions', 'own', 'difficulty'].includes(name)) state.stale = true;
  if (state.plan && state.stale && state.step === 5) setStatus('#plan-status', 'You changed something. Write new questions, or start with these.');
  estimate();
});

if (!voice.canListen) {
  for (const talk of ['video', 'voice', 'read']) {
    const input = form.querySelector(`input[name="talk"][value="${talk}"]`);
    input.disabled = true;
    input.closest('label').style.opacity = '0.5';
  }
  form.elements.talk.value = 'listen';
  $('#talk-note').textContent = 'Speaking your answers needs Chrome or Edge. In this browser you can listen and type, or use text chat.';
}

const avatars = $$('[data-person]').map((host) => new Avatar(host, host.dataset.person, { mood: 'neutral' }));

function applyPreset(preset) {
  for (const name of ['role', 'level', 'company', 'persona', 'difficulty', 'lang', 'talk', 'mode', 'interviewer']) {
    if (preset[name] && form.elements[name] && !(form.elements[name].disabled)) form.elements[name].value = preset[name];
  }
}

function loadSavedCV() {
  let text = '';
  try {
    const saved = JSON.parse(localStorage.getItem('mohora.cv') || 'null');
    if (saved?.text) {
      text = saved.text;
      $('#cv-remember').checked = true;
    }
  } catch {}
  text ||= sessionStorage.getItem('mohora.cv.session') || '';
  return text;
}

function init() {
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem('mohora.setup.last') || 'null');
  } catch {}
  applyPreset(data.previous || last || {});
  if (data.role) form.elements.role.value = data.role;
  if (data.ask) $('#own').value = data.ask;
  const packSlug = data.selected || data.previous?.pack;
  if (packs[packSlug]) form.elements.pack.value = packSlug;
  if (data.previous?.questions?.length) state.plan = data.previous.questions.map((q) => ({ why: '', competency: '', ...q }));

  const cv = loadSavedCV();
  if (cv) {
    state.cv = cv;
    setStatus('#cv-status', 'Using the CV saved on this device.', 'ok');
    $('#cv-clear').hidden = false;
    $('#skip-cv').hidden = true;
  }

  if (data.journey_param === 'start') form.elements.scope.value = 'journey';
  if (data.journey_param === 'next') {
    const saved = JSON.parse(localStorage.getItem('mohora.journey') || 'null');
    if (saved && saved.index + 1 < saved.stages.length) {
      state.journey = { id: saved.id, stages: saved.stages, index: saved.index + 1 };
      applyPreset(saved.options || {});
      form.elements.scope.value = 'journey';
      $$('input[name="stage"]').forEach((i) => (i.checked = saved.stages.includes(i.value)));
      $('#jd').value = saved.jd || '';
      Object.assign(state, { profile: saved.profile, topics: saved.topics || [], roles: saved.roles || [], reached: 5 });
      const stage = data.journey.find((s) => s.pack === saved.stages[state.journey.index]);
      const banner = $('#journey-banner');
      banner.hidden = false;
      banner.textContent = `Hiring process, step ${state.journey.index + 1} of ${saved.stages.length}: ${stage?.title || currentPack().title}. Your settings carry over from the last step.`;
    }
  }
  onScope();
  onPack();
  drawAI();
  if (state.cv && !state.journey) analyzeCV();
  go(state.journey ? 5 : 1);
  if (state.plan && !state.stale) renderPlan();
}

init();
