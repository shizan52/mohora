// The interview room, plus the interview vocabulary the setup page shares.
//
// The model only voices the interviewer. This file decides what happens next:
// when to follow up, when to move on, when to give feedback and how to score.
// That keeps small free models on track.

import { $, el, api, toast, fill, parseJSON, chat, activeConnection, connections, describe, openAIDialog, AIError } from './app.js';
import { Avatar, personFor } from './avatar.js';
import { runCode } from './code-runner.js';
import * as voice from './voice.js';

export const LEVELS = { intern: 'intern', fresher: 'fresh graduate', junior: 'junior', mid: 'mid-level', senior: 'senior', lead: 'lead or manager' };
export const PERSONAS = {
  friendly: 'warm and encouraging, relaxed pace, patient with pauses',
  neutral: 'professional and neutral, polite and efficient',
  skeptical: 'a skeptical senior interviewer: terse, probes every claim and asks for evidence',
};
export const LANGS = {
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
export const MAX_FOLLOWUPS = { easy: 1, normal: 1, hard: 2 };
export const SOURCE_LABEL = { opener: 'opener', cv: 'from your CV', jd: 'from the job post', role: 'for the role', you: 'your question', review: 'review' };
export const TALK = {
  video: { ask: 'voice', input: 'voice', camera: true, label: 'Video call' },
  voice: { ask: 'voice', input: 'voice', camera: false, label: 'Voice call' },
  listen: { ask: 'voice', input: 'text', camera: false, label: 'Listen and type' },
  read: { ask: 'text', input: 'voice', camera: false, label: 'Read and speak' },
  text: { ask: 'text', input: 'text', camera: false, label: 'Text chat' },
};

const followupLimit = (pack, o) => pack.followups ?? MAX_FOLLOWUPS[o.difficulty] ?? 1;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (x) => Math.round(x * 10) / 10;

export const interviewerFor = (run) =>
  personFor(run.options.interviewer || (run.pack.interviewer.name.startsWith('Tanvir') ? 'tanvir' : 'ayesha'));

export function promptVars(run) {
  const o = run.options;
  const p = run.pack;
  const lang = LANGS[o.lang] || LANGS.en;
  return {
    interviewer_name: interviewerFor(run).name,
    interviewer_role: p.interviewer.role,
    company_part: o.company ? ` at ${o.company}` : '',
    target_role: o.role,
    level: p.about?.level || LEVELS[o.level] || o.level,
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
  o.ask ||= o.input === 'voice' ? 'voice' : 'text';
  const voiceWanted = o.input === 'voice';
  const speaks = o.ask === 'voice' && voice.canSpeak;
  // In a coding round the answer is the code plus a typed explanation.
  const coding = Boolean(pack.editor);
  let useVoice = voiceWanted && voice.canListen && !coding;
  let gaze = null;
  let lastRun = '';
  const person = interviewerFor(run);
  const who = { name: person.name, role: pack.interviewer.role };
  const avatar = new Avatar($('#ai-avatar'), person.id, { mood: o.persona });
  const lobbyAvatar = new Avatar($('#lobby-avatar'), person.id, { mood: o.persona });
  const openaiKey = connections().find((c) => c.provider === 'openai' && c.key && !c.relay)?.key || '';
  const speaker = new voice.Speaker({
    lang: lang.tts, gender: person.gender, settings, openaiKey,
    onLevel: (v) => avatar.setLevel(v),
    onFallback: () => toast('That voice stopped working, so the browser voice takes over.', true),
  });
  let camera = null;

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

  $('#ai-name').textContent = `${who.name}, ${who.role}`;
  $('#title').textContent = `${pack.title}: ${o.role}`;
  $('#meter').replaceChildren(...Array.from({ length: 9 }, () => el('i')));
  if (!useVoice && !o.camera) {
    $('#meter').outerHTML = '<svg class="you-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><div class="meter" id="meter" hidden></div>';
  }

  function setAI(label, mode = 'idle') {
    $('#ai-state').textContent = label;
    $('#tile-ai').classList.toggle('speaking', mode === 'speaking');
    avatar.setState(mode);
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
    if (reply.intent === 'follow_up' && block.followups > followupLimit(pack, o)) {
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
    if (block.followups >= followupLimit(pack, o) || overTime()) return `Move on now, no more follow-ups on this question. ${moveOnNote()}${clarify}`;
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

  async function aiSays(text, { listenAfter = true, reaction = '' } = {}) {
    caption(who.name, text);
    $('#caption').classList.toggle('big', !speaks);
    setControls(false);
    if (reaction) avatar.react(reaction);
    if (speaks) {
      setAI('', 'speaking');
      await speaker.say(text);
    } else {
      setAI('', 'idle');
      await new Promise((r) => setTimeout(r, Math.min(2200, 400 + text.length * 10)));
    }
    setAI('', 'listening');
    lastSpokeAt = performance.now();
    if (listenAfter && !paused && st.phase !== 'done') readyForAnswer();
  }

  function readyForAnswer() {
    setControls(true);
    gaze?.count(true);
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
    setAI('Joining', 'thinking');
    try {
      const reply = shape(await ask('interviewer', buildMessages(note), { json: true, maxTokens: 400, temperature: 0.7 }));
      addTurn('ai', reply.say, { intent: 'next' });
      updatePhase();
      await aiSays(reply.say, { reaction: 'smile' });
    } catch (err) {
      showError(err, intro);
    }
  }

  async function next(note) {
    st.lastNote = note;
    persist();
    setControls(false);
    setAI('Thinking', 'thinking');
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
    if (reply.intent === 'next') {
      st.qi += 1;
      if (coding) clearCode();
    } else if (reply.intent === 'wrap_up') st.phase = 'wrap';
    else if (reply.intent === 'follow_up') st.blocks[st.qi].followups += 1;
    addTurn('ai', reply.say, { intent: reply.intent });
    updatePhase();
    await aiSays(reply.say, { reaction: { follow_up: 'curious', next: 'nod', wrap_up: 'smile' }[reply.intent] || '' });
  }

  async function submitAnswer(text, metrics) {
    text = text.trim().slice(0, coding ? 9000 : 4000);
    if (!text) return toast('Say or type an answer first, or skip the question.');
    gaze?.count(false);
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
    setAI('Thinking', 'thinking');
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
    speaker.stop();
    if (voice.useServerListening(o.lang, settings)) return startRecording();
    listener = new voice.Listener({
      lang: lang.stt,
      silenceMs: (settings.silence || 0) * 1000,
      onText: (finalText, interim) => caption('You', finalText, interim),
      onSilence: () => finishSpeaking(),
      onError: (code) => {
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) {
          micDenied();
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

  function micDenied() {
    toast("The microphone is blocked or missing, so you'll type instead. You can allow it from the address bar.", true);
    useVoice = false;
    stopListening();
    setControls(true);
    showAnswerBox('');
  }

  function startRecording() {
    listener = new voice.Recorder({ lang: o.lang, onError: micDenied });
    listener.start();
    $('#mic').classList.add('on');
    $('#mic').textContent = 'Recording…';
    setYou('Recording', true);
    caption('You', '', 'Recording. Your words appear when you finish.');
  }

  // keep: whether what was said is wanted. A recording is only sent for transcription when it is.
  function stopListening(keep = false) {
    $('#mic').classList.remove('on');
    $('#mic').textContent = 'Start speaking';
    setYou('');
    if (!listener?.active) return { text: '', ms: 0, firstAt: 0 };
    return listener.stop(keep);
  }

  async function finishSpeaking() {
    let heard;
    try {
      setControls(false);
      const waiting = stopListening(true);
      if (waiting instanceof Promise) setYou('Transcribing');
      heard = await waiting;
    } catch (err) {
      toast(`${err.message} Type your answer instead.`, true);
      heard = { text: '' };
      showAnswerBox('');
    }
    setYou('');
    setControls(true);
    if (!heard.text) {
      if ($('#answer-box').hidden) toast("Nothing was heard. Press Start speaking and try again, or type instead.");
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
    $('#answer-info').textContent = info || (text ? '' : coding ? 'Your code and its last output are sent with this.' : 'Write the answer you would say out loud.');
    area.focus();
  }

  function hideAnswerBox() {
    $('#answer-box').hidden = true;
    $('#answer').value = '';
  }

  // The interviewer and the coach read the code and its output as part of the answer.
  function withCode(text) {
    const code = $('#code').value.trim();
    if (!coding || !code) return text;
    const language = $('#code-lang').value;
    return `${text.trim()}\n\nMy code (${language}):\n${code.slice(0, 5000)}\n\nOutput when I ran it:\n${lastRun || '(not run)'}`.trim();
  }

  function clearCode() {
    $('#code').value = '';
    $('#code-output').textContent = 'Output appears here.';
    lastRun = '';
  }

  function sendTyped() {
    const text = withCode($('#answer').value);
    const metrics = reviewMetrics
      ? { ...reviewMetrics, ...voice.analyze(text, { lang: o.lang, ms: reviewMetrics.ms }) }
      : { ...voice.analyze(text, { lang: o.lang }), typed: true };
    reviewMetrics = null;
    submitAnswer(text, metrics);
  }

  // ---------------------------------------------------------- feedback

  // Generic feedback is the main complaint about interview tools, so for structured answers
  // the coach must also say which named parts (Situation, Task, Action, Result) were there.
  const partsRule = pack.parts
    ? `\n\nAlso add "parts" to the JSON: {${pack.parts.map((name) => `"${name}": true or false`).join(', ')}}. A part is true only if the candidate clearly covered it.`
    : '';

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
      parts: pack.parts && data.parts && typeof data.parts === 'object'
        ? Object.fromEntries(pack.parts.map((name) => [name, data.parts[name] === true || data.parts[name] === 'true']))
        : null,
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
    }) + partsRule;
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
      result.parts ? el('div', { class: 'parts' }, Object.entries(result.parts).map(([name, ok]) => el('span', { class: ok ? 'part ok' : 'part miss' }, ok ? name : `${name} missing`))) : '',
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
    speaker.stop();
    clearInterval(clock);
    stopMeter?.();
    camera?.getTracks().forEach((t) => t.stop());
    setAI('', 'idle');
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
    delivery.camera = gaze?.stop() || null;
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
      options: { role: o.role, level: o.level, company: o.company, persona: o.persona, difficulty: o.difficulty, lang: o.lang, talk: o.talk, input: o.input, mode: o.mode, interviewer: person.id },
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
    $('#lobby-name').textContent = who.name;
    $('#lobby-role').textContent = `${who.role}${o.company ? `, ${o.company}` : ''}`;
    $('#lobby-title').textContent = resuming ? 'Pick up where you left off' : 'Ready when you are';
    const facts = [
      `${st.blocks.length} questions for ${o.role}, about ${Math.round(((pack.minutes || 20) / (pack.default_count || 5)) * st.blocks.length)} minutes`,
      o.mode === 'practice' ? 'Feedback after each question, and you can redo it' : 'Feedback only at the end',
      `${(TALK[o.talk] || TALK.text).label}: ${speaks ? 'the interviewer speaks' : 'questions appear as text'}, ${useVoice ? 'you answer out loud' : 'you type your answers'}${o.camera ? ', camera on (it stays on your device)' : ''}`,
      `Language: ${lang.name}`,
    ];
    if (voiceWanted && !voice.canListen) facts.push("This browser can't listen, so you'll type. Chrome or Edge can listen.");
    $('#lobby-facts').replaceChildren(...facts.map((f) => el('li', {}, f)));
    $('#lobby-ai').replaceChildren(conn
      ? el('p', { class: 'small', style: 'margin:0' }, 'Running on ', el('b', {}, describe(conn)), '. ', el('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: openAIDialog }, 'Change'))
      : el('p', { class: 'error-box small', style: 'margin:0' }, 'No AI connected on this device. ', el('button', { class: 'btn btn-small', type: 'button', onclick: openAIDialog }, 'Connect an AI')));
    $('#lobby-mic').hidden = !useVoice;
    drawVoiceChoice();
    $('#begin').textContent = resuming ? 'Carry on' : 'Start the interview';
    $('#begin').disabled = !conn;
  }
  window.addEventListener('ai-change', drawLobby);

  function drawVoiceChoice() {
    const box = $('#lobby-voice');
    box.hidden = !speaks;
    if (!speaks) return;
    const parts = [el('span', { class: 'small' }, `Voice: ${speaker.label}.`)];
    if (speaker.canUpgrade) {
      parts.push(' ', el('button', { class: 'btn btn-small', type: 'button', onclick: upgradeVoice }, 'Use a more natural voice (about 90 MB, once)'));
    }
    box.replaceChildren(...parts);
  }

  async function upgradeVoice() {
    const box = $('#lobby-voice');
    const bar = el('i', { style: '--p:2%' });
    box.replaceChildren(el('span', { class: 'small' }, 'Downloading the natural voice. You can start meanwhile; it switches on when ready.'), el('div', { class: 'progress', style: 'margin-top:.5rem' }, bar));
    try {
      await speaker.useNatural((p) => bar.style.setProperty('--p', `${Math.max(2, Math.round(p))}%`));
      toast('The natural voice is ready.');
    } catch (err) {
      toast(err.message, true);
    }
    drawVoiceChoice();
  }

  async function startCamera() {
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
      const video = el('video', { autoplay: true, playsinline: true, 'aria-label': 'Your camera' });
      video.muted = true;
      video.srcObject = camera;
      $('#tile-you').prepend(video);
      $('#tile-you').classList.add('camera');
      $('#meter').classList.add('over');
      // Eye-contact estimates are a bonus: if the model can't load, the call goes on without them.
      import('./gaze.js').then(({ watchFace }) => watchFace(video)).then((watcher) => (gaze = watcher)).catch(() => {});
    } catch {
      toast("The camera isn't available, so this runs as a voice call.", true);
    }
  }

  async function ensureMeter() {
    if (stopMeter || !useVoice) return;
    try {
      stopMeter = await voice.micLevel((v) => {
        level = level * 0.6 + v * 0.4;
        avatar.setHeard(listener?.active ? level : 0);
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
    speaker.unlock();
    if (useVoice) ensureMeter();
    if (o.camera) startCamera();
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
  $('#type-toggle').addEventListener('click', async () => {
    const heard = await Promise.resolve(stopListening(true)).catch(() => ({ text: '' }));
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
    speaker.stop();
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

  if (coding) {
    $('.stage').classList.add('coding');
    $('#code-panel').hidden = false;
    $('#answer').placeholder = 'Explain your approach here. Your code and its output are sent with it.';
    $('#code').addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      e.target.setRangeText('    ', e.target.selectionStart, e.target.selectionEnd, 'end');
    });
    $('#run').addEventListener('click', async () => {
      const code = $('#code').value;
      if (!code.trim()) return;
      $('#run').disabled = true;
      $('#run-status').textContent = $('#code-lang').value === 'python' ? 'Running (the first Python run loads the runtime)…' : 'Running…';
      lastRun = await runCode($('#code-lang').value, code);
      $('#code-output').textContent = lastRun;
      $('#run-status').textContent = '';
      $('#run').disabled = false;
    });
  }

  updatePhase();
  setControls(false);
  drawLobby();
  voice.voicesReady().then(() => {
    speaker.engine = speaker.pickEngine();
    drawVoiceChoice();
  });
  lobbyAvatar.react('smile', 2500);
}

if ($('#room-data')) roomPage();
