// Runs the candidate's code for the coding round, away from the page and with a time limit.
// JavaScript runs in a throwaway worker; Python runs in Pyodide (about 10 MB, loaded on first use).

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const LIMIT_MS = { javascript: 4000, python: 12000 };
const MAX_OUTPUT = 2500;

// The page's security policy forbids eval, so the code itself becomes the worker's script.
const jsSource = (code) => `
const __out = [];
const __show = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
console.log = console.info = console.warn = console.error = (...a) => __out.push(a.map(__show).join(' '));
try {
${code}
} catch (e) { __out.push(String(e)); }
postMessage(__out.join('\\n'));`;

const pySource = `
importScripts('${PYODIDE}pyodide.js');
const ready = loadPyodide({ indexURL: '${PYODIDE}' });
self.onmessage = async ({ data }) => {
  const out = [];
  try {
    const py = await ready;
    py.setStdout({ batched: (s) => out.push(s) });
    py.setStderr({ batched: (s) => out.push(s) });
    await py.runPythonAsync(data);
  } catch (e) {
    out.push(String(e.message || e).trim().split('\\n').slice(-3).join('\\n'));
  }
  postMessage(out.join('\\n'));
};`;

const workerFrom = (source) => new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
let python = null;

export function runCode(language, code) {
  return new Promise((resolve) => {
    const isPython = language === 'python';
    const worker = isPython ? (python ||= workerFrom(pySource)) : workerFrom(jsSource(code));
    // Python's first run also downloads the runtime, so it gets longer.
    const limit = isPython && !python.loaded ? 60000 : LIMIT_MS[language];
    const finish = (text, kill) => {
      clearTimeout(timer);
      if (kill || !isPython) worker.terminate();
      if (kill && isPython) python = null;
      resolve((text || '(no output — add a print to see results)').slice(0, MAX_OUTPUT));
    };
    const timer = setTimeout(() => finish(`Stopped after ${limit / 1000} seconds. Is there an endless loop?`, true), limit);
    worker.onmessage = ({ data }) => {
      if (isPython) python.loaded = true;
      finish(data, false);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      finish(e.message || 'The code could not be run.', true);
    };
    if (isPython) worker.postMessage(code);
  });
}
