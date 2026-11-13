// Speech in and out, and simple answer metrics.
//
// Output voices, best first: a natural neural voice that runs inside the browser (Kokoro,
// English only, downloaded once), OpenAI's voice through the user's own key (any language),
// and the browser's built-in voices, ranked so "Natural"/"Online" neural voices win.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
const HOUSE = (() => {
  try {
    return JSON.parse(meta('house-ai') || '{}');
  } catch {
    return {};
  }
})();
const serverListens = Boolean(HOUSE.transcribe) && 'MediaRecorder' in window;
// Live captions need the browser's own recognition; the server's transcription works in any browser.
export const liveCaptions = Boolean(Recognition);
export const canListen = liveCaptions || serverListens;
export const houseSpeaks = (lang) => (HOUSE.speech || []).includes(lang);
export const canSpeak = 'speechSynthesis' in window;

const FILLERS = {
  en: ['um', 'uh', 'erm', 'hmm', 'you know', 'i mean', 'kind of', 'sort of', 'basically', 'literally', 'actually'],
  bn: ['মানে', 'আসলে', 'ইয়ে', 'এই যে', 'বলতে গেলে', 'হুম', 'উম', 'আচ্ছা'],
};

export const fillersFor = (lang) => (lang === 'en' ? FILLERS.en : [...FILLERS.bn, ...FILLERS.en]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function analyze(text, { lang = 'en', ms = 0 } = {}) {
  const words = (text.match(/[\p{L}\p{M}\p{N}'’-]+/gu) || []).length;
  const fillers = {};
  for (const f of fillersFor(lang)) {
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(f)}(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
    const n = (text.match(re) || []).length;
    if (n) fillers[f] = n;
  }
  const fillerCount = Object.values(fillers).reduce((a, b) => a + b, 0);
  return { words, fillers, fillerCount, ms, wpm: ms > 5000 && words > 8 ? Math.round(words / (ms / 60000)) : null };
}

const DEFAULTS = { engine: 'auto', listen: 'auto', rate: 1, silence: 0, auto_listen: true };

export function voiceSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('mohora.voice') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

// The natural voice is only used when this device made speech faster than it plays.
export const naturalReady = () => localStorage.getItem('mohora.natural') === 'ready';
export const naturalSpeed = () => Number(localStorage.getItem('mohora.natural.speed') || 0);

// ------------------------------------------------------------------ listening

// Wraps the Web Speech API. Chrome stops recognition on long silences or network
// hiccups, so it is restarted until stop() is called.
export class Listener {
  constructor({ lang = 'en-US', onText, onSilence, onError, silenceMs = 0 } = {}) {
    Object.assign(this, { lang, onText, onSilence, onError, silenceMs });
    this.active = false;
  }

  start() {
    this.finalText = '';
    this.interim = '';
    this.firstAt = 0;
    this.lastAt = 0;
    this.active = true;
    this.rec = new Recognition();
    this.rec.lang = this.lang;
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) this.finalText += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      this.interim = interim;
      const now = performance.now();
      this.firstAt ||= now;
      this.lastAt = now;
      this.onText?.(this.finalText.trim(), interim);
      if (this.silenceMs) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.active && this.onSilence?.(), this.silenceMs);
      }
    };
    this.rec.onerror = (e) => {
      if (['no-speech', 'aborted'].includes(e.error)) return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) this.active = false;
      this.onError?.(e.error);
    };
    this.rec.onend = () => {
      if (!this.active) return;
      try {
        this.rec.start();
      } catch {}
    };
    this.rec.start();
  }

  text() {
    return `${this.finalText} ${this.interim}`.replace(/\s+/g, ' ').trim();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    try {
      this.rec?.stop();
    } catch {}
    return { text: this.text(), ms: this.firstAt ? Math.round(this.lastAt - this.firstAt) : 0, firstAt: this.firstAt };
  }
}

