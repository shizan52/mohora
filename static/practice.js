// Between interviews: drills on weak answers, the goal, the story bank, and sharing a report.

import { $, $$, el, api, toast, fill, parseJSON, chat, activeConnection, openAIDialog } from './app.js';
import { canListen } from './voice.js';

const STAR = ['situation', 'task', 'action', 'result'];

function saved(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') || {};
  } catch {
    return {};
  }
}

// A drill is a short interview made only of questions the person answered weakly before.
// It reuses the interview room, with the settings from their last interview.
async function startDrill(button) {
  if (!activeConnection()) {
    openAIDialog();
    return toast('Connect an AI first. It plays the interviewer.');
  }
  button.disabled = true;
  try {
    const { pack, questions } = await api('/api/drill');
    const last = saved('mohora.setup.last');
    const goal = JSON.parse($('#practice-data').textContent).goal || {};
    const talk = last.talk || 'text';
    const options = {
      role: pack.about ? pack.about.default : goal.role || last.role || 'the role',
      level: goal.level || last.level || 'junior',
      company: '',
      persona: last.persona || 'neutral',
      difficulty: 'normal',
      lang: pack.lang || last.lang || 'en',
      talk,
      ask: ['video', 'voice', 'listen'].includes(talk) ? 'voice' : 'text',
      input: ['video', 'voice', 'read'].includes(talk) && canListen ? 'voice' : 'text',
      camera: talk === 'video',
      mode: 'practice',
      interviewer: last.interviewer || 'ayesha',
      instructions: '',
    };
    const plan = questions.map((q) => ({ q, source: 'review', competency: '', why: '' }));
    const config = { ...options, drill: true, questions: plan.map(({ q, source }) => ({ q, source })) };
    const { id } = await api('/api/sessions', { method: 'POST', body: { pack: pack.slug, config } });
    sessionStorage.setItem(`mohora.run.${id}`, JSON.stringify({ pack, options, plan, profile: null, jd: '', journey: null }));
    location.href = `/app/room/${id}`;
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

function dashboard() {
  for (const button of $$('[data-drill]')) button.addEventListener('click', () => startDrill(button));
  const dialog = $('#goal-dialog');
  for (const button of $$('[data-open-goal]')) button.addEventListener('click', () => dialog.showModal());
  $('#goal-edit').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me', { method: 'POST', body: { goal: Object.fromEntries(new FormData(e.target)) } });
      location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// Asks the person's own AI to sort what they said into Situation, Task, Action, Result.
async function tidyStory(prompt, question, text) {
  const conn = activeConnection();
  if (!conn) throw new Error('Connect an AI first.');
  const raw = await chat(conn, [{ role: 'user', content: fill(prompt, { question, story: text.slice(0, 4000) }) }],
    { json: true, model: conn.coachModel || conn.model, maxTokens: 900, temperature: 0.3 });
  const story = parseJSON(raw);
  if (!story || !STAR.some((part) => story[part])) throw new Error("The AI didn't send back a story. Try again, or pick another model.");
  return story;
}

function storyFields(form) {
  const data = new FormData(form);
  const fields = { title: String(data.get('title') || '').trim(), tags: data.getAll('tags') };
  for (const part of STAR) fields[part] = String(data.get(part) || '').trim();
  return fields;
}

function storiesPage() {
  const prompt = JSON.parse($('#story-prompt').textContent);
  $('#add-story').addEventListener('click', () => {
    const form = $('#new-story');
    form.hidden = false;
    $('#no-stories')?.remove();
    form.elements.title.focus();
  });

  for (const form of $$('form.story')) {
    const status = $('[data-status]', form);
    const say = (text, kind = '') => {
      status.textContent = text;
      status.className = `small${kind ? ` status-${kind}` : ''}`;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = storyFields(form);
      if (form.dataset.story) body.id = Number(form.dataset.story);
      try {
        await api('/api/stories', { method: 'POST', body });
        if (!body.id) return location.reload();
        say('Saved.', 'ok');
      } catch (err) {
        say(err.message, 'bad');
      }
    });

    $('[data-improve]', form).addEventListener('click', async (e) => {
      const button = e.currentTarget;
      const fields = storyFields(form);
      const text = STAR.map((part) => fields[part]).filter(Boolean).join('\n');
      if (text.length < 40) return say('Write a few sentences in any box first. The AI sorts them into the four parts.', 'bad');
      if (!activeConnection()) return openAIDialog();
      button.disabled = true;
      say('Tidying…');
      try {
        const story = await tidyStory(prompt, fields.title, text);
        for (const part of STAR) form.elements[part].value = story[part] || fields[part];
        if (!fields.title && story.title) form.elements.title.value = story.title;
        for (const box of $$('input[name="tags"]', form)) box.checked = box.checked || (story.tags || []).includes(box.value);
        say('Check that it still says what happened, then save.', 'ok');
      } catch (err) {
        say(err.message, 'bad');
      }
      button.disabled = false;
    });

    $('[data-delete]', form)?.addEventListener('click', async () => {
      if (!confirm('Delete this story?')) return;
      try {
        await api(`/api/stories/${form.dataset.story}`, { method: 'DELETE' });
        form.remove();
      } catch (err) {
        say(err.message, 'bad');
      }
    });
  }
}

function reportPage() {
  const data = JSON.parse($('#report-data').textContent);

  for (const button of $$('[data-save-story]')) {
    button.addEventListener('click', async () => {
      const block = data.blocks[Number(button.dataset.saveStory)];
      button.disabled = true;
      button.textContent = 'Saving…';
      // Without an AI the raw answer is kept, to be sorted into parts later.
      let story = { title: block.q.slice(0, 80), situation: block.said };
      try {
        story = await tidyStory(data.prompt, block.q, block.said);
      } catch {}
      const body = { title: String(story.title || block.q).slice(0, 200), tags: (story.tags || []).slice(0, 6) };
      for (const part of STAR) body[part] = String(story[part] || '').slice(0, 3000);
      try {
        await api('/api/stories', { method: 'POST', body });
        button.replaceWith(el('a', { href: '/app/stories', class: 'small' }, 'Saved. Open your stories'));
      } catch (err) {
        toast(err.message, true);
        button.disabled = false;
        button.textContent = 'Save as a story';
      }
    });
  }

  const box = $('[data-share]');
  if (!box) return;
  const toggle = $('[data-share-toggle]', box);
  const draw = (slug) => {
    const url = slug ? `${location.origin}/r/${slug}` : '';
    box.dataset.slug = slug;
    $('[data-share-link]', box).hidden = !slug;
    $('#share-url').value = url;
    $('[data-linkedin]', box).href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
    toggle.textContent = slug ? 'Stop sharing' : 'Create a public link';
  };
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      const { url } = await api(`/api/sessions/${box.dataset.share}/share`, { method: 'POST', body: { on: !box.dataset.slug } });
      draw(url.split('/r/')[1] || '');
      toast(url ? 'Anyone with the link can see your scores now.' : 'The link no longer works.');
    } catch (err) {
      toast(err.message, true);
    }
    toggle.disabled = false;
  });
  draw(box.dataset.slug);
}

if ($('#practice-data')) dashboard();
if ($('#story-prompt')) storiesPage();
if ($('#report-data')) reportPage();
