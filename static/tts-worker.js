// Runs the Kokoro text-to-speech model off the main thread, so the interviewer's face keeps
// moving smoothly while the next sentence is generated. The model (about 90 MB) is
// downloaded once and then served from the browser cache.
//
// The library is loaded with import() on purpose: a static import of this bundle fails
// inside module workers in Chromium, while a dynamic one works.

const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
let tts = null;

let device = 'wasm';

// A GPU makes the model faster than real time; on CPU alone it is often slower.
async function load() {
  const { KokoroTTS } = await import(KOKORO);
  const progress_callback = (p) => {
    if (p.status === 'progress' && String(p.file || '').endsWith('.onnx')) self.postMessage({ type: 'progress', progress: p.progress });
  };
  const model = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  if (self.navigator.gpu && (await self.navigator.gpu.requestAdapter().catch(() => null))) {
    try {
      device = 'webgpu';
      return await KokoroTTS.from_pretrained(model, { dtype: 'fp32', device, progress_callback });
    } catch {
      device = 'wasm';
    }
  }
  return KokoroTTS.from_pretrained(model, { dtype: 'q8', device, progress_callback });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    try {
      tts ||= await load();
      self.postMessage({ type: 'ready', device });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }
  if (data.type === 'speak') {
    try {
      const out = await tts.generate(data.text, { voice: data.voice });
      self.postMessage({ type: 'audio', id: data.id, audio: out.audio, rate: out.sampling_rate }, [out.audio.buffer]);
    } catch (err) {
      self.postMessage({ type: 'fail', id: data.id, message: String(err?.message || err) });
    }
  }
};