// Records the answer and has the site's server transcribe it when the person stops.
// Same shape as Listener, except stop() resolves later and there are no live captions.
export class Recorder {
  constructor({ lang = 'en', onError } = {}) {
    Object.assign(this, { lang, onError });
    this.active = false;
  }

  async start() {
    this.active = true;
    this.chunks = [];
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.active = false;
      return this.onError?.('not-allowed');
    }
    if (!this.active) return this.release();
    this.rec = new MediaRecorder(this.stream, { audioBitsPerSecond: 24000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.startedAt = performance.now();
    this.rec.start();
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  async stop(keep = false) {
    const wasActive = this.active;
    this.active = false;
    const empty = { text: '', ms: 0, firstAt: 0 };
    if (!wasActive || !this.rec) {
      this.release();
      return empty;
    }
    const ms = Math.round(performance.now() - this.startedAt);
    await new Promise((resolve) => {
      this.rec.onstop = resolve;
      this.rec.stop();
    });
    this.release();
    if (!keep || !this.chunks.length) return empty;
    const form = new FormData();
    form.append('audio', new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' }), 'answer.webm');
    form.append('lang', this.lang);
    const res = await fetch('/api/house/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': meta('csrf') }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : "The recording couldn't be transcribed.");
    return { text: data.text || '', ms, firstAt: 0 };
  }
}

// Which way to listen: the browser gives live captions; the server is more accurate,
// especially for Bangla, and works where the browser can't listen at all.
export function useServerListening(lang, settings = voiceSettings()) {
  if (!serverListens) return false;
  if (!liveCaptions || settings.listen === 'server') return true;
  return settings.listen !== 'browser' && lang !== 'en';
}

export async function micLevel(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let frame;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += ((x - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  };
}

// ------------------------------------------------------------------ browser voices

export function voicesReady() {
  return new Promise((resolve) => {
    if (!canSpeak) return resolve([]);
    const voices = speechSynthesis.getVoices();
    if (voices.length) return resolve(voices);
    speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
  });
}

const FEMALE = /female|aria|jenny|ava\b|emma|michelle|sonia|libby|natasha|clara|neerja|nabanita|tanishaa|samantha|zira|susan|hazel|karen|moira|tessa|fiona|victoria|allison|serena|heera|swara|ana\b|emily/i;
const MALE = /\bmale\b|guy|davis|andrew|brian|christopher|eric|ryan|thomas|william|prabhat|pradeep|bashkar|david|mark|george|daniel|alex|fred|oliver|james|ravi|hemant|roger|steffan/i;

function voiceScore(v, gender) {
  let score = 0;
  if (/natural|neural|online/i.test(v.name)) score += 10;
  else if (/google/i.test(v.name)) score += 4;
  if (gender === 'female' && FEMALE.test(v.name)) score += 5;
  if (gender === 'male' && MALE.test(v.name)) score += 5;
  if (gender === 'female' && MALE.test(v.name)) score -= 6;
  if (gender === 'male' && FEMALE.test(v.name) && !/\bmale\b/i.test(v.name)) score -= 6;
  if (/en-us/i.test(v.lang)) score += 1;
  return score;
}

export const hasNeuralVoice = (lang) =>
  canSpeak && speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith(lang) && /natural|neural/i.test(v.name));

export function bestVoice(lang, gender, preferred = '') {
  const all = canSpeak ? speechSynthesis.getVoices() : [];
  const chosen = preferred && all.find((v) => v.name === preferred);
  if (chosen) return chosen;
  const matches = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
  return matches.sort((a, b) => voiceScore(b, gender) - voiceScore(a, gender))[0] || null;
}

const sentences = (text) => (text.match(/[^.!?।]+[.!?।]*["')]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ natural voice (Kokoro, in a worker)

let worker = null;
let loading = null;
let jobId = 0;
const jobs = new Map();
const progressListeners = new Set();

export function loadNaturalVoice(onProgress) {
  if (onProgress) progressListeners.add(onProgress);
  if (loading) return loading;
  worker = new Worker('/static/tts-worker.js', { type: 'module' });
  loading = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progressListeners.forEach((fn) => fn(data.progress));
      else if (data.type === 'ready') {
        measureSpeed().then((speed) => {
          localStorage.setItem('mohora.natural.speed', speed.toFixed(2));
          if (speed >= 1.1) localStorage.setItem('mohora.natural', 'ready');
          else localStorage.removeItem('mohora.natural');
          resolve(speed);
        }, reject);
      } else if (data.type === 'error') {
        loading = null;
        worker.terminate();
        reject(new Error(data.message));
      } else {
        const job = jobs.get(data.id);
        jobs.delete(data.id);
        if (data.type === 'audio') job?.resolve(data);
        else job?.reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      loading = null;
      reject(new Error(e.message || 'The natural voice could not start in this browser.'));
    };
    worker.postMessage({ type: 'load' });
  });
  return loading;
}

// Seconds of speech produced per second of work. Below 1 the interviewer would stall mid-sentence.
async function measureSpeed() {
  await naturalSynth('Hello.', 'af_heart');
  const started = performance.now();
  const { audio, rate } = await naturalSynth('Thanks for joining me today, shall we begin?', 'af_heart');
  return audio.length / rate / ((performance.now() - started) / 1000);
}

function naturalSynth(text, voice) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ type: 'speak', id, text, voice });
  });
}

