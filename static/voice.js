// Speech in and out with the browser's built-in engines, and simple answer metrics.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
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

export function voiceSettings() {
  try {
    return { rate: 1, silence: 0, auto_listen: true, ...JSON.parse(localStorage.getItem('mohora.voice') || '{}') };
  } catch {
    return { rate: 1, silence: 0, auto_listen: true };
  }
}

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
      this.onText?.(this.text(), interim);
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

export function voicesReady() {
  return new Promise((resolve) => {
    if (!canSpeak) return resolve([]);
    const voices = speechSynthesis.getVoices();
    if (voices.length) return resolve(voices);
    speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
  });
}

export function pickVoice(lang, preferred = '') {
  const all = canSpeak ? speechSynthesis.getVoices() : [];
  const chosen = preferred && all.find((v) => v.name === preferred);
  if (chosen) return chosen;
  const matches = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
  return matches.find((v) => /natural|neural|online/i.test(v.name)) || matches.find((v) => /google/i.test(v.name)) || matches[0] || null;
}

// Long utterances get cut off in Chrome, so speak sentence by sentence.
export function speak(text, { lang = 'en', rate = 1, pitch = 1, voice = '' } = {}) {
  return new Promise((resolve) => {
    if (!canSpeak || !text) return resolve();
    speechSynthesis.cancel();
    const chosen = pickVoice(lang, voice);
    const parts = text.match(/[^.!?।]+[.!?।]*["')]*\s*/g) || [text];
    let i = 0;
    const next = () => {
      if (i >= parts.length) return resolve();
      const u = new SpeechSynthesisUtterance(parts[i++].trim());
      if (chosen) u.voice = chosen;
      u.lang = chosen?.lang || (lang === 'en' ? 'en-US' : 'bn-BD');
      u.rate = rate;
      u.pitch = pitch;
      u.onend = next;
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    next();
  });
}

export const stopSpeaking = () => canSpeak && speechSynthesis.cancel();

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