// ------------------------------------------------------------------ speaker

export class Speaker {
  constructor({ lang = 'en', gender = 'female', settings = voiceSettings(), openaiKey = '', onLevel, onFallback } = {}) {
    Object.assign(this, { lang, gender, settings, openaiKey, onLevel, onFallback });
    this.seq = 0;
    this.source = null;
    this.ctx = null;
    this.engine = this.pickEngine();
  }

  pickEngine() {
    const want = this.settings.engine || 'auto';
    const english = this.lang === 'en';
    if (want === 'browser') return 'browser';
    if (want === 'natural' && english && naturalReady()) return 'natural';
    if (want === 'openai' && this.openaiKey) return 'openai';
    if (['auto', 'house'].includes(want) && houseSpeaks(this.lang)) return 'house';
    if (want === 'auto') {
      // Edge ships neural "Natural" voices; when one exists it is instant and sounds human.
      if (hasNeuralVoice(this.lang)) return 'browser';
      if (english && naturalReady()) return 'natural';
      if (this.openaiKey) return 'openai';
    }
    return 'browser';
  }

  get canUpgrade() {
    return this.engine === 'browser' && this.lang === 'en' && !hasNeuralVoice('en') && !naturalReady();
  }

  get label() {
    return { house: "this site's natural voice", natural: 'natural voice', openai: 'OpenAI voice', browser: 'browser voice' }[this.engine];
  }

  // Call from a click handler: browsers only allow audio to start after a user gesture.
  unlock() {
    this.ctx ||= new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (canSpeak) speechSynthesis.getVoices();
  }

  async useNatural(onProgress) {
    const speed = await loadNaturalVoice(onProgress);
    if (!naturalReady()) {
      throw new Error(`This computer makes the natural voice too slowly (${speed.toFixed(1)}× real time), so the interviewer would pause mid-sentence. Keeping the browser voice.`);
    }
    this.engine = 'natural';
  }

  stop() {
    this.seq += 1;
    if (canSpeak) speechSynthesis.cancel();
    try {
      this.source?.stop();
    } catch {}
    this.onLevel?.(0);
  }

  async say(text) {
    this.stop();
    const id = this.seq;
    const parts = sentences(text);
    if (this.engine === 'browser' || !parts.length) return this.sayBrowser(parts, id);
    if (this.engine === 'natural') await loadNaturalVoice();
    // Make the next sentence while the current one plays, so there are no long gaps.
    let pending = this.synth(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      let audio;
      try {
        audio = await pending;
      } catch (err) {
        this.onFallback?.(err);
        this.engine = 'browser';
        return this.sayBrowser(parts.slice(i), id);
      }
      if (id !== this.seq) return;
      pending = i + 1 < parts.length ? this.synth(parts[i + 1]) : null;
      pending?.catch(() => {});
      await this.play(audio, id);
      if (id !== this.seq) return;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async synth(text) {
    this.unlock();
    if (this.engine === 'natural') {
      const { audio, rate } = await naturalSynth(text, this.gender === 'male' ? 'am_michael' : 'af_heart');
      const buffer = this.ctx.createBuffer(1, audio.length, rate);
      buffer.copyToChannel(audio, 0);
      return buffer;
    }
    if (this.engine === 'house') {
      const reply = await fetch('/api/house/speech', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': meta('csrf') },
        body: JSON.stringify({ text, gender: this.gender }),
      });
      if (!reply.ok) throw new Error(`The site's voice failed (${reply.status}).`);
      return this.ctx.decodeAudioData(await reply.arrayBuffer());
    }
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: this.gender === 'male' ? 'ash' : 'coral',
        input: text,
        instructions: 'You are a professional job interviewer on a video call. Speak naturally and warmly at a calm, conversational pace, with clear pronunciation.',
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`OpenAI voice failed (${res.status}).`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  play(buffer, id) {
    return new Promise((resolve) => {
      const ctx = this.ctx;
      const source = ctx.createBufferSource();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.buffer = buffer;
      source.playbackRate.value = this.settings.rate || 1;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      const data = new Uint8Array(analyser.fftSize);
      let frame;
      const meter = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const x of data) sum += ((x - 128) / 128) ** 2;
        this.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 6));
        frame = requestAnimationFrame(meter);
      };
      source.onended = () => {
        cancelAnimationFrame(frame);
        this.onLevel?.(0);
        resolve();
      };
      this.source = source;
      if (id !== this.seq) return resolve();
      source.start();
      meter();
    });
  }

  // Built-in voices don't expose audio, so the mouth follows word boundaries plus a
  // syllable-rate wobble while each sentence plays.
  sayBrowser(parts, id) {
    return new Promise((resolve) => {
      if (!canSpeak) return resolve();
      const voice = bestVoice(this.lang, this.gender, this.settings[`voice_${this.lang}`]);
      let i = 0;
      let speaking = false;
      let boundary = 0;
      let frame;
      const pump = () => {
        if (!speaking) return this.onLevel?.(0);
        const t = performance.now() / 1000;
        const burst = Math.max(0, 1 - (performance.now() - boundary) / 260);
        const wobble = 0.3 + 0.4 * Math.abs(Math.sin(t * 10.5)) * (0.7 + 0.3 * Math.sin(t * 2.7));
        this.onLevel?.(Math.min(1, wobble * 0.8 + burst * 0.3));
        frame = requestAnimationFrame(pump);
      };
      const next = () => {
        if (id !== this.seq || i >= parts.length) {
          speaking = false;
          this.onLevel?.(0);
          return resolve();
        }
        const text = parts[i++];
        const u = new SpeechSynthesisUtterance(text);
        if (voice) u.voice = voice;
        u.lang = voice?.lang || (this.lang === 'en' ? 'en-US' : 'bn-BD');
        u.rate = (this.settings.rate || 1) * 0.97;
        let settled = false;
        const settle = (carryOn) => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          speaking = false;
          cancelAnimationFrame(frame);
          this.onLevel?.(0);
          if (carryOn) setTimeout(next, 170);
          else resolve();
        };
        // Some browsers never fire "end" (or never start without voices); don't let the interview hang.
        const guard = setTimeout(() => {
          speechSynthesis.cancel();
          settle(true);
        }, Math.max(4000, text.length * 110));
        u.onstart = () => {
          speaking = true;
          pump();
        };
        u.onboundary = () => (boundary = performance.now());
        u.onend = () => settle(true);
        u.onerror = () => settle(false);
        speechSynthesis.speak(u);
      };
      next();
    });
  }
}
