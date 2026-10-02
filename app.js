// Transcriber page: FILE and LIVE modes over two engines.
//   mac: the local server (transcriber.py) running whisper.cpp; used when the page is served from 127.0.0.1.
//   web: Whisper in the browser via transformers.js (worker.js); used on GitHub Pages or with ?engine=browser.
import * as F from "./format.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ENGINE = ["127.0.0.1", "localhost"].includes(location.hostname) && params.get("engine") !== "browser" ? "mac" : "web";
const LOCAL_URL = "http://127.0.0.1:8765/";
const REPO = "https://github.com/critical-code-studies/transcriber";
const PAGES_URL = "https://critical-code-studies.github.io/transcriber/";
const TJS_VERSION = "4.3.0";
const MODELS = {
  mac: [["turbo", "Turbo", "good quality"], ["base", "Base", "fast, rough"]],
  web: [["base", "Base", "~160 MB download"], ["small", "Small", "~420 MB"], ["turbo", "Turbo", "~1.4 GB, slow"]],
};
const MAC_STAGES = ["Reading file", "Extracting audio", "Analysing audio", "Transcribing", "Checking for gaps", "Writing files"];
const WEB_STAGES = ["Reading file", "Decoding audio", "Analysing audio", "Loading model", "Transcribing", "Checking for gaps", "Writing files"];
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];
const DEFAULT_TAGS = "Speaker 1\nSpeaker 2\nQuestion\n* Important\n* Check this";

const S = {
  mode: "file", file: null, job: null, segments: [], wave: null, pauses: [], duration: 0,
  speed: [], stats: null, autoTerms: "", polling: null, version: "", about: null,
  localAbout: null, downloads: "", web: { worker: null, device: null, outputs: null, segs: null, meta: null },
};

/* ================================================================ utilities */

// On the web version nothing derived from a transcription is kept in the browser: no draft, no
// find/replace list (it holds names), no tag names, no speaker voices. Only plain preferences.
const PRIVATE_KEYS = ["livedraft", "replacements", "tags", "voices", "lastoutdir"];
const keepsData = (k) => ENGINE === "mac" || !PRIVATE_KEYS.includes(k);
const store = {
  get(k) { if (!keepsData(k)) return null; try { return localStorage.getItem("transcriber." + k); } catch (e) { return null; } },
  set(k, v) { if (!keepsData(k)) return; try { localStorage.setItem("transcriber." + k, v); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem("transcriber." + k); } catch (e) { /* private mode */ } },
};
const hms = F.hms;
function clock(s, ref) {
  if ((ref ?? S.duration ?? 0) >= 3600) return hms(s);
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function human(s) {
  if (s == null || !isFinite(s)) return "–";
  if (s < 10) return `${s.toFixed(1)}s`;
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
const fmt = (n) => Math.round(n).toLocaleString();
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const running = () => !!(S.job && S.job.state === "running");
const done = () => !!(S.job && S.job.state === "done");
const isMac = ENGINE === "mac";

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Transcriber": "1" },
                                body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg) {
  let t = $("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0c1020;color:#e9eefb;padding:9px 16px;border-radius:10px;font-size:13.5px;z-index:99;box-shadow:0 10px 30px rgba(0,0,0,.35);transition:opacity .3s";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = "0"; }, 2600);
}

function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function wavBlob(int16, rate = 16000) {
  const buf = new ArrayBuffer(44 + int16.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + int16.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
  v.setUint32(40, int16.length * 2, true);
  new Int16Array(buf, 44).set(int16);
  return new Blob([buf], { type: "audio/wav" });
}

/* ================================================================ mode, engine badge, theme */

// One project at a time: a recording (FILE) or a live session (LIVE). Switching to the other mode
// with something open closes it first; files already written are left alone.
const hasProject = () => !!(S.file || S.doc || (S.job && S.project === "file") || (S.live && (S.live.segs.length || ["saving", "saved"].includes(S.live.state))));

function setMode(mode) {
  if (mode !== S.mode && S.project && S.project !== mode && hasProject()) {
    if (S.live && ["recording", "paused", "saving"].includes(S.live.state)) { toast("Stop the live recording first."); return false; }
    if (running()) { toast("Cancel the transcription first."); return false; }
    const what = S.project === "file" ? "the current recording" : "the current live session";
    if (!confirm(`Close ${what} and start a new project? Files already saved are kept.`)) return false;
    newProject(true);
  }
  S.mode = mode;
  document.body.classList.toggle("mode-file", mode === "file");
  document.body.classList.toggle("mode-live", mode === "live");
  $("tab-file").setAttribute("aria-selected", mode === "file");
  $("tab-live").setAttribute("aria-selected", mode === "live");
  renderModels();
  if (mode === "live") liveDefaults();
  else if (S.file) applyFileDefaults(S.file);
  $("studio").classList.toggle("hidden", mode !== "file" || !S.job);
  $("summary").classList.toggle("hidden", !(S.stats && S.stats.mode === mode));
  return true;
}

function renderEngine() {
  const e = $("engine");
  if (isMac) {
    const w = S.about && S.about.whisper ? ` ${S.about.whisper}` : "";
    e.innerHTML = `<span class="pill"><span class="dot"></span><span class="label">This Mac · whisper.cpp${esc(w)} · Metal</span></span>`;
  } else {
    const dev = S.web.device === "webgpu" ? "WebGPU" : S.web.device === "wasm" ? "WebAssembly" : "…";
    e.innerHTML = `<span class="pill web"><span class="dot"></span><span class="label">In this browser · ${dev}</span></span>` +
      (S.localAbout ? `<button class="switch" id="switchmac" title="Open the copy served by the Transcriber app on this Mac">Use this Mac's engine</button>` : "");
    if (S.localAbout) $("switchmac").onclick = () => { location.href = LOCAL_URL; };
  }
  $("footer").innerHTML = (isMac ? "" : `<p style="margin:0 0 6px">Runs entirely in this browser. Recordings and transcripts are never uploaded, and nothing from them is kept once you close or reload the page: download the files before you leave.</p>`) +
    `Transcriber ${esc(S.version)} · <a href="${REPO}" target="_blank" rel="noopener">source</a>` +
    (isMac ? ` · <button class="link" id="quit">Stop the transcriber</button>` : "");
  if (isMac) $("quit").onclick = quit;
}

function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  store.set("theme", t);
  requestAnimationFrame(() => { drawWave(); drawLanes(); });
}

function renderModels() {
  const key = `model.${ENGINE}.${S.mode}`;
  const list = S.mode === "live" && !isMac ? MODELS.web.slice(0, 2) : MODELS[ENGINE];
  const saved = store.get(key) || list[0][0];
  $("models").innerHTML = list.map(([v, label, note]) =>
    `<label><input type="radio" name="model" value="${v}" ${v === saved ? "checked" : ""}>${label}<small>${note}</small></label>`).join("");
  if (!document.querySelector("input[name=model]:checked")) document.querySelector("input[name=model]").checked = true;
  document.querySelectorAll("input[name=model]").forEach((r) => r.addEventListener("change", () => store.set(key, r.value)));
}
const model = () => document.querySelector("input[name=model]:checked").value;

/* ================================================================ FILE mode: choosing a file */

function applyFileDefaults(info) {
  $("title").value = info.title;
  $("outname").value = info.outname;
  if (isMac) $("outdir").value = info.uploaded ? (store.get("lastoutdir") || S.downloads || "") : info.dir;
}

function setFile(info, note) {
  if (S.job || S.doc) clearResults();
  S.project = "file";
  S.file = info;
  $("drop").classList.add("hidden");
  $("fileinfo").classList.remove("hidden");
  $("fname").textContent = info.name;
  const where = isMac ? (info.uploaded ? "copied in for transcription" : info.dir) : "in this browser";
  $("fpath").textContent = `${where}${info.duration ? " · " + hms(info.duration) : ""}`;
  const m = info.meta || {};
  $("fmeta").textContent = [m.by, m.date, m.url].filter(Boolean).join(" · ");
  applyFileDefaults(info);
  if (info.language && [...$("language").options].some((o) => o.value === info.language)) $("language").value = info.language;
  // Names and terms belong to a recording: replace what was filled in for the last file,
  // keep anything typed by hand and add the new file's terms to it.
  const typed = $("prompt").value.trim();
  if (!typed || typed === S.autoTerms) $("prompt").value = info.terms || "";
  else if (info.terms) {
    const have = new Set(typed.split(/\s*,\s*/));
    const extra = info.terms.split(/\s*,\s*/).filter((t) => !have.has(t));
    if (extra.length) $("prompt").value = typed + ", " + extra.join(", ");
  }
  S.autoTerms = $("prompt").value.trim();
  $("uploadnote").textContent = note || "";
  $("uploadnote").classList.toggle("hidden", !note);
  $("go").disabled = false;
  const est = isMac ? 8 + (info.duration || 0) / 20 : null;
  $("gohint").textContent = info.duration
    ? `${hms(info.duration)} of audio.${est ? ` Turbo takes roughly ${human(est)}, Base about a third of that.` : ""}`
    : "Ready.";
  if ($("autostart").checked && !running() && (!isMac || $("outdir").value)) start();
}

async function chooseFile() {
  if (!isMac) { $("fileinput").click(); return; }
  try {
    const info = await api("/api/choose-file");
    if (!info.cancelled) setFile(info);
  } catch (e) { toast(e.message); }
}

function webFileInfo(file) {
  const title = F.suggestTitle(file.name);
  return { file, name: file.name, title, outname: F.suggestOutname(title), terms: F.suggestTerms(file.name), duration: 0 };
}

async function droppedFile(file) {
  if (!isMac) { setFile(webFileInfo(file)); return; }
  $("uploadnote").classList.remove("hidden");
  $("uploadnote").textContent = `Locating ${file.name}…`;
  try {
    const info = await api("/api/resolve", { name: file.name, size: file.size, modified: file.lastModified });
    if (info.path) return setFile(info);
  } catch (e) { /* fall back to uploading */ }
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", "/api/upload?name=" + encodeURIComponent(file.name));
  xhr.setRequestHeader("X-Transcriber", "1");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) $("uploadnote").textContent = `Copying ${file.name}: ${Math.round((100 * e.loaded) / e.total)}%`;
  };
  xhr.onload = () => {
    const j = JSON.parse(xhr.responseText || "{}");
    if (xhr.status !== 200) { $("uploadnote").textContent = j.error || "Upload failed."; return; }
    setFile(j, "The file's original location couldn't be found, so it was copied in (and is deleted afterwards). Transcripts go to the output folder below.");
  };
  xhr.onerror = () => { $("uploadnote").textContent = "Upload failed."; };
  xhr.send(file);
}

async function usePath() {
  const p = $("pastepath").value.trim();
  if (!p) return;
  try { setFile(await api("/api/probe", { path: p })); $("pastepath").value = ""; }
  catch (e) { toast(e.message); }
}

async function pickDir() {
  try {
    const r = await api("/api/choose-folder", { start: $("outdir").value || (S.file && S.file.dir) });
    if (r.path) $("outdir").value = r.path;
  } catch (e) { toast(e.message); }
}

/* ================================================================ FILE mode: running */

function resetRunView() {
  S.segments = []; S.wave = null; S.pauses = []; S.speed = []; S.stats = null; S.doc = null; S.names = {};
  $("audio").pause();
  S.duration = (S.file && S.file.duration) || 0;
  $("live").innerHTML = "";
  $("summary").classList.add("hidden");
  $("studio").classList.remove("hidden");
  $("studio").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function start() {
  if (!S.file || running()) return;
  ["replacements", "language"].forEach((id) => store.set(id, $(id).value));
  if (isMac) {
    const outdir = $("outdir").value.trim();
    if (!outdir && S.file.uploaded) { toast("Choose an output folder first."); return; }
    if (outdir) store.set("lastoutdir", outdir);
    try {
      await api("/api/transcribe", {
        path: S.file.path, name: S.file.name, uploaded: !!S.file.uploaded, model: model(),
        language: $("language").value, title: $("title").value, outname: $("outname").value, outdir,
        prompt: $("prompt").value, replacements: $("replacements").value, sections: $("sections").value,
      });
    } catch (e) { toast(e.message); return; }
    resetRunView();
    poll(true);
  } else {
    resetRunView();
    webRun();
  }
}

function cancel() {
  if (S.mode === "live") return;
  if (isMac) api("/api/cancel").catch(() => {});
  else if (S.web.worker && running()) {
    stopWorker();
    Object.assign(S.job, { state: "cancelled", message: "Cancelled." });
    render();
  }
}

async function poll(reset) {
  clearTimeout(S.polling);
  let data;
  try {
    const r = await fetch(`/api/status?since=${reset ? 0 : S.segments.length}${S.wave ? "" : "&wave=1"}`);
    data = await r.json();
  } catch (e) {
    S.polling = setTimeout(poll, 3000);
    return;
  }
  S.downloads = data.downloads;
  let job = data.job;
  if (job && S.project === "live") job = null;                     // the live session is the project
  if (job && !S.project) {
    if (S.mode === "live" && job.state !== "running") { api("/api/reset").catch(() => {}); job = null; }
    else { if (S.mode !== "file") setMode("file"); S.project = "file"; }
  }
  if (job) {
    if (reset) S.segments = [];
    if (job.duration) S.duration = job.duration;
    if (job.wave) S.wave = job.wave;
    if (job.pauses) S.pauses = job.pauses;
    S.segments.push(...(job.segments || []));
    S.job = job;
    S.fresh = job.segments || [];
    render(reset);
  }
  S.polling = setTimeout(poll, running() ? 700 : 30000);
}

/* ---------------- browser engine (FILE) */

// One worker serves Whisper (browser engine), the gap check and speaker embeddings. Requests get
// id-matched replies; the streaming messages of a FILE run go to S.web.stream.
const calls = new Map();
let callId = 0;
function webWorker() {
  if (!S.web.worker) {
    const w = S.web.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    w.onmessage = ({ data: m }) => {
      const c = m.id != null ? calls.get(m.id) : null;
      if (!c) { if (S.web.stream) S.web.stream(m); return; }
      if (m.type === "download" || m.type === "embed-progress") { if (c.progress) c.progress(m); return; }
      calls.delete(m.id);
      if (m.type === "error") c.reject(new Error(m.message)); else c.resolve(m);
    };
    w.onerror = (e) => {
      const err = new Error(e.message || "The browser engine stopped.");
      for (const c of calls.values()) c.reject(err);
      calls.clear();
      if (S.web.stream) S.web.stream({ type: "error", message: err.message });
    };
  }
  return S.web.worker;
}

function workerCall(msg, progress, transfer) {
  const id = ++callId;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject, progress });
    webWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

function stopWorker() {
  if (!S.web.worker) return;
  S.web.worker.terminate();
  S.web.worker = null;
  for (const c of calls.values()) c.reject(new Error("Cancelled."));
  calls.clear();
}

async function detectDevice() {
  try {
    if (navigator.gpu && await navigator.gpu.requestAdapter()) return "webgpu";
  } catch (e) { /* no WebGPU */ }
  return "wasm";
}

async function decodeToMono16k(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

async function webRun() {
  const t0 = performance.now();
  const job = S.job = { state: "running", stage: "Reading file", progress: 0, timings: {}, name: S.file.name, log: [],
                        started: t0, stageStarted: t0, elapsed: 0 };
  const stage = (name, progress) => {
    const now = performance.now();
    if (job.stage) job.timings[job.stage] = (now - job.stageStarted) / 1000;
    Object.assign(job, { stage: name, progress, stageStarted: now });
    render();
  };
  const fail = (msg) => { Object.assign(job, { state: "error", message: msg }); render(); };
  const tick = setInterval(() => { if (running()) render(); else clearInterval(tick); }, 500);
  try {
    render();
    const bytes = await S.file.file.arrayBuffer();
    stage("Decoding audio", 2);
    let samples;
    try { samples = await decodeToMono16k(bytes); }
    catch (e) { return fail("This browser couldn't decode the audio in that file. Try an mp3, m4a or wav, or use the Mac app."); }
    S.duration = samples.length / 16000;
    stage("Analysing audio", 6);
    const audio = F.analyseAudio(samples);
    S.wave = audio.peaks; S.pauses = audio.pauses; S.web.audio = audio; S.web.samples = samples;
    stage("Loading model", 7);
    S.web.device = S.web.device || await detectDevice();
    renderEngine();
    const files = {};
    const worker = webWorker();
    const result = await new Promise((resolve, reject) => {
      S.web.stream = (m) => {
        if (m.type === "download") {
          files[m.file] = { loaded: m.loaded || 0, total: m.total || files[m.file]?.total || 0 };
          const tot = Object.values(files).reduce((a, f) => a + (f.total || 0), 0);
          const got = Object.values(files).reduce((a, f) => a + (f.loaded || 0), 0);
          job.download = tot ? { got, tot } : null;
          job.progress = 7 + (tot ? 8 * got / tot : 0);
        } else if (m.type === "loaded") {
          job.download = null;
          stage("Transcribing", 15);
        } else if (m.type === "segment") {
          S.segments.push(m.seg);
          (S.fresh = S.fresh || []).push(m.seg);
        } else if (m.type === "partial") {
          job.partial = m.seg;
        } else if (m.type === "position") {
          job.position = m.position;
          job.progress = Math.max(job.progress, 15 + 83 * m.position / S.duration);
        } else if (m.type === "done") resolve(m.chunks);
        else if (m.type === "error") reject(new Error(m.message));
      };
      worker.postMessage({ type: "run", audio: samples, model: model(), language: $("language").value,
                           device: S.web.device, duration: S.duration });
    });
    stage("Checking for gaps", 98);
    let segs = result.slice();
    S.web.recovered = [];
    for (const [a, b] of F.findGaps(segs, S.duration, audio)) {
      const found = [];
      for (let p = a; p < b - 0.5; p += 28) {           // the live path takes windows under 30 s
        const q = Math.min(b, p + 28);
        const { chunks } = await workerCall({ type: "live", audio: samples.slice(Math.floor(p * 16000), Math.floor(q * 16000)),
                                              model: model(), language: $("language").value, device: S.web.device });
        found.push(...chunks.map((c) => ({ s: c.s + p, e: c.e + p, t: c.t })));
      }
      const before = segs.filter((x) => x.e <= a + 0.5).map((x) => x.t).join(" ").slice(-200);
      const after = segs.filter((x) => x.s >= b - 0.5).map((x) => x.t).join(" ").slice(0, 200);
      const added = found.map((c, i) => ({ ...c, t: F.trimOverlap(i === 0 ? before : "", c.t, i === found.length - 1 ? after : "") })).filter((c) => c.t);
      if (!added.length) continue;
      segs = segs.concat(added).sort((x, y) => x.s - y.s);
      S.segments.push(...added);
      S.web.recovered.push({ s: a, e: b, words: added.reduce((n, c) => n + F.wordCount(c.t), 0) });
      job.log.push(`re-transcribed a skipped passage at ${hms(a)}-${hms(b)}`);
    }
    stage("Writing files", 99);
    S.web.segs = segs.map((c) => ({ start: Math.round(c.s * 1000), end: Math.round(c.e * 1000), text: c.t }));
    S.segments = segs;
    job.timings.total = (performance.now() - t0) / 1000;
    S.web.meta = { model: `Whisper ${model()} in the browser, ${S.web.device === "webgpu" ? "WebGPU" : "WebAssembly"}`, language: $("language").value };
    webWriteOutputs();
    stage("Finished", 100);
    Object.assign(job, { state: "done", progress: 100, elapsed: job.timings.total });
    render();
  } catch (e) {
    if (job.state === "running") fail(e.message || String(e));
  }
}

function webWriteOutputs() {
  const pairs = F.parseReplacements($("replacements").value);
  const sections = F.parseSections($("sections").value);
  const segs = S.web.segs;
  const header = F.makeHeader({
    title: $("title").value.trim() || F.suggestTitle(S.file.name), name: S.file.name, duration: S.duration,
    model: S.web.meta.model, language: S.web.meta.language === "auto" ? null : S.web.meta.language,
    prompt: "", pairs, recovered: S.web.recovered,
    speakers: new Set(segs.map((x) => x.speaker).filter(Boolean)).size,
  });
  const { markdown, paragraphs } = F.buildMarkdown(segs, sections, pairs, header, S.web.audio.pauses);
  const raw = segs.map((s) => s.text).join(" ").replace(/\s+/g, " ");
  const stats = F.computeStats(segs, S.duration, pairs, raw, S.job.timings, paragraphs, sections.length, S.web.audio);
  stats.model = S.web.meta.model;
  stats.language = S.web.meta.language;
  stats.mode = "file";
  stats.recovered = S.web.recovered;
  S.web.outputs = { md: markdown, srt: F.buildSrt(segs, pairs), txt: F.buildTxt(segs, pairs) };
  S.job.stats = stats;
}

/* ---------------- rendering the FILE run */

function render(reset) {
  const job = S.job;
  if (!job) return;
  if (!isMac && job.state === "running") job.elapsed = (performance.now() - job.started) / 1000;
  if (!isMac) job.stage_elapsed = (performance.now() - (job.stageStarted || performance.now())) / 1000;
  const run = job.state === "running";
  if (S.mode === "file") $("studio").classList.remove("hidden");
  $("go").disabled = run || !S.file;
  $("cancel").classList.toggle("hidden", !run);
  $("ptitle").textContent = run ? `Transcribing ${job.name || ""}` : (job.name || "Progress");

  const stages = isMac ? MAC_STAGES : WEB_STAGES;
  const idx = job.state === "done" ? stages.length : stages.indexOf(job.stage);
  $("stages").innerHTML = stages.map((s, i) => {
    const t = job.timings && job.timings[s];
    const cls = i < idx ? "done" : i === idx && run ? "active" : "";
    return `<span class="stage ${cls}"><span class="dot"></span>${s}${t != null && i < idx ? ` <em>${human(t)}</em>` : ""}</span>`;
  }).join("");

  // ring
  const pct = job.state === "done" ? 100 : Math.floor(job.progress || 0);
  $("arc").style.strokeDashoffset = 326.73 * (1 - pct / 100);
  $("pct").innerHTML = `${pct}<small>%</small>`;
  $("ringlbl").textContent = job.state === "done" ? "Finished" : job.state === "error" ? "Stopped" : job.state === "cancelled" ? "Cancelled"
    : job.download ? `Downloading model ${Math.round(job.download.got / 1e6)} of ${Math.round(job.download.tot / 1e6)} MB` : job.stage;

  // banner
  const ok = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/></svg>';
  const bad = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>';
  if (job.state === "done") {
    $("banner").innerHTML = `<div class="banner ok">${ok}<div><b>Finished</b> in ${human(job.elapsed || (job.timings && job.timings.total))}. ${isMac ? "Three files written beside the recording." : "Download the files from the summary below."}</div></div>`;
  } else if (job.state === "error") {
    $("banner").innerHTML = `<div class="banner err">${bad}<div><b>Something went wrong.</b> ${esc(job.message)}
      ${job.log && job.log.length ? `<details style="margin-top:6px"><summary>Technical log</summary><pre>${esc(job.log.join("\n"))}</pre></details>` : ""}</div></div>`;
  } else if (job.state === "cancelled") {
    $("banner").innerHTML = `<div class="banner err">${bad}<div><b>Cancelled.</b> No files were written.</div></div>`;
  } else $("banner").innerHTML = "";

  // position and speed
  const pos = job.state === "done" ? S.duration
    : isMac ? (S.segments.length ? S.segments[S.segments.length - 1].e : 0)
    : (job.partial ? job.partial.s : job.position || 0);
  const t = job.stage === "Transcribing" ? job.stage_elapsed : null;
  if (run && t != null && t > 0.5) {
    const last = S.speed[S.speed.length - 1];
    if ((!last || t - last.t >= 0.6) && pos > 0) S.speed.push({ t, pos });
  }
  const sp = speedSeries();
  const speedNow = job.state === "done" && job.stats && job.stats.speed ? job.stats.speed : sp.length ? sp[sp.length - 1].v : null;
  const words = S.segments.reduce((n, s) => n + F.wordCount(s.t), 0);
  $("tiles").innerHTML = [
    ["Position", `${clock(pos)}<small> of ${clock(S.duration)}</small>`],
    ["Speed", speedNow ? `${speedNow.toFixed(1)}<small>×</small>` : "–"],
    ["Elapsed", human(job.elapsed)],
    ["Time left", run && job.eta != null ? `~${human(job.eta)}` : run && speedNow && S.duration ? `~${human((S.duration - pos) / speedNow)}` : "–"],
    ["Words", fmt(words)],
    ["Segments", fmt(S.segments.length)],
  ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  // live text
  const fresh = S.fresh || [];
  S.fresh = [];
  if (reset) $("live").innerHTML = "";
  const live = $("live");
  live.querySelector(".cur.partial")?.remove();
  for (const s of fresh) {
    live.querySelector(".cur")?.classList.remove("cur", "caret");
    const p = document.createElement("p");
    p.className = "cur caret";
    p.innerHTML = `<time>${clock(s.s)}</time>${esc(s.t)}`;
    live.appendChild(p);
  }
  if (job.partial && job.partial.t && run) {
    const p = document.createElement("p");
    p.className = "cur partial caret";
    p.innerHTML = `<time>${clock(job.partial.s)}</time>${esc(job.partial.t)}`;
    live.appendChild(p);
  }
  if (!run) live.querySelectorAll(".caret").forEach((p) => p.classList.remove("caret"));
  while (live.children.length > 200) live.removeChild(live.firstChild);
  if (fresh.length || job.partial) live.scrollTop = live.scrollHeight;
  $("live").classList.toggle("hidden", !run);           // once finished, the timeline and files take over

  // axis
  const D = S.duration || 0;
  $("axis").innerHTML = D ? [0, .25, .5, .75, 1].map((f) => `<span>${clock(D * f)}</span>`).join("") : "";
  S.pos = pos;
  drawWave();
  drawSpeed(sp);
  drawMiniWpm();
  drawTerms();

  if (job.state === "done" && job.stats) {
    job.stats.mode = "file";
    if (JSON.stringify(S.stats) !== JSON.stringify(job.stats)) renderSummary(job.stats);
    if (!S.doc && !S.docOpening) { S.docOpening = true; openDoc("file").finally(() => { S.docOpening = false; }); }
  }
}

function speedSeries() {
  const out = [];
  for (let i = 1; i < S.speed.length; i++) {
    const a = S.speed[Math.max(0, i - 4)], b = S.speed[i];
    if (b.t > a.t) out.push({ t: b.t, v: Math.max(0, (b.pos - a.pos) / (b.t - a.t)) });
  }
  return out;
}

/* ---------------- canvases and charts */

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (!W) return null;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, W, H };
}

let hoverX = null;
function drawWave() {
  const c = $("wave");
  if (!c || $("studio").classList.contains("hidden")) return;
  const s = sizeCanvas(c);
  if (!s) return;
  const { g, W, H } = s;
  const D = S.duration || 1, pos = S.job && S.job.state === "done" ? D : (S.pos || 0);
  const band = 14, waveH = H - band - 22, mid = 8 + waveH / 2;
  const px = (t) => (t / D) * W;
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#4f9bff"); grad.addColorStop(1, "#2fd3bd");

  // silences
  g.fillStyle = "rgba(255,255,255,.07)";
  for (const [len, at] of S.pauses || []) g.fillRect(px(at), 4, Math.max(1, px(len)), waveH + 8);

  const peaks = S.wave;
  if (peaks && peaks.length) {
    const step = W / peaks.length, bw = Math.max(1, step - (step > 3 ? 1 : 0));
    for (let i = 0; i < peaks.length; i++) {
      const x = i * step, h = Math.max(1.5, peaks[i] * waveH);
      g.fillStyle = (i / peaks.length) * D < pos ? grad : "#2c3654";
      g.fillRect(x, mid - h / 2, bw, h);
    }
  } else {
    const n = 140, t0 = performance.now() / 500;
    g.fillStyle = "#2c3654";
    for (let i = 0; i < n; i++) {
      const h = 6 + 26 * (0.5 + 0.5 * Math.sin(i * 0.33 + t0)) * (0.5 + 0.5 * Math.sin(i * 0.06 - t0 / 3));
      g.fillRect((i * W) / n, mid - h / 2, Math.max(1, W / n - 2), h);
    }
  }
  // recognised speech
  const y = H - band - 4;
  g.fillStyle = "rgba(255,255,255,.04)";
  g.fillRect(0, y, W, band);
  g.fillStyle = "#2fd3bd";
  for (const seg of S.segments) {
    const x0 = px(seg.s), x1 = Math.max(x0 + 1, px(seg.e ?? seg.s) - 1);
    g.fillRect(x0, y + 3, x1 - x0, band - 6);
  }
  // playhead
  if (pos > 0 && pos < D) {
    g.shadowColor = "#2fd3bd"; g.shadowBlur = 12;
    g.fillStyle = "#ffffff";
    g.fillRect(px(pos) - 1, 2, 2, H - 4);
    g.beginPath(); g.arc(px(pos), 5, 4, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
  }
  if (hoverX != null) { g.fillStyle = "rgba(255,255,255,.5)"; g.fillRect(hoverX, 0, 1, H); }
}

function waveHover(e) {
  const r = $("wave").getBoundingClientRect();
  hoverX = e.clientX - r.left;
  const t = (hoverX / r.width) * (S.duration || 0);
  const seg = S.segments.find((s) => t >= s.s && t <= (s.e ?? s.s) + 0.5);
  const tip = $("wavetip");
  tip.innerHTML = `<b>${clock(t)}</b>${seg ? " · " + esc(seg.t) : ""}`;
  tip.classList.remove("hidden");
  tip.style.left = `${Math.min(Math.max(0, hoverX + 12), r.width - tip.offsetWidth)}px`;
  tip.style.top = "-8px";
  tip.style.transform = "translateY(-100%)";
  drawWave();
}

function drawSpeed(series) {
  const host = $("speedchart"), W = host.clientWidth || 260, H = 90;
  $("speednow").textContent = series.length ? `${series[series.length - 1].v.toFixed(1)}×` : "";
  if (series.length < 2) { host.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text x="0" y="50">Measuring once transcription starts…</text></svg>`; return; }
  const tMax = series[series.length - 1].t, vMax = Math.max(1, ...series.map((p) => p.v)) * 1.15;
  const x = (t) => (t / tMax) * W, y = (v) => H - 14 - (H - 20) * (v / vMax);
  const line = series.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Transcription speed over time">
    <defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fd3bd" stop-opacity=".45"/><stop offset="1" stop-color="#2fd3bd" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${W}" y1="${H - 14}" y2="${H - 14}" stroke="#27304d"/>
    <path d="${line}L${x(tMax)},${H - 14}L${x(series[0].t)},${H - 14}Z" fill="url(#spg)"/>
    <path d="${line}" fill="none" stroke="#2fd3bd" stroke-width="2" stroke-linejoin="round"/>
    <text x="0" y="${H - 2}">0s</text><text x="${W}" y="${H - 2}" text-anchor="end">${human(tMax)}</text></svg>`;
}

function livePerMinute(segments, duration) {
  const n = Math.max(1, Math.ceil((duration || 0) / 60)), out = new Array(n).fill(0);
  for (const s of segments) {
    const w = F.wordCount(s.t), a = s.s, b = Math.max(s.e ?? s.s, s.s + 0.01);
    for (let m = Math.floor(a / 60); m * 60 < b && m < n; m++) out[m] += (w * (Math.min(b, (m + 1) * 60) - Math.max(a, m * 60))) / (b - a);
  }
  return out;
}

function drawMiniWpm() {
  const host = $("wpmlive"), W = host.clientWidth || 260, H = 90;
  const vals = livePerMinute(S.segments, S.duration);
  const max = Math.max(160, ...vals), cw = W / vals.length, bw = Math.min(24, Math.max(1, cw - (cw > 4 ? 2 : 0)));
  let bars = "";
  vals.forEach((v, i) => {
    const h = (H - 16) * (v / max);
    if (h > 0.5) bars += `<rect x="${(i * cw + (cw - bw) / 2).toFixed(1)}" y="${(H - 14 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 2)}" fill="url(#wg)"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per minute so far">
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f9bff"/><stop offset="1" stop-color="#2fd3bd"/></linearGradient></defs>
    <line x1="0" x2="${W}" y1="${H - 14}" y2="${H - 14}" stroke="#27304d"/>${bars}
    <text x="0" y="${H - 2}">0:00</text><text x="${W}" y="${H - 2}" text-anchor="end">${clock(S.duration)}</text></svg>`;
}

function drawTerms() {
  const counts = new Map();
  for (const s of S.segments) {
    for (const w of (s.t.toLowerCase().match(/[a-z][a-z'’-]*/g) || [])) {
      if (w.length > 3 && !F.STOPWORDS.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 7);
  const max = top.length ? top[0][1] : 1;
  $("terms").innerHTML = top.length
    ? top.map(([w, c]) => `<div class="term"><span>${esc(w)}</span><div class="b" style="width:${(100 * c / max).toFixed(0)}%"></div><span>${c}</span></div>`).join("")
    : '<div class="term" style="color:var(--s-text-3)">Waiting for words…</div>';
}

/* ================================================================ summary (both modes) */

function renderSummary(stats) {
  S.stats = stats;
  const sum = $("summary");
  sum.classList.toggle("hidden", stats.mode !== S.mode);
  $("sumtitle").textContent = stats.mode === "live" ? "Live session summary" : "Summary";
  const conf = stats.confidence;
  $("hero").innerHTML = [
    ["Recording", clock(stats.duration, stats.duration)],
    ["Words", fmt(stats.words)],
    stats.mode === "live" ? ["Corrections", `${fmt(stats.edited || 0)}<small> lines</small>`]
      : ["Speed", stats.speed ? `${stats.speed.toFixed(1)}<small>× real time</small>` : "–"],
    ["Pace", `${fmt(stats.wpm)}<small> wpm</small>`],
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  const rows = [
    ["Processing time", stats.mode === "live" ? null : human(stats.processing)],
    ["Distinct words", fmt(stats.unique_words)],
    ["Pace, excl. silence", `${fmt(stats.speaking_wpm)} wpm`],
    ["Audible", `${Math.round(100 * stats.audible_ratio)}%`],
    ["Silences ≥ 2 s", fmt(stats.pauses)],
    ["Longest silence", stats.longest_pause ? `${stats.longest_pause.seconds.toFixed(1)} s at ${clock(stats.longest_pause.at, stats.duration)}` : "–"],
    ["Paragraphs", fmt(stats.paragraphs)],
    ["Segments", fmt(stats.segments)],
    ["Tags", stats.mode === "live" ? fmt(stats.tags || 0) : null],
    ["Skipped passages recovered", stats.recovered && stats.recovered.length
      ? stats.recovered.map((g) => `${clock(g.s, stats.duration)}–${clock(g.e, stats.duration)}`).join(", ") : null],
    ["Mean confidence", conf && conf.mean != null ? `${Math.round(conf.mean * 100)}%` : null],
    ["Model", stats.model],
    ["Language", stats.language || "auto"],
  ].filter(([, v]) => v != null);
  $("stats").innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");

  // where the time went
  const timings = Object.entries(stats.timings || {}).filter(([k, v]) => k !== "total" && k !== "Finished" && v > 0);
  $("timewrap").classList.toggle("hidden", stats.mode === "live" || !timings.length);
  const total = timings.reduce((a, [, v]) => a + v, 0) || 1;
  $("timebar").innerHTML = timings.map(([k, v], i) =>
    `<div title="${esc(k)}: ${human(v)}" style="flex:${v / total};background:${SERIES[i % SERIES.length]}"></div>`).join("");
  $("timekey").innerHTML = timings.map(([k, v], i) =>
    `<span><i style="background:${SERIES[i % SERIES.length]}"></i>${esc(k)}<b>${human(v)}</b></span>`).join("");

  drawLanes();
  drawWpm(stats.per_minute, $("wpm"), stats.duration);

  // words to check
  const low = conf && conf.low_words || [];
  $("checkwrap").classList.toggle("hidden", !low.length);
  $("lowwords").innerHTML = low.map((w) =>
    `<button class="chip warn" data-w="${esc(w.w)}" title="at ${clock(w.t, stats.duration)}">${esc(w.w)}<span>${Math.round(w.p * 100)}% · ${clock(w.t, stats.duration)}</span></button>`).join("");
  $("names").innerHTML = stats.names.length
    ? stats.names.map(([w, c]) => `<button class="chip" data-w="${esc(w)}">${esc(w)}<span>${c}</span></button>`).join("")
    : '<span class="muted small">None found.</span>';
  sum.querySelectorAll("#lowwords button, #names button").forEach((b) => b.addEventListener("click", () => addReplacement(b.dataset.w)));
  const tmax = stats.top_words.length ? stats.top_words[0][1] : 1;
  $("topwords").innerHTML = stats.top_words.slice(0, 12).map(([w, c]) =>
    `<div class="hbar"><span>${esc(w)}</span><div class="b" style="width:${(100 * c / tmax).toFixed(1)}%"></div><span>${c}</span></div>`).join("");
  $("repwrap").classList.toggle("hidden", !stats.replacements.length);
  $("reps").innerHTML = stats.replacements.map((r) =>
    `<tr><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td class="n">${r.count}</td></tr>`).join("");
  renderFiles(stats.mode);
}

function renderFiles(mode) {
  const files = $("files");
  if (isMac) {
    const outs = (mode === "live" ? S.live.outputs : S.job && S.job.outputs) || [];
    files.innerHTML = outs.map((p) => `<div class="file"><span class="ext">${p.split(".").pop()}</span><span class="p">${esc(p)}</span>
      <button data-open="${esc(p)}">Open</button><button data-reveal="${esc(p)}">Show in Finder</button></div>`).join("");
    files.querySelectorAll("button").forEach((b) => b.addEventListener("click", () =>
      api("/api/open", { path: b.dataset.open || b.dataset.reveal, reveal: !!b.dataset.reveal }).catch((e) => toast(e.message))));
  } else {
    const outs = mode === "live" ? S.live.outputs : S.web.outputs;
    const base = (mode === "live" ? S.live.outname : $("outname").value.trim()) || "transcript";
    if (!outs) { files.innerHTML = ""; return; }
    const kinds = [["md", "Markdown"], ["srt", "Subtitles"], ["txt", "Plain text"]].concat(outs.wav ? [["wav", "Audio"]] : []);
    files.innerHTML = kinds.map(([k, label]) => `<div class="file"><span class="ext">${k}</span><span class="p">${esc(base)}.${k} · ${label}</span>
      <button data-k="${k}">Download</button></div>`).join("") + `<div><button id="dlall">Download all</button></div>`;
    const get = (k) => download(`${base}.${k}`, outs[k], k === "wav" ? "audio/wav" : "text/plain;charset=utf-8");
    files.querySelectorAll("button[data-k]").forEach((b) => b.addEventListener("click", () => get(b.dataset.k)));
    $("dlall").addEventListener("click", () => kinds.forEach(([k], i) => setTimeout(() => get(k), i * 350)));
  }
}

function addReplacement(w) {
  const ta = $("replacements");
  ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, "\n") : "") + `${w} => ${w}`;
  store.set("replacements", ta.value);
  ta.scrollIntoView({ behavior: "smooth", block: "center" });
  ta.focus();
  ta.setSelectionRange(ta.value.length - w.length, ta.value.length);
}

/* ---------------- timeline lanes */

let laneHover = null;
function laneSpec() {
  const st = S.stats;
  if (!st) return [];
  const lanes = [{ key: "wave", label: "Waveform", h: 40 }, { key: "silence", label: "Silence ≥ 2 s", h: 12 }];
  if (st.confidence && st.confidence.segments && st.confidence.segments.length) lanes.push({ key: "conf", label: "Confidence", h: 14 });
  if (st.recovered && st.recovered.length) lanes.push({ key: "recov", label: "Re-transcribed", h: 10 });
  if (S.doc && S.doc.mode === st.mode && speakersInUse().length) lanes.push({ key: "spk", label: "Speakers", h: 14 });
  lanes.push({ key: "wpm", label: "Words / minute", h: 14 });
  if (st.mode === "live" && S.live.tags.length) lanes.push({ key: "tags", label: "Tags", h: 16 });
  return lanes;
}

function drawLanes() {
  const st = S.stats, host = $("lanes");
  if (!st || $("summary").classList.contains("hidden")) return;
  const lanes = laneSpec();
  if (host.dataset.keys !== lanes.map((l) => l.key).join()) {
    host.dataset.keys = lanes.map((l) => l.key).join();
    host.innerHTML = lanes.map((l) => `<div class="ln">${l.label}</div><canvas data-lane="${l.key}" style="height:${l.h}px"></canvas>`).join("");
    host.querySelectorAll("canvas").forEach((c) => {
      c.addEventListener("mousemove", laneMove);
      c.addEventListener("click", (e) => {
        const r = c.getBoundingClientRect();
        if (S.doc) seekPlay(((e.clientX - r.left) / r.width) * S.stats.duration);
      });
      c.addEventListener("mouseleave", () => { laneHover = null; $("lanetip").classList.add("hidden"); drawLanes(); });
    });
  }
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), muted = css.getPropertyValue("--text-3").trim();
  const D = st.duration || 1;
  const peaks = st.mode === "live" ? S.live.summaryPeaks : (S.wave || []);
  const pauses = st.pause_list || [];
  const perMin = st.per_minute || [];
  const pmMax = Math.max(1, ...perMin);
  host.querySelectorAll("canvas").forEach((c) => {
    const s = sizeCanvas(c);
    if (!s) return;
    const { g, W, H } = s, px = (t) => (t / D) * W, key = c.dataset.lane;
    if (key === "wave") {
      const step = W / Math.max(1, peaks.length);
      g.fillStyle = accent;
      peaks.forEach((p, i) => { const h = Math.max(1, p * (H - 4)); g.fillRect(i * step, (H - h) / 2, Math.max(1, step - 0.5), h); });
    } else if (key === "silence") {
      g.fillStyle = muted;
      for (const p of pauses) g.fillRect(px(p.at), 2, Math.max(2, px(p.seconds)), H - 4);
    } else if (key === "conf") {
      for (const seg of st.confidence.segments) {
        g.fillStyle = seg.p >= 0.8 ? "#1baf7a" : seg.p >= 0.5 ? "rgba(27,175,122,.45)" : "#eda100";
        g.fillRect(px(seg.s), 2, Math.max(1, px(seg.e) - px(seg.s) - 1), H - 4);
      }
    } else if (key === "spk") {
      for (const x of S.doc.segs) {
        if (!x.spk) continue;
        g.fillStyle = spkColor(x.spk);
        g.fillRect(px(x.s), 2, Math.max(1, px(x.e) - px(x.s) - 1), H - 4);
      }
    } else if (key === "recov") {
      g.fillStyle = "#4a3aa7";
      for (const r of st.recovered) g.fillRect(px(r.s), 2, Math.max(2, px(r.e) - px(r.s)), H - 4);
    } else if (key === "wpm") {
      const cw = W / perMin.length;
      perMin.forEach((v, i) => {
        g.fillStyle = accent;
        g.globalAlpha = 0.12 + 0.88 * (v / pmMax);
        g.fillRect(i * cw, 2, Math.max(1, cw - 1), H - 4);
      });
      g.globalAlpha = 1;
    } else if (key === "tags") {
      for (const t of S.live.tags) {
        g.fillStyle = t.kind === "marker" ? "#eda100" : accent;
        g.beginPath(); g.moveTo(px(t.t), 2); g.lineTo(px(t.t) + 6, H / 2); g.lineTo(px(t.t), H - 2); g.closePath(); g.fill();
      }
    }
    if (laneHover != null) { g.fillStyle = css.getPropertyValue("--text").trim(); g.globalAlpha = .55; g.fillRect(laneHover * W, 0, 1, H); g.globalAlpha = 1; }
  });
  $("lanekey").innerHTML = lanes.some((l) => l.key === "conf")
    ? `<span><i style="background:#1baf7a"></i>Confident (≥ 80%)</span><span><i style="background:rgba(27,175,122,.45)"></i>50–80%</span><span><i style="background:#eda100"></i>Low (&lt; 50%), worth checking</span><span><i style="background:var(--accent)"></i>Darker words/minute = faster speech</span>${st.recovered && st.recovered.length ? '<span><i style="background:#4a3aa7"></i>Re-transcribed (skipped by the first pass)</span>' : ""}`
    : `<span><i style="background:var(--accent)"></i>Darker words/minute = faster speech</span>`;
}

function laneMove(e) {
  const st = S.stats, c = e.currentTarget, r = c.getBoundingClientRect(), wrap = $("lanes").getBoundingClientRect();
  laneHover = (e.clientX - r.left) / r.width;
  const t = laneHover * st.duration;
  const segs = st.mode === "live" ? S.live.segs : S.segments;
  const seg = segs.find((s) => t >= s.s && t <= (s.e ?? s.s) + 0.5);
  const conf = st.confidence && st.confidence.segments.find((s) => t >= s.s && t <= s.e);
  const pause = (st.pause_list || []).find((p) => t >= p.at && t <= p.at + p.seconds);
  const recov = (st.recovered || []).find((g) => t >= g.s && t <= g.e);
  const tag = st.mode === "live" && S.live.tags.find((g) => Math.abs(g.t - t) < st.duration / 150);
  const tip = $("lanetip");
  tip.innerHTML = `<b>${clock(t, st.duration)}</b>` +
    (tag ? ` · tag “${esc(tag.label)}”` : "") +
    ((() => { const d = S.doc && S.doc.mode === st.mode && S.doc.segs.find((x) => t >= x.s && t <= x.e); return d && d.spk ? ` · ${esc(spkName(d.spk))}` : ""; })()) +
    (pause ? ` · silence of ${pause.seconds.toFixed(1)} s` : "") +
    (recov ? " · re-transcribed after the first pass skipped it" : "") +
    (conf ? ` · confidence ${Math.round(conf.p * 100)}%` : "") +
    (seg ? `<br>${esc(seg.t)}` : "");
  tip.classList.remove("hidden");
  const x = e.clientX - wrap.left;
  tip.style.left = `${Math.min(Math.max(0, x + 12), wrap.width - tip.offsetWidth)}px`;
  tip.style.top = `${r.top - wrap.top - 8}px`;
  tip.style.transform = "translateY(-100%)";
  drawLanes();
}

function drawWpm(values, host, duration) {
  const W = host.clientWidth || 800, H = 140, padL = 30, padB = 18, padT = 6;
  const n = values.length, top = Math.ceil(Math.max(200, ...values) / 50) * 50;
  const cw = (W - padL) / n, bw = Math.min(36, Math.max(1, cw - (cw > 6 ? 2 : cw > 3 ? 1 : 0)));
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per minute, by minute of the recording"><g class="grid">`;
  for (let v = 0; v <= top; v += top / 2) svg += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  svg += "</g>";
  values.forEach((v, i) => {
    const x = padL + i * cw + (cw - bw) / 2, h = Math.max(0, y(0) - y(v));
    if (h > 0) {
      const r = Math.min(4, bw / 2, h);
      svg += `<path d="M${x},${y(0)} V${y(v) + r} q0,-${r} ${r},-${r} H${x + bw - r} q${r},0 ${r},${r} V${y(0)} Z" fill="var(--accent)"/>`;
    }
  });
  const every = n > 60 ? 10 : n > 20 ? 5 : n > 8 ? 2 : 1;
  for (let i = 0; i < n; i += every) svg += `<text x="${padL + (i + 0.5) * cw}" y="${H - 4}" text-anchor="middle">${i}m</text>`;
  values.forEach((v, i) => { svg += `<rect data-i="${i}" x="${padL + i * cw}" y="0" width="${cw}" height="${H}" fill="transparent"/>`; });
  host.innerHTML = svg + `</svg><div class="tip hidden"></div>`;
  const tip = host.querySelector(".tip");
  host.querySelectorAll("rect[data-i]").forEach((r) => {
    r.addEventListener("mouseenter", () => {
      const i = +r.dataset.i;
      tip.innerHTML = `<b>${clock(i * 60, duration)}–${clock(Math.min((i + 1) * 60, duration), duration)}</b><br>${fmt(values[i])} words`;
      tip.classList.remove("hidden");
      const bx = ((+r.getAttribute("x") + cw / 2) / W) * host.clientWidth;
      tip.style.left = `${Math.min(Math.max(0, bx - 40), host.clientWidth - 140)}px`;
      tip.style.top = "-8px";
      tip.style.transform = "translateY(-100%)";
    });
    r.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  });
}

/* ---------------- after-the-fact corrections and copying */

async function rewrite() {
  $("rewritenote").textContent = "Updating…";
  store.set("replacements", $("replacements").value);
  try {
    if (S.doc && S.doc.mode === S.stats?.mode) {
      await saveDoc(false);
    } else if (S.stats && S.stats.mode === "live") {
      await liveSave(true);
    } else if (isMac) {
      const r = await api("/api/rewrite", { replacements: $("replacements").value, sections: $("sections").value, title: $("title").value });
      S.job.stats = r.stats; r.stats.mode = "file";
      renderSummary(r.stats);
    } else {
      webWriteOutputs();
      renderSummary(S.job.stats);
    }
    $("rewritenote").textContent = isMac ? "Files updated." : "Updated; download the files again.";
  } catch (e) { $("rewritenote").textContent = e.message; }
}

async function transcriptText(kind) {
  if (S.stats && S.stats.mode === "live" && S.live.outputs) {
    if (!isMac) return S.live.outputs[kind];
    return S.live.text[kind];
  }
  if (isMac) {
    const r = await fetch(`/api/transcript?kind=${kind}`);
    if (!r.ok) throw new Error("No finished transcript.");
    return r.text();
  }
  if (!S.web.outputs) throw new Error("No finished transcript.");
  return S.web.outputs[kind];
}

async function copyTranscript(kind) {
  try {
    await navigator.clipboard.writeText(await transcriptText(kind));
    toast(kind === "md" ? "Markdown copied." : "Plain text copied.");
  } catch (e) { toast(e.message); }
}

async function quit() {
  if ((running() || (S.live && S.live.state === "recording")) && !confirm("Transcription is running. Stop it and quit?")) return;
  try { await api("/api/quit"); } catch (e) { /* already gone */ }
  document.querySelector("main").innerHTML = '<div class="card"><h2>Transcriber stopped</h2><p>Open it again from Applications (Transcriber).</p></div>';
}

/* ================================================================ speakers, transcript panel, playback */

const SPK_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SAME_SPEAKER = 0.38;   // cosine similarity of two voice embeddings at or above which they count as one speaker
S.doc = null;                // the transcript under review: {mode, segs: [{s, e, t, spk, edited}], duration, peaks}
S.names = {};                // speaker number -> name typed by the user

const spkName = (n) => (n ? S.names[n] || `Speaker ${n}` : null);
const spkColor = (n) => SPK_COLORS[(n - 1) % SPK_COLORS.length];
const dot = (a, b) => { let x = 0; for (let i = 0; i < a.length; i++) x += a[i] * b[i]; return x; };
const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const speakersInUse = () => (S.doc ? [...new Set(S.doc.segs.map((x) => x.spk).filter(Boolean))].sort((a, b) => a - b) : []);

// Up to 8 s from the middle of a span; null under 0.8 s, too short to recognise a voice.
function clipSpan(s, e, slice) {
  let a = s, b = e;
  if (b - a > 8) { const mid = (a + b) / 2; a = mid - 4; b = mid + 4; }
  return b - a < 0.8 ? null : slice(a, b);
}

async function embedClips(clips, onProgress) {
  S.web.device = S.web.device || await detectDevice();
  const transfer = clips.filter(Boolean).map((c) => c.buffer);
  return (await workerCall({ type: "embed", clips, device: S.web.device }, onProgress, transfer)).vectors;
}

/** Group voice embeddings into speakers; k = 0 lets the voices decide how many. Returns speaker
 *  numbers in order of first appearance; lines without an embedding take a neighbour's. */
function clusterSpeakers(vectors, k) {
  const idx = vectors.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return vectors.map(() => null);
  let cents = [];
  if (k) {
    cents.push(vectors[idx[0]]);
    while (cents.length < Math.min(k, idx.length)) {        // farthest-point seeding
      let far = idx[0], low = 2;
      for (const i of idx) { const sim = Math.max(...cents.map((c) => dot(c, vectors[i]))); if (sim < low) { low = sim; far = i; } }
      cents.push(vectors[far]);
    }
  } else {
    const sums = [];
    for (const i of idx) {                                   // join the closest voice or start a new one
      const sims = sums.map((c) => dot(unit(c), vectors[i]));
      const j = sims.length ? sims.indexOf(Math.max(...sims)) : -1;
      if (j < 0 || sims[j] < SAME_SPEAKER) sums.push([...vectors[i]]);
      else vectors[i].forEach((x, d) => { sums[j][d] += x; });
    }
    cents = sums.map(unit);
  }
  const nearest = (v) => { let best = 0, top = -2; cents.forEach((c, j) => { const sim = dot(c, v); if (sim > top) { top = sim; best = j; } }); return best; };
  for (let iter = 0; iter < 12; iter++) {
    const assign = idx.map((i) => nearest(vectors[i]));
    cents = cents.map((c, j) => {
      const sum = new Array(c.length).fill(0);
      let n = 0;
      assign.forEach((a, m) => { if (a === j) { n++; vectors[idx[m]].forEach((x, d) => { sum[d] += x; }); } });
      return n ? unit(sum) : null;
    }).filter(Boolean);
    if (!k && cents.length > 1) {
      // merge voices that turn out to be one speaker; fold away "speakers" with almost no speech
      for (let a = 0; a < cents.length; a++) {
        for (let b = cents.length - 1; b > a; b--) {
          if (dot(cents[a], cents[b]) >= SAME_SPEAKER + 0.1) { cents[a] = unit(cents[a].map((x, d) => x + cents[b][d])); cents.splice(b, 1); }
        }
      }
      const counts = cents.map(() => 0);
      for (const i of idx) counts[nearest(vectors[i])]++;
      const min = Math.max(2, Math.ceil(idx.length * 0.03));
      const kept = cents.filter((c, j) => counts[j] >= min);
      cents = kept.length ? kept : cents;
    }
  }
  const order = new Map(), out = vectors.map(() => null);
  for (const i of idx) {
    const j = nearest(vectors[i]);
    if (!order.has(j)) order.set(j, order.size + 1);
    out[i] = order.get(j);
  }
  for (let i = 1; i < out.length; i++) if (out[i] == null) out[i] = out[i - 1];
  for (let i = out.length - 2; i >= 0; i--) if (out[i] == null) out[i] = out[i + 1];
  return out;
}

async function audioSlicer(mode) {
  if (mode === "live") return (a, b) => audioSlice(Math.floor(a * 16000), Math.floor(b * 16000));
  if (!isMac) return (a, b) => S.web.samples.slice(Math.floor(a * 16000), Math.floor(b * 16000));
  return async (a, b) => {
    const r = await fetch(`/api/clip?s=${a.toFixed(2)}&e=${b.toFixed(2)}`);
    const pcm = new Int16Array(await r.arrayBuffer());
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
    return out;
  };
}

async function identifySpeakers() {
  const doc = S.doc, setting = $("speakers").value;
  if (!doc || setting === "off") return;
  const status = (t) => { S.spkStatus = t; renderSpeakerBar(); };
  try {
    if (setting === "1") {
      doc.segs.forEach((x) => { if (!x.spkManual) x.spk = 1; });
    } else {
      status("Identifying speakers: loading the voice model…");
      const slice = await audioSlicer(doc.mode), clips = [];
      for (const x of doc.segs) clips.push(x.vec ? null : await clipSpan(x.s, x.e, slice));
      const fresh = await embedClips(clips, (m) => {
        if (m.type === "embed-progress") status(`Identifying speakers: ${m.done} of ${m.total} lines…`);
        else if (m.total) status(`Identifying speakers: downloading the voice model, ${Math.round((m.loaded || 0) / 1e6)} of ${Math.round(m.total / 1e6)} MB…`);
      });
      doc.segs.forEach((x, i) => { if (fresh[i]) x.vec = fresh[i]; });
      const labels = stableLabels(clusterSpeakers(doc.segs.map((x) => x.vec || null), setting === "auto" ? 0 : +setting),
                                  doc.segs.map((x) => x.spk));
      doc.segs.forEach((x, i) => { if (!x.spkManual) x.spk = labels[i]; });
    }
    S.spkStatus = "";
    renderDoc();
    drawLanes();
    await saveDoc(true);
  } catch (e) {
    status(`Speakers weren't identified: ${e.message}`);
  }
}

// LIVE: each new line is matched against the voices heard so far.
function liveAssign(v) {
  const L = S.live, setting = $("speakers").value, k = setting === "auto" ? 0 : +setting;
  L.cents = L.cents || [];
  const sims = L.cents.map((c) => dot(unit(c), v));
  const j = sims.length ? sims.indexOf(Math.max(...sims)) : -1;
  if (j >= 0 && (sims[j] >= SAME_SPEAKER || (k && L.cents.length >= k) || L.cents.length >= 8)) {
    v.forEach((x, d) => { L.cents[j][d] += x; });
    return j + 1;
  }
  L.cents.push([...v]);
  return L.cents.length;
}

function liveSpeaker(line) {
  const setting = $("speakers").value, L = S.live;
  if (setting === "off") return;
  const prev = L.segs[L.segs.indexOf(line) - 1];
  if (setting === "1") { line.spk = 1; return; }
  L.spkQueue = (L.spkQueue || Promise.resolve()).then(async () => {
    const clip = clipSpan(line.s, line.e, (a, b) => audioSlice(Math.floor(a * 16000), Math.floor(b * 16000)));
    if (!clip) { if (!line.spk && prev) { line.spk = prev.spk; line.rev = (line.rev || 0) + 1; renderLiveTranscript(); } return; }
    const [v] = await embedClips([clip]);
    if (!v || line.spkManual) return;
    line.vec = v;
    line.spk = liveAssign(v);
    line.rev = (line.rev || 0) + 1;
    renderLiveTranscript();
  }).catch((e) => { $("lstatus").textContent = `Speaker identification paused: ${e.message}`; });
}

// Keep speaker numbers (and the names typed for them) on the voices they had before regrouping.
function stableLabels(labels, previous) {
  const groups = new Map();
  labels.forEach((l, i) => {
    if (l == null) return;
    if (!groups.has(l)) groups.set(l, new Map());
    const p = previous[i];
    if (p) groups.get(l).set(p, (groups.get(l).get(p) || 0) + 1);
  });
  const taken = new Set(), map = new Map();
  const bySize = [...groups].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0));
  for (const [l, prev] of bySize) {
    const best = [...prev].sort((a, b) => b[1] - a[1]).find(([p]) => !taken.has(p));
    if (best) { map.set(l, best[0]); taken.add(best[0]); }
  }
  let next = Math.max(0, ...previous.filter(Boolean), ...taken) + 1;
  for (const [l] of bySize) if (!map.has(l)) map.set(l, next++);
  return labels.map((l) => (l == null ? null : map.get(l)));
}

// The speaker menu, on a speaker chip or a line's time (left or right click): set this line's
// speaker, or move every line of this speaker to another (which merges two speakers).
function speakerMenu(e, x, lines, refreshLine, refreshAll) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  document.querySelector(".menu.ctx")?.remove();
  const used = [...new Set(lines.map((l) => l.spk).filter(Boolean))].sort((a, b) => a - b);
  const fresh = Math.max(0, ...used) + 1;
  const m = document.createElement("div");
  m.className = "menu ctx";
  m.setAttribute("role", "menu");
  const head = (t) => { const h = document.createElement("div"); h.className = "hd"; h.textContent = t; m.appendChild(h); };
  const item = (label, n, checked, run) => {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", checked ? "true" : "false");
    b.innerHTML = `${n ? `<i class="sw" style="background:${spkColor(n)}"></i>` : ""}<span>${esc(label)}</span>`;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); m.remove(); run(); });
    m.appendChild(b);
  };
  head("This line");
  for (const n of used) item(spkName(n), n, x.spk === n, () => { x.spk = n; x.spkManual = true; refreshLine(); });
  item(`New speaker (${spkName(fresh)})`, fresh, false, () => { x.spk = fresh; x.spkManual = true; refreshLine(); });
  if (x.spk) item("No speaker", null, false, () => { x.spk = null; x.spkManual = true; refreshLine(); });
  if (x.spk && used.length > 1) {
    m.appendChild(document.createElement("hr"));
    head(`Every line of ${spkName(x.spk)}`);
    const from = x.spk;
    for (const n of used.filter((n) => n !== from)) {
      item(`Move to ${spkName(n)}`, n, false, () => {
        for (const l of lines) if (l.spk === from) { l.spk = n; l.spkManual = true; }
        refreshAll();
        toast(`${spkName(from)} merged into ${spkName(n)}.`);
      });
    }
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  m.querySelector("button")?.focus();
  m.addEventListener("keydown", (ev) => {
    const items = [...m.querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (ev.key === "Escape") m.remove();
  });
}

// ---- the transcript panel

async function openDoc(mode) {
  let segs, url, duration, peaks;
  if (mode === "live") {
    const L = S.live;
    segs = L.segs;
    duration = liveTime();
    peaks = L.summaryPeaks;
    url = URL.createObjectURL(wavBlob(L.buf.subarray(0, L.total)));
  } else if (isMac) {
    const r = await fetch("/api/segments");
    if (!r.ok) return;
    const names = [];
    segs = (await r.json()).segments.map((x) => {
      let spk = null;
      if (x.spk) { let n = names.indexOf(x.spk); if (n < 0) { names.push(x.spk); n = names.length - 1; } spk = n + 1; }
      return { s: x.s, e: x.e, t: x.t, spk, edited: false };
    });
    names.forEach((nm, i) => { if (nm !== `Speaker ${i + 1}`) S.names[i + 1] = nm; });
    url = `/api/audio?t=${Date.now()}`;
    duration = S.duration;
    peaks = S.wave;
  } else {
    segs = S.web.segs.map((x) => ({ s: x.start / 1000, e: x.end / 1000, t: x.text, spk: null, edited: false }));
    url = S.web.fileUrl || (S.web.fileUrl = URL.createObjectURL(S.file.file));
    duration = S.duration;
    peaks = S.wave;
  }
  if (S.docUrl && S.docUrl.startsWith("blob:") && S.docUrl !== url && S.docUrl !== S.web.fileUrl) URL.revokeObjectURL(S.docUrl);
  S.doc = { mode, segs, duration, peaks, dirty: false };
  S.docUrl = url;
  $("audio").src = url;
  $("audio").playbackRate = +$("prate").value;
  renderDoc();
  if ($("speakers").value !== "off" && (mode === "live" || !segs.some((x) => x.spk))) identifySpeakers();
}

function renderDoc() {
  const doc = S.doc, host = $("doclines");
  if (!doc) return;
  host.innerHTML = "";
  doc.segs.forEach((x, i) => host.appendChild(docLine(x, i)));
  renderSpeakerBar();
  updatePlayer(true);
}

function chipHtml(n) {
  return n ? `<button class="spk" style="--c:${spkColor(n)}" title="Change speaker (click or right-click)">${esc(spkName(n))}</button>` : "";
}

function docLine(x, i) {
  const p = document.createElement("p");
  p.className = "dl" + (x.edited ? " edited" : "");
  p.dataset.i = i;
  const chip = x.spk ? chipHtml(x.spk) : speakersInUse().length ? `<button class="spk none" title="Set speaker">?</button>` : "";
  p.innerHTML = `<button class="ts" title="Play from here">${clock(x.s, S.doc.duration)}</button>${chip}<span contenteditable="plaintext-only" spellcheck="true">${esc(x.t)}</span>`;
  p.querySelector(".ts").addEventListener("click", () => seekPlay(x.s));
  const refreshLine = () => { p.replaceWith(docLine(x, i)); S.doc.dirty = true; renderSpeakerBar(); drawLanes(); };
  const refreshAll = () => { S.doc.dirty = true; renderDoc(); drawLanes(); };
  const menu = (e) => speakerMenu(e, x, S.doc.segs, refreshLine, refreshAll);
  p.querySelector(".spk")?.addEventListener("click", menu);
  p.addEventListener("contextmenu", (e) => { if (!e.target.closest("[contenteditable]")) menu(e); });
  const span = p.querySelector("span");
  span.addEventListener("input", () => {
    x.t = span.textContent.replace(/\s+/g, " ").trim();
    x.edited = true;
    p.classList.add("edited");
    S.doc.dirty = true;
    renderSpeakerBar();
  });
  span.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } });
  return p;
}

function renderSpeakerBar() {
  const bar = $("spkbar"), doc = S.doc;
  if (!doc) { bar.innerHTML = ""; return; }
  const inUse = speakersInUse();
  const secs = {};
  for (const x of doc.segs) if (x.spk) secs[x.spk] = (secs[x.spk] || 0) + (x.e - x.s);
  const total = Object.values(secs).reduce((a, b) => a + b, 0) || 1;
  bar.innerHTML = (S.spkStatus ? `<span>${esc(S.spkStatus)}</span>` : "") +
    inUse.map((n) => `<span class="who"><i style="background:${spkColor(n)}"></i><input data-n="${n}" value="${esc(S.names[n] || "")}" placeholder="Speaker ${n}" aria-label="Name for speaker ${n}"><span>${Math.round(100 * secs[n] / total)}%</span>` +
      (reading() ? `<select data-v="${n}" aria-label="Reading voice for speaker ${n}"><option value="female" ${voiceFor(n) === "female" ? "selected" : ""}>female voice</option><option value="male" ${voiceFor(n) === "male" ? "selected" : ""}>male voice</option></select>` : "") +
      `</span>`).join("") +
    ($("speakers").value !== "off" && !S.spkStatus ? `<button id="respk">${inUse.length ? "Identify speakers again" : "Identify speakers"}</button>` : "") +
    (doc.dirty ? `<span class="muted">Unsaved changes: use “Save corrections” below.</span>` : "");
  bar.querySelectorAll("input[data-n]").forEach((inp) => inp.addEventListener("change", () => {
    const n = +inp.dataset.n;
    if (inp.value.trim()) S.names[n] = inp.value.trim(); else delete S.names[n];
    doc.dirty = true;
    $("doclines").querySelectorAll(".spk").forEach((b) => {
      const x = doc.segs[+b.closest(".dl").dataset.i];
      if (x.spk === n) b.textContent = spkName(n);
    });
    renderSpeakerBar();
  }));
  bar.querySelectorAll("select[data-v]").forEach((sel) => sel.addEventListener("change", () => {
    S.voices[+sel.dataset.v] = sel.value;
    store.set("voices", JSON.stringify(S.voices));
  }));
  $("respk")?.addEventListener("click", () => {
    doc.segs.forEach((x) => { x.spkManual = false; });
    identifySpeakers();
  });
}

async function saveDoc(auto) {
  const doc = S.doc;
  if (!doc) return;
  const segsOut = doc.segs.map((x) => ({ start: Math.round(x.s * 1000), end: Math.round(x.e * 1000), text: x.t, speaker: spkName(x.spk) }));
  if (doc.mode === "live") {
    await liveSave(true);
  } else if (isMac) {
    const r = await api("/api/rewrite", {
      replacements: $("replacements").value, sections: $("sections").value, title: $("title").value,
      segments: segsOut.map((x) => ({ text: x.text, speaker: x.speaker })),
    });
    r.stats.mode = "file";
    S.job.stats = r.stats;
    renderSummary(r.stats);
  } else {
    S.web.segs = segsOut;
    webWriteOutputs();
    renderSummary(S.job.stats);
  }
  doc.dirty = false;
  renderSpeakerBar();
  if (auto) toast(isMac ? "Speakers marked in the files." : "Speakers marked; download the files again.");
}

// ---- playback

function seekPlay(t) {
  if (reading()) {
    const i = S.doc ? Math.max(0, S.doc.segs.findIndex((x) => x.e > t)) : 0;
    speakFrom(i);
    return;
  }
  const a = $("audio");
  a.currentTime = Math.max(0, t);
  a.play().catch(() => {});
}

// ---- read aloud: the transcript spoken by the browser's own voices, chosen as male or female

const TTS = { on: false, i: 0 };
const reading = () => $("psource").value === "speech";
const FEMALE_VOICES = /female|samantha|karen|moira|tessa|fiona|victoria|allison|ava\b|susan|serena|kate|zoe|zira|martha|catherine|nicky|ellen|amelie|anna|alice|paulina|monica|sara|kyoko|melina|milena|nora|laura|veena|ioana|zuzana|luciana|joana|satu|yelda|kanya|flo|sandy|shelley|grandma|stephanie|hazel|susan|libby|sonia|jenny|aria|emma|olivia|natasha/i;
const MALE_VOICES = /\bmale|daniel|alex\b|fred|tom\b|oliver|arthur|aaron|gordon|lee\b|rishi|david|mark\b|evan|nathan|thomas|jorge|diego|juan|luca|xander|yuri|maged|tarik|eddy|reed|rocko|grandpa|ralph|albert|bruce|junior|carlos|felipe|ryan|guy|george|brian|eric|andrew|christopher|william|liam/i;
const NOVELTY_VOICES = /bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred\b|junior|ralph|kathy|grandma|grandpa|eddy|flo\b|reed|rocko|sandy|shelley/i;
S.voices = {};                // speaker number -> "female" | "male"

function voiceGender(v) {
  if (FEMALE_VOICES.test(v.name)) return "female";
  if (MALE_VOICES.test(v.name)) return "male";
  return null;
}

function pickVoice(gender) {
  const lang = ($("language").value === "auto" ? "en" : $("language").value).toLowerCase();
  const all = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
  const pool = (all.length ? all : speechSynthesis.getVoices()).filter((v) => !NOVELTY_VOICES.test(v.name))
    .sort((x, y) => (/premium|enhanced|natural/i.test(y.name) ? 1 : 0) - (/premium|enhanced|natural/i.test(x.name) ? 1 : 0));
  return pool.find((v) => voiceGender(v) === gender) || pool[0] || null;
}

// Speaker 1 takes the chosen reading voice, Speaker 2 the other, and so on, unless set by hand.
function voiceFor(n) {
  if (n && S.voices[n]) return S.voices[n];
  const base = $("pvoice").value, other = base === "female" ? "male" : "female";
  return !n || n % 2 === 1 ? base : other;
}

function speakFrom(i) {
  if (!S.doc || !("speechSynthesis" in window)) { toast("This browser can't read aloud."); return; }
  $("audio").pause();
  speechSynthesis.cancel();
  TTS.on = true;
  TTS.i = Math.max(0, Math.min(i, S.doc.segs.length - 1));
  speakNext();
}

function speakNext() {
  if (!TTS.on || !S.doc || TTS.i >= S.doc.segs.length) { TTS.on = false; updatePlayer(true); return; }
  const x = S.doc.segs[TTS.i];
  const u = new SpeechSynthesisUtterance(F.applyReplacements(x.t, F.parseReplacements($("replacements").value)));
  u.voice = pickVoice(voiceFor(x.spk));
  if (u.voice) u.lang = u.voice.lang;
  u.rate = +$("prate").value;
  u.volume = +$("pvol").value;
  u.onstart = () => updatePlayer(true);
  u.onend = () => { if (TTS.on) { TTS.i++; speakNext(); } };
  u.onerror = () => { TTS.on = false; updatePlayer(true); };
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  TTS.on = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function togglePlay() {
  if (reading()) {
    if (TTS.on) { stopSpeaking(); updatePlayer(true); } else speakFrom(TTS.i || Math.max(0, nowLine));
    return;
  }
  const a = $("audio");
  if (a.paused) a.play().catch(() => {}); else a.pause();
}

let nowLine = -1;
function updatePlayer(force) {
  const a = $("audio"), doc = S.doc;
  if (!doc) return;
  const speech = reading();
  const D = doc.duration || a.duration || 0;
  const t = speech ? (doc.segs[TTS.i] ? doc.segs[TTS.i].s : 0) : a.currentTime || 0;
  const playing = speech ? TTS.on : !a.paused;
  $("playbtn").textContent = playing ? "❚❚" : "▶";
  $("playbtn").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("ptime").textContent = speech ? `Line ${TTS.i + 1} of ${doc.segs.length}` : `${clock(t, D)} / ${clock(D, D)}`;
  drawScrub(t, D);
  // highlight the line being played or read
  let lo = 0, hi = doc.segs.length - 1, at = -1;
  if (speech) at = TTS.on || TTS.i ? TTS.i : -1;
  else while (lo <= hi) { const mid = (lo + hi) >> 1; if (doc.segs[mid].s <= t + 0.05) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  if (at !== nowLine || force) {
    const host = $("doclines");
    host.querySelector(".dl.now")?.classList.remove("now");
    const el = host.querySelector(`.dl[data-i="${at}"]`);
    if (el) {
      el.classList.add("now");
      if (playing && !host.contains(document.activeElement)) {
        const top = el.offsetTop - host.offsetTop;
        if (top < host.scrollTop || top > host.scrollTop + host.clientHeight - 60) host.scrollTo({ top: top - 40, behavior: "smooth" });
      }
    }
    nowLine = at;
  }
}

function drawScrub(t, D) {
  const s = sizeCanvas($("scrub"));
  if (!s || !S.doc) return;
  const { g, W, H } = s, peaks = S.doc.peaks || [];
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), muted = css.getPropertyValue("--border").trim();
  const step = W / Math.max(1, peaks.length);
  peaks.forEach((p, i) => {
    const h = Math.max(1, p * (H - 6));
    g.fillStyle = (i / peaks.length) * D <= t ? accent : muted;
    g.fillRect(i * step, (H - h) / 2, Math.max(1, step - 0.5), h);
  });
  if (D) {
    g.fillStyle = css.getPropertyValue("--text").trim();
    g.fillRect((t / D) * W - 1, 0, 2, H);
  }
}

/* ================================================================ LIVE mode */

S.live = { state: "idle", tags: [], segs: [], outputs: null, text: {}, levels: [] };

function nowStamp() {
  const d = new Date();
  return { d, title: `Live transcript, ${d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} ${d.toTimeString().slice(0, 5)}`,
           name: `live-transcript-${d.toISOString().slice(0, 10)}-${d.toTimeString().slice(0, 5).replace(":", "")}` };
}

function liveDefaults() {
  if (S.live.state === "idle" || S.live.state === "saved") {
    const st = nowStamp();
    $("title").value = st.title;
    $("outname").value = st.name;
  }
  if (isMac && !$("outdir").value) $("outdir").value = store.get("lastoutdir") || S.downloads || "";
  renderTagbar();
  renderLiveTiles();
}

function tagList() {
  return $("tags").value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 9).map((l) =>
    l.startsWith("*") ? { label: l.replace(/^\*\s*/, ""), kind: "marker" } : { label: l, kind: "heading" });
}

function saveTagList(list) {
  $("tags").value = list.map((t) => (t.kind === "marker" ? "* " : "") + t.label).join("\n");
  store.set("tags", $("tags").value);
  renderTagbar();
}

// Tags already placed this session follow a renamed or retyped tag button.
function retag(old, now) {
  let changed = false;
  for (const t of S.live.tags) {
    if (t.label === old.label && t.kind === old.kind) { Object.assign(t, { label: now.label, kind: now.kind }); changed = true; }
  }
  if (changed) {
    S.live.tags.forEach((t) => { t.id = Math.random().toString(36).slice(2); });   // re-render the tag rows
    renderLiveTranscript();
    saveDraft();
  }
}

function renameTag(i) {
  const list = tagList(), b = $("tagbar").querySelector(`button[data-i="${i}"]`);
  if (!b || !list[i]) return;
  const old = { ...list[i] };
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = old.label;
  inp.className = "tagedit";
  inp.setAttribute("aria-label", `Rename tag ${i + 1}`);
  b.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const label = inp.value.trim();
    if (keep && label && label !== old.label) {
      list[i] = { ...old, label };
      saveTagList(list);
      retag(old, list[i]);
    } else renderTagbar();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => finish(true));
}

function addTagButton() {
  const list = tagList();
  if (list.length >= 9) { toast("Up to nine tags have keys; edit the Tags list in Settings for more."); return; }
  list.push({ label: `Tag ${list.length + 1}`, kind: "heading" });
  saveTagList(list);
  renameTag(list.length - 1);
}

function contextMenu(e, entries) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  document.querySelector(".menu.ctx")?.remove();
  const m = document.createElement("div");
  m.className = "menu ctx";
  m.setAttribute("role", "menu");
  for (const it of entries) {
    if (it === "-") { m.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.setAttribute("role", it.checked != null ? "menuitemradio" : "menuitem");
    if (it.checked != null) b.setAttribute("aria-checked", it.checked ? "true" : "false");
    b.innerHTML = `<span>${esc(it.label)}</span>`;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); m.remove(); it.run(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  m.querySelector("button")?.focus();
  m.addEventListener("keydown", (ev) => {
    const items = [...m.querySelectorAll("button")], k = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") { ev.preventDefault(); items[(k + 1) % items.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(k - 1 + items.length) % items.length].focus(); }
    else if (ev.key === "Escape") m.remove();
  });
}

function renderTagbar() {
  const bar = $("tagbar");
  bar.innerHTML = tagList().map((t, i) =>
    `<button class="${t.kind}" data-i="${i}" aria-label="${esc(t.label)}, key ${i + 1}" title="${t.kind === "marker" ? "Inline marker" : "Heading"}: click to mark the moment while recording, or to rename it otherwise; right-click for more"><kbd>${i + 1}</kbd>${esc(t.label)}</button>`).join("") +
    `<button class="addtag" title="Add a tag" aria-label="Add a tag">+</button>` +
    `<input type="text" id="tagtext" placeholder="Type a tag and press Return to mark this moment (start with * for a marker)">`;
  bar.querySelectorAll("button[data-i]").forEach((b) => {
    const i = +b.dataset.i;
    b.addEventListener("click", () => {
      if (["recording", "paused"].includes(S.live.state)) addTag(tagList()[i]);
      else renameTag(i);
    });
    b.addEventListener("dblclick", (e) => { if (!["recording", "paused"].includes(S.live.state)) e.preventDefault(); });
    b.addEventListener("contextmenu", (e) => {
      const list = tagList(), t = list[i];
      contextMenu(e, [
        { label: "Rename…", run: () => renameTag(i) },
        "-",
        { label: "Heading", checked: t.kind === "heading", run: () => { const old = { ...t }; list[i] = { ...t, kind: "heading" }; saveTagList(list); retag(old, list[i]); } },
        { label: "Inline marker", checked: t.kind === "marker", run: () => { const old = { ...t }; list[i] = { ...t, kind: "marker" }; saveTagList(list); retag(old, list[i]); } },
        "-",
        { label: "Mark this moment", run: () => addTag(t) },
        { label: "Remove tag button", run: () => { list.splice(i, 1); saveTagList(list); } },
        { label: "New tag", run: addTagButton },
      ]);
    });
  });
  bar.querySelector(".addtag").addEventListener("click", addTagButton);
  $("tagtext").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    const v = e.target.value.trim();
    addTag(v.startsWith("*") ? { label: v.replace(/^\*\s*/, ""), kind: "marker" } : { label: v, kind: "heading" });
    e.target.value = "";
  });
}

const liveTime = () => (S.live.total || 0) / 16000;

function addTag(tag) {
  if (!tag) return;
  if (!["recording", "paused"].includes(S.live.state)) { toast("Tags mark moments while recording."); return; }
  const t = { ...tag, t: liveTime(), id: Math.random().toString(36).slice(2) };
  S.live.tags.push(t);
  S.live.tags.sort((a, b) => a.t - b.t);
  renderLiveTranscript();
  saveDraft();
  toast(`Tagged “${t.label}” at ${hms(t.t)}`);
}

// ---- audio capture (16 kHz mono, Int16 storage)

const WORKLET = `class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0]; if (ch && ch[0]) this.port.postMessage(ch[0].slice(0)); return true; }
}
registerProcessor("tap", Tap);`;

function appendAudio(f32, rate) {
  const L = S.live;
  let data = f32;
  if (rate !== 16000) {                       // linear resample when the context didn't honour 16 kHz
    const ratio = rate / 16000, n = Math.floor((f32.length - L.resampleFrac) / ratio);
    data = new Float32Array(Math.max(0, n));
    let pos = L.resampleFrac;
    for (let i = 0; i < n; i++, pos += ratio) {
      const j = Math.floor(pos), fr = pos - j;
      data[i] = f32[j] * (1 - fr) + (f32[j + 1] ?? f32[j]) * fr;
    }
    L.resampleFrac = pos - f32.length;
  }
  if (L.total + data.length > L.buf.length) {
    const bigger = new Int16Array(Math.max(L.buf.length * 2, L.total + data.length));
    bigger.set(L.buf.subarray(0, L.total));
    L.buf = bigger;
  }
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    L.buf[L.total + i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    const a = Math.abs(v);
    if (a > L.levelPeak) L.levelPeak = a;
    L.levelCount++;
    if (L.levelCount >= 1600) { L.levels.push(L.levelPeak); L.levelPeak = 0; L.levelCount = 0; }
  }
  L.total += data.length;
  let sq = 0;
  for (let i = 0; i < f32.length; i++) sq += f32[i] * f32[i];
  L.meter = Math.max(Math.sqrt(sq / Math.max(1, f32.length)) * 4, (L.meter || 0) * 0.92);
}

function audioSlice(from, to) {
  const out = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i++) out[i] = S.live.buf[from + i] / 0x8000;
  return out;
}

function rms(f32, from = 0) {
  let sq = 0;
  for (let i = from; i < f32.length; i++) sq += f32[i] * f32[i];
  return Math.sqrt(sq / Math.max(1, f32.length - from));
}

async function liveStart() {
  const L = S.live;
  if (L.state === "recording") return livePause();
  if (L.state === "paused") return liveResume();
  if (L.state === "saving") return;
  try {
    L.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    toast("Microphone access was refused.");
    $("lstatus").textContent = "Microphone access was refused. Allow it in the browser's site settings and try again.";
    return;
  }
  if (S.doc || S.stats) clearResults();
  S.project = "live";
  Object.assign(L, { state: "recording", buf: new Int16Array(16000 * 600), total: 0, windowStart: 0, busy: false,
                     segs: [], interim: null, tags: [], levels: [], levelPeak: 0, levelCount: 0, resampleFrac: 0,
                     outputs: null, text: {}, started: new Date(), latency: null, model: model(), edits: 0, ready: false });
  S.stats = null;
  $("summary").classList.add("hidden");
  try {
    L.ctx = new AudioContext({ sampleRate: 16000 });
  } catch (e) {
    L.ctx = new AudioContext();
  }
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await L.ctx.audioWorklet.addModule(url);
  L.source = L.ctx.createMediaStreamSource(L.stream);
  L.node = new AudioWorkletNode(L.ctx, "tap");
  L.node.port.onmessage = (e) => { if (L.state === "recording") appendAudio(e.data, L.ctx.sampleRate); };
  L.source.connect(L.node);
  const st = nowStamp();
  if (!$("title").value || $("title").value.startsWith("Live transcript")) $("title").value = st.title;
  if (!$("outname").value || $("outname").value.startsWith("live-transcript")) $("outname").value = st.name;
  renderLiveTranscript();
  setRecUi();
  $("lstatus").innerHTML = isMac ? "Starting <b>whisper.cpp</b>…" : "Loading the model in the browser…";
  try {
    if (isMac) { await api("/api/live/start", { model: L.model }); L.ready = true; }
    else await liveWebPrepare();
    $("lstatus").innerHTML = isMac
      ? `Listening · <b>whisper.cpp ${esc(L.model === "turbo" ? "large-v3-turbo" : "base")}</b> on this Mac`
      : `Listening · <b>Whisper ${esc(L.model)}</b> in the browser (${S.web.device === "webgpu" ? "WebGPU" : "WebAssembly"})`;
  } catch (e) {
    $("lstatus").textContent = `The live engine didn't start: ${e.message}`;
  }
  L.timer = setInterval(liveTick, 500);
  requestAnimationFrame(liveFrame);
}

function livePause() {
  S.live.state = "paused";
  S.live.ctx.suspend();
  setRecUi();
}
function liveResume() {
  S.live.state = "recording";
  S.live.ctx.resume();
  setRecUi();
}

function setRecUi() {
  const L = S.live, b = $("rec");
  b.classList.toggle("on", L.state === "recording");
  b.classList.toggle("paused", L.state === "paused");
  $("reclabel").textContent = L.state === "recording" ? "Pause" : L.state === "paused" ? "Resume" : "Start recording";
  $("lstop").disabled = !["recording", "paused"].includes(L.state);
}

async function liveTick() {
  const L = S.live;
  $("ltimer").textContent = hms(liveTime());
  renderLiveTiles();
  if (L.state !== "recording" || L.busy || !L.ready) return;
  if (L.total - L.windowStart < 16000 * 1.5) return;
  await liveStep(false);
}

async function liveStep(final) {
  const L = S.live;
  const from = L.windowStart, to = L.total, len = (to - from) / 16000;
  if (len < 0.5) return;
  const audio = audioSlice(from, to);
  const tailFrom = Math.max(0, audio.length - 16000 * 0.8);
  const quiet = 0.006;
  // Whisper invents text ("Thank you.") for silence, so only send windows with real sound in them.
  let sound = 0;
  for (let i = 0; i < audio.length; i += 1600) if (rms(audio.subarray(i, i + 1600)) >= quiet) sound += 0.1;
  if (sound < 0.4) {
    if (final || len > 3) { L.windowStart = to - (final ? 0 : 16000 * 0.3); L.interim = null; renderLiveTranscript(); }
    return;
  }
  L.busy = true;
  const t0 = performance.now();
  let segs;
  try {
    segs = await liveEngine(audio);
  } catch (e) {
    $("lstatus").textContent = `Transcription error: ${e.message}`;
    L.busy = false;
    return;
  }
  L.latency = (performance.now() - t0) / 1000;
  L.lastChunk = len;
  segs = segs.filter((s) => s.t && !/^\s*[[(].*[\])]\s*$/.test(s.t));
  const tailSilent = rms(audio, tailFrom) < quiet;
  const offset = from / 16000;
  let commit = 0, next = from;
  // Commit at a pause once Whisper has had at least 5 s of context; nothing is carried over,
  // since the tail is silent.
  if (final || (tailSilent && len >= 5)) { commit = segs.length; next = to; }
  else if (len >= 20 && segs.length > 1) { commit = segs.length - 1; next = from + Math.round(segs[segs.length - 1].s * 16000); }
  else if (len >= 28) { commit = segs.length; next = to; }
  for (const s of segs.slice(0, commit)) commitLine(offset + s.s, offset + s.e, s.t.trim(), s.words || null);
  L.windowStart = Math.max(L.windowStart, Math.min(next, to));
  L.interim = segs.slice(commit).map((s) => s.t).join(" ").trim() || null;
  L.interimAt = segs[commit] ? offset + segs[commit].s : null;
  L.busy = false;
  renderLiveTranscript(commit > 0);
  if (commit) saveDraft();
}

// Join whisper's short fragments into sentence-length lines, never touching a line being edited.
function commitLine(start, end, text, words) {
  const L = S.live, last = L.segs[L.segs.length - 1];
  const norm = (t) => t.toLowerCase().replace(/[^a-z' ]/g, "").trim();
  if (last && text.split(/\s+/).length <= 4 && norm(last.t).endsWith(norm(text)) && start - last.e < 8) return;  // repeated short phrase
  const lastIdx = L.segs.length - 1;
  const busy = last && document.activeElement && document.activeElement.closest(`[data-key="s${lastIdx}"]`);
  const open = last && !last.edited && !busy && !/[.?!]["'”’)\]]*$/.test(last.t) && last.t.length + text.length < 260 && start - last.e < 2;
  if (last && /^[.,;:?!]/.test(text) && !last.edited && !busy) {      // stray punctuation belongs to the line before
    const m = text.match(/^[.,;:?!]+/)[0];
    last.t += m;
    text = text.slice(m.length).trim();
    last.rev = (last.rev || 0) + 1;
    if (!text) return;
  }
  if (open) {
    last.t = `${last.t} ${text}`.replace(/\s+/g, " ");
    last.e = end;
    if (last.words || words) last.words = (last.words || []).concat(words || []);
    last.rev = (last.rev || 0) + 1;
  } else {
    const line = { s: start, e: end, t: text, words, edited: false, rev: 0, spk: null };
    L.segs.push(line);
    liveSpeaker(line);
  }
}

async function liveEngine(audio) {
  if (isMac) {
    const int16 = new Int16Array(audio.length);
    for (let i = 0; i < audio.length; i++) { const v = Math.max(-1, Math.min(1, audio[i])); int16[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    const q = new URLSearchParams({ language: $("language").value, prompt: livePrompt() });
    const r = await fetch(`/api/live/chunk?${q}`, { method: "POST", headers: { "X-Transcriber": "1", "Content-Type": "audio/wav" }, body: wavBlob(int16) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j.segments;
  }
  const r = await workerCall({ type: "live", audio, model: S.live.model, language: $("language").value, device: S.web.device }, null, [audio.buffer]);
  return r.chunks;
}

// Recent committed text plus the user's names and terms steer spelling in the next chunk.
function livePrompt() {
  const recent = S.live.segs.slice(-3).map((s) => s.t).join(" ").slice(-200);
  return [$("prompt").value.trim(), recent].filter(Boolean).join(". ");
}

async function liveWebPrepare() {
  S.web.device = S.web.device || await detectDevice();
  renderEngine();
  await workerCall({ type: "load", model: S.live.model, device: S.web.device }, (m) => {
    if (m.total) $("lstatus").textContent = `Downloading the model: ${Math.round((m.loaded || 0) / 1e6)} of ${Math.round(m.total / 1e6)} MB (${m.file.split("/").pop()})…`;
  });
  S.live.ready = true;
}

function renderLiveTranscript(appended) {
  const L = S.live, host = $("ledit");
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  // Rebuild only what isn't being edited: committed lines keep their DOM so the caret stays put.
  host.querySelector(".empty")?.remove();
  // each tag sits before the line whose start is nearest its time (as headings do in the Markdown)
  const before = new Map(), trailing = [];
  for (const tag of L.tags) {
    let best = -1;
    L.segs.forEach((s, i) => { if (best < 0 || Math.abs(s.s - tag.t) < Math.abs(L.segs[best].s - tag.t)) best = i; });
    if (best < 0 || tag.t > L.segs[best].e + 1) trailing.push(tag);
    else { if (!before.has(best)) before.set(best, []); before.get(best).push(tag); }
  }
  const want = [];
  L.segs.forEach((s, i) => {
    for (const tag of before.get(i) || []) want.push({ tag });
    want.push({ seg: i });
  });
  for (const tag of trailing) want.push({ tag });
  const existing = new Map([...host.children].map((el) => [el.dataset.key, el]));
  const keep = new Set();
  let prev = null;
  for (const item of want) {
    const key = item.tag ? `t${item.tag.id}` : `s${item.seg}`;
    keep.add(key);
    let el = existing.get(key);
    if (el && item.seg != null && +el.dataset.rev !== (L.segs[item.seg].rev || 0) && !el.contains(document.activeElement)) {
      el.remove();
      el = null;
    }
    if (!el) {
      el = item.tag ? tagEl(item.tag) : segEl(item.seg);
      el.dataset.key = key;
      if (item.seg != null) el.dataset.rev = L.segs[item.seg].rev || 0;
    }
    if (prev ? prev.nextSibling !== el : host.firstChild !== el) host.insertBefore(el, prev ? prev.nextSibling : host.firstChild);
    prev = el;
  }
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();
  let interim = host.querySelector(".interim");
  if (L.interim) {
    if (!interim) { interim = document.createElement("p"); interim.className = "lseg interim"; interim.dataset.key = "interim"; }
    interim.innerHTML = `<time>${hms(L.interimAt ?? liveTime())}</time><span class="caret">${esc(L.interim)}</span>`;
    host.appendChild(interim);
  } else interim?.remove();
  if (!L.segs.length && !L.interim && !L.tags.length) host.innerHTML = `<p class="empty">${L.state === "idle" ? "The transcript appears here as you speak. Click any line to correct it while recording continues; underlined words are ones the model was unsure of." : "Listening…"}</p>`;
  if (appended && atBottom && !host.contains(document.activeElement)) host.scrollTop = host.scrollHeight;
}

function segEl(i) {
  const s = S.live.segs[i], p = document.createElement("p");
  p.className = "lseg";
  const words = s.words && s.words.length
    ? s.words.map((w) => w.p < 0.5 && /[A-Za-z]{3,}/.test(w.w) ? `<u title="${Math.round(w.p * 100)}% confident">${esc(w.w)}</u>` : esc(w.w)).join("")
    : esc(s.t);
  p.innerHTML = `<time>${hms(s.s)}</time>${chipHtml(s.spk)}<span contenteditable="plaintext-only" spellcheck="true">${words.trim()}</span>`;
  const menu = (e) => speakerMenu(e, s, S.live.segs,
    () => { s.rev = (s.rev || 0) + 1; renderLiveTranscript(); },
    () => { S.live.segs.forEach((l) => { l.rev = (l.rev || 0) + 1; }); renderLiveTranscript(); });
  p.querySelector(".spk")?.addEventListener("click", menu);
  p.addEventListener("contextmenu", (e) => { if (!e.target.closest("[contenteditable]")) menu(e); });
  const span = p.querySelector("span");
  span.addEventListener("input", () => {
    s.t = span.textContent.replace(/\s+/g, " ").trim();
    if (!s.edited) { s.edited = true; S.live.edits++; p.classList.add("edited"); }
    saveDraft();
  });
  span.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } });
  return p;
}

function tagEl(t) {
  const d = document.createElement("div");
  d.className = `ltag ${t.kind}`;
  d.innerHTML = `<span class="t">${t.kind === "marker" ? "★ " : ""}${esc(t.label)}</span><time>${hms(t.t)}</time><button title="Remove tag" aria-label="Remove tag">×</button>`;
  d.querySelector("button").addEventListener("click", () => {
    S.live.tags = S.live.tags.filter((x) => x.id !== t.id);
    renderLiveTranscript();
    saveDraft();
  });
  return d;
}

function renderLiveTiles() {
  const L = S.live, secs = liveTime();
  const words = L.segs.reduce((n, s) => n + F.wordCount(s.t), 0);
  $("ltiles").innerHTML = [
    ["Words", fmt(words)],
    ["Pace", secs > 20 ? `${fmt(words / (secs / 60))}<small> wpm</small>` : "–"],
    ["Lines", fmt(L.segs.length)],
    ["Corrected", fmt(L.edits || 0)],
    ["Tags", fmt(L.tags.length)],
    ["Lag", L.latency != null ? `${L.latency.toFixed(1)}<small> s per ${Math.round(L.lastChunk || 0)} s</small>` : "–"],
  ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
}

function liveFrame() {
  const L = S.live;
  // level meter
  const m = sizeCanvas($("meter"));
  if (m) {
    const lv = Math.min(1, (L.state === "recording" ? L.meter || 0 : 0));
    const grad = m.g.createLinearGradient(0, 0, m.W, 0);
    grad.addColorStop(0, "#2fd3bd"); grad.addColorStop(0.7, "#4f9bff"); grad.addColorStop(1, "#ff4d5e");
    m.g.fillStyle = grad;
    const segs = 40, sw = m.W / segs;
    for (let i = 0; i < segs * lv; i++) m.g.fillRect(i * sw + 1, 4, sw - 2, m.H - 8);
    if (L.state === "recording") L.meter *= 0.9;
  }
  // scope: last 60 s of 100 ms levels
  const s = sizeCanvas($("scope"));
  if (s) {
    const { g, W, H } = s, n = 600, levels = L.levels || [];
    const start = Math.max(0, levels.length - n), bw = W / n;
    const committed = (L.windowStart || 0) / 1600;
    const top = Math.max(0.05, ...levels.slice(start));
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#4f9bff"); grad.addColorStop(1, "#2fd3bd");
    for (let i = start; i < levels.length; i++) {
      const h = Math.max(1.5, Math.sqrt(levels[i] / top) * (H - 16));
      g.fillStyle = i < committed ? grad : "#7c8bb5";
      g.fillRect((i - start) * bw, (H - h) / 2, Math.max(1, bw - 0.4), h);
    }
    g.font = "11px -apple-system, sans-serif";
    for (const t of L.tags) {
      const i = t.t * 10 - start;
      if (i < 0) continue;
      g.fillStyle = "#fab219";
      g.fillRect(i * bw, 0, 2, H);
      g.fillText(t.label, Math.min(i * bw + 5, W - 80), 12);
    }
  }
  if (["recording", "paused"].includes(L.state)) requestAnimationFrame(liveFrame);
}

async function liveStop() {
  const L = S.live;
  if (!["recording", "paused"].includes(L.state)) return;
  L.state = "saving";
  setRecUi();
  clearInterval(L.timer);
  $("lstatus").textContent = "Finishing the last few seconds…";
  while (L.busy) await new Promise((r) => setTimeout(r, 100));
  if (L.ready || isMac) {
    try { await liveStep(true); } catch (e) { /* keep what we have */ }
  }
  L.stream.getTracks().forEach((t) => t.stop());
  L.ctx.close();
  try {
    await liveSave(false);
    store.del("livedraft");
    openDoc("live");
    L.state = "saved";
    $("lstatus").innerHTML = isMac ? "Saved. The files are listed in the summary below." : "Done. Download the files from the summary below.";
  } catch (e) {
    L.state = "saved";
    $("lstatus").textContent = `Saving failed: ${e.message}. The transcript is kept in this page; try Edit › Apply Corrections to save again.`;
  }
  if (isMac) api("/api/live/stop").catch(() => {});
  setRecUi();
}

function liveBuild() {
  const L = S.live, pairs = F.parseReplacements($("replacements").value);
  const segs = L.segs.map((s) => ({ start: Math.round(s.s * 1000), end: Math.round(s.e * 1000), text: s.t, speaker: spkName(s.spk) })).filter((s) => s.text);
  // markers go inline at the start of the first segment after them
  for (const t of L.tags.filter((t) => t.kind === "marker")) {
    const seg = segs.find((s) => s.start >= t.t * 1000 - 500) || segs[segs.length - 1];
    if (seg) seg.text = `**★ ${t.label}** ${seg.text}`;
  }
  const sections = L.tags.filter((t) => t.kind === "heading").map((t) => [t.t, t.label]);
  const duration = liveTime();
  const edited = L.segs.filter((s) => s.edited).length;
  const modelLabel = isMac ? `whisper.cpp, ${L.model === "turbo" ? "large-v3-turbo" : "base"}` : `Whisper ${L.model} in the browser`;
  const started = L.started.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  const notes = [];
  if ($("prompt").value.trim() && isMac) notes.push("Names and terms supplied to the model as a prompt.");
  if (edited) notes.push(`${edited} line${edited === 1 ? "" : "s"} corrected by hand during recording.`);
  if (pairs.length) notes.push(`${pairs.length} find/replace correction${pairs.length === 1 ? "" : "s"} applied.`);
  const nSpk = new Set(segs.map((x) => x.speaker).filter(Boolean)).size;
  if (nSpk) notes.push(`Speakers identified automatically by voice (${nSpk}); check the attributions.`);
  notes.push("Timestamps mark paragraph starts.");
  const audioNote = $("keepaudio").checked ? ` Audio saved as \`${$("outname").value.trim() || "live-transcript"}.wav\`.` : "";
  const header = `# ${$("title").value.trim() || "Live transcript"}\n\nSource: live recording started ${started} (${hms(duration)}).${audioNote}\n\n` +
    `Machine transcript (${modelLabel}, language: ${$("language").value}), transcribed as it was spoken. ${notes.join(" ")}\n`;
  const summary = F.summariseLevels(L.levels);
  const { markdown, paragraphs } = F.buildMarkdown(segs, sections, pairs, header, summary.pauses);
  const raw = segs.map((s) => s.text).join(" ").replace(/\s+/g, " ");
  L.summaryPeaks = summary.peaks;
  const stats = F.computeStats(segs, duration, pairs, raw, {}, paragraphs, sections.length, summary);
  Object.assign(stats, { mode: "live", model: modelLabel, language: $("language").value, edited, tags: L.tags.length });
  const words = L.segs.flatMap((s) => (s.words || []).map((w) => ({ ...w, t: s.s })));
  if (words.length) {
    const seen = new Set(), low = [];
    for (const w of [...words].sort((a, b) => a.p - b.p)) {
      const clean = w.w.trim().replace(/^[^\w]+|[^\w]+$/g, "");
      if (w.p >= 0.4 || low.length >= 30) break;
      if (clean.length < 3 || seen.has(clean.toLowerCase()) || F.STOPWORDS.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      low.push({ w: clean, p: w.p, t: w.t });
    }
    const segConf = L.segs.filter((s) => s.words && s.words.length).map((s) => ({ s: s.s, e: s.e, p: s.words.reduce((a, w) => a + w.p, 0) / s.words.length }));
    stats.confidence = { low_words: low, segments: segConf, mean: segConf.length ? segConf.reduce((a, c) => a + c.p, 0) / segConf.length : null };
  }
  return { md: markdown, srt: F.buildSrt(segs, pairs), txt: F.buildTxt(segs, pairs), stats };
}

async function liveSave(rewriteOnly) {
  const L = S.live, built = liveBuild();
  L.text = { md: built.md, srt: built.srt, txt: built.txt };
  L.outname = $("outname").value.trim() || "live-transcript";
  const keepAudio = $("keepaudio").checked && L.total > 0;
  if (isMac) {
    const outdir = $("outdir").value.trim() || S.downloads;
    if (outdir) store.set("lastoutdir", outdir);
    const r = await api("/api/live/save", { outdir, outname: L.outname, base: rewriteOnly ? L.base : null, ...L.text });
    L.base = r.base;
    L.outputs = r.outputs;
    if (keepAudio && !rewriteOnly) {
      const a = await fetch(`/api/live/audio?base=${encodeURIComponent(r.base)}`, { method: "PUT", headers: { "X-Transcriber": "1" }, body: wavBlob(L.buf.subarray(0, L.total)) });
      if (a.ok) L.outputs = [...L.outputs, r.base + ".wav"];
    }
  } else {
    L.outputs = { ...L.text, wav: keepAudio ? wavBlob(L.buf.subarray(0, L.total)) : null };
  }
  renderSummary(built.stats);
  $("summary").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- draft safety net: committed text and tags survive a closed tab

function saveDraft() {
  const L = S.live;
  clearTimeout(L.draftTimer);
  L.draftTimer = setTimeout(() => store.set("livedraft", JSON.stringify({
    title: $("title").value, started: L.started, duration: liveTime(),
    segs: L.segs.map(({ s, e, t, edited }) => ({ s, e, t, edited })), tags: L.tags,
  })), 400);
}

function offerDraft() {
  const raw = store.get("livedraft");
  if (!raw) return;
  let d;
  try { d = JSON.parse(raw); } catch (e) { store.del("livedraft"); return; }
  if (!d.segs || !d.segs.length) return;
  const host = $("ledit");
  host.innerHTML = `<div class="banner err" style="background:rgba(250,178,25,.12)"><div><b>An unsaved live transcript was found</b> (${esc(d.title)}, ${hms(d.duration)}, ${d.segs.length} lines). The audio is not kept, only the text and tags.
    <div style="margin-top:8px;display:flex;gap:8px"><button id="draftdl">Download it as Markdown</button><button id="draftdrop">Discard</button></div></div></div>`;
  $("draftdl").onclick = () => {
    const segs = d.segs.map((s) => ({ start: s.s * 1000, end: s.e * 1000, text: s.t }));
    const sections = (d.tags || []).filter((t) => t.kind === "heading").map((t) => [t.t, t.label]);
    const { markdown } = F.buildMarkdown(segs, sections, [], `# ${d.title}\n\nSource: recovered live transcript (${hms(d.duration)}).\n`);
    download("recovered-live-transcript.md", markdown, "text/markdown");
  };
  $("draftdrop").onclick = () => { store.del("livedraft"); host.innerHTML = '<p class="empty">Draft discarded.</p>'; };
}

/* ================================================================ menus, dialogs, shortcuts */

// Close the open results (a file's run, summary, transcript panel and audio) without touching settings.
function clearResults() {
  stopSpeaking();
  $("audio").pause();
  $("audio").removeAttribute("src");
  Object.assign(S, { job: null, segments: [], wave: null, pauses: [], speed: [], stats: null, doc: null, names: {}, fresh: [] });
  S.web.outputs = null;
  $("studio").classList.add("hidden");
  $("summary").classList.add("hidden");
  $("live").innerHTML = "";
  $("doclines").innerHTML = "";
}

async function newProject(quiet) {
  const L = S.live;
  if (["recording", "paused"].includes(L.state)) { toast("Stop the live recording first."); return; }
  if (running()) { toast("Cancel the transcription first."); return; }
  if (!quiet && S.doc && S.doc.dirty && !confirm("Discard the unsaved corrections?")) return;
  S.project = null;
  if (isMac) api("/api/reset").catch(() => {});
  $("audio").pause();
  $("audio").removeAttribute("src");
  clearTimeout(S.polling);
  Object.assign(S, { file: null, job: null, segments: [], wave: null, pauses: [], duration: 0, speed: [], stats: null,
                     doc: null, names: {}, autoTerms: "", fresh: [] });
  S.web.outputs = null; S.web.segs = null; S.web.samples = null;
  Object.assign(L, { state: "idle", tags: [], segs: [], outputs: null, text: {}, levels: [], interim: null, cents: [], total: 0 });
  ["title", "outname", "prompt", "sections", "pastepath"].forEach((id) => { $(id).value = ""; });
  if (isMac) $("outdir").value = "";
  $("drop").classList.remove("hidden");
  $("fileinfo").classList.add("hidden");
  $("uploadnote").classList.add("hidden");
  $("go").disabled = true;
  $("gohint").textContent = "Choose a recording first.";
  $("studio").classList.add("hidden");
  $("summary").classList.add("hidden");
  $("live").innerHTML = "";
  $("doclines").innerHTML = "";
  $("ltimer").textContent = "0:00:00";
  $("lstatus").innerHTML = "Press Start recording (or <b>⌘R</b>) and allow microphone access.";
  setRecUi();
  renderLiveTranscript();
  if (S.mode === "live") liveDefaults();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (isMac) setTimeout(() => poll(true), 300);
  if (!quiet) toast("New project.");
}

const K = (key) => key;  // shortcut labels as shown
const MENUS = [
  { label: "File", items: [
    { label: "New Project", key: K("⌥⌘N"), run: newProject },
    "-",
    { label: "Open Recording…", key: K("⌘O"), run: () => { if (setMode("file")) chooseFile(); } },
    { label: "Open Path…", key: K("⇧⌘O"), mac: true, run: () => { if (setMode("file")) $("pastepath").focus(); } },
    { label: "Choose Output Folder…", mac: true, run: pickDir },
    "-",
    { label: "Transcribe", key: K("⌘↩"), run: start, enabled: () => S.mode === "file" && !!S.file && !running() },
    { label: "Cancel Transcription", key: K("⌘."), run: cancel, enabled: running },
    "-",
    { label: "Start or Pause Live Recording", key: K("⌘R"), run: () => { if (setMode("live")) liveStart(); } },
    { label: "Stop and Save Live Recording", key: K("⌘S"), run: liveStop, enabled: () => ["recording", "paused"].includes(S.live.state) },
    "-",
    { label: "Open Transcript", mac: true, run: () => openOutput(false), enabled: () => outputsReady() },
    { label: "Show Transcript in Finder", mac: true, run: () => openOutput(true), enabled: () => outputsReady() },
    { label: "Download Markdown", web: true, run: () => dl("md"), enabled: () => outputsReady() },
    { label: "Download Subtitles (.srt)", web: true, run: () => dl("srt"), enabled: () => outputsReady() },
    { label: "Download Plain Text", web: true, run: () => dl("txt"), enabled: () => outputsReady() },
    "-",
    { label: "Stop Transcriber", mac: true, run: quit },
  ] },
  { label: "Edit", items: [
    { label: "Copy Transcript as Markdown", key: K("⇧⌘C"), run: () => copyTranscript("md"), enabled: () => outputsReady() },
    { label: "Copy Transcript as Plain Text", run: () => copyTranscript("txt"), enabled: () => outputsReady() },
    "-",
    { label: "Apply Corrections to Transcript", run: rewrite, enabled: () => outputsReady() },
    { label: "Add Tag at Current Moment…", run: () => $("tagtext")?.focus(), enabled: () => ["recording", "paused"].includes(S.live.state) },
    "-",
    { label: "Clear Names and Terms", run: () => { $("prompt").value = ""; S.autoTerms = ""; } },
    { label: "Clear Find and Replace", run: () => { $("replacements").value = ""; store.set("replacements", ""); } },
    { label: "Clear Section Headings", run: () => { $("sections").value = ""; } },
    { label: "Reset All Settings", run: resetSettings },
  ] },
  { label: "View", items: [
    { label: "File Mode", key: K("⌘1"), check: () => S.mode === "file", run: () => setMode("file") },
    { label: "Live Mode", key: K("⌘2"), check: () => S.mode === "live", run: () => setMode("live") },
    "-",
    { label: "Match System Appearance", check: () => !document.documentElement.dataset.theme, run: () => applyTheme("system") },
    { label: "Light Appearance", check: () => document.documentElement.dataset.theme === "light", run: () => applyTheme("light") },
    { label: "Dark Appearance", check: () => document.documentElement.dataset.theme === "dark", run: () => applyTheme("dark") },
    "-",
    { label: "Technical Log", run: showLog, enabled: () => !!S.job },
    { label: "Use This Mac's Engine", web: true, run: () => { location.href = LOCAL_URL; }, enabled: () => !!S.localAbout },
    { label: "Open the Web Version", mac: true, run: () => window.open(PAGES_URL, "_blank", "noopener") },
  ] },
  { label: "Help", items: [
    { label: "How to Use Transcriber", key: K("⌘/"), run: () => $("dlg-help").showModal() },
    { label: "Keyboard Shortcuts", run: showKeys },
    "-",
    { label: "Source Code on GitHub", run: () => window.open(REPO, "_blank", "noopener") },
    { label: "Report a Problem", run: () => window.open(REPO + "/issues/new", "_blank", "noopener") },
    "-",
    { label: "About Transcriber", run: showAbout },
  ] },
];

const outputsReady = () => (S.mode === "live" ? !!S.live.outputs : done());
function openOutput(reveal) {
  const outs = S.mode === "live" ? S.live.outputs : S.job.outputs;
  if (outs && outs[0]) api("/api/open", { path: outs[0], reveal }).catch((e) => toast(e.message));
}
function dl(k) {
  const outs = S.mode === "live" ? S.live.outputs : S.web.outputs;
  const base = (S.mode === "live" ? S.live.outname : $("outname").value.trim()) || "transcript";
  if (outs) download(`${base}.${k}`, outs[k], "text/plain;charset=utf-8");
}

function buildMenus() {
  const bar = $("menubar");
  bar.innerHTML = "";
  MENUS.forEach((m, mi) => {
    const wrap = document.createElement("div");
    const top = document.createElement("button");
    top.className = "top";
    top.textContent = m.label;
    top.setAttribute("role", "menuitem");
    top.setAttribute("aria-haspopup", "true");
    top.setAttribute("aria-expanded", "false");
    wrap.appendChild(top);
    bar.appendChild(wrap);
    top.addEventListener("click", (e) => { e.stopPropagation(); openMenu === mi ? closeMenus() : showMenu(mi); });
    top.addEventListener("mouseenter", () => { if (openMenu != null && openMenu !== mi) showMenu(mi); });
    top.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); showMenu(mi, true); } });
  });
}

let openMenu = null;
function showMenu(mi, focusFirst) {
  closeMenus();
  openMenu = mi;
  const wrap = $("menubar").children[mi], top = wrap.firstChild;
  top.setAttribute("aria-expanded", "true");
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const it of MENUS[mi].items) {
    if (it === "-") { menu.appendChild(document.createElement("hr")); continue; }
    if ((it.mac && !isMac) || (it.web && isMac)) continue;
    const b = document.createElement("button");
    b.setAttribute("role", it.check ? "menuitemradio" : "menuitem");
    if (it.check) b.setAttribute("aria-checked", it.check() ? "true" : "false");
    b.innerHTML = `<span>${esc(it.label)}</span>${it.key ? `<kbd>${it.key}</kbd>` : ""}`;
    b.disabled = it.enabled ? !it.enabled() : false;
    b.addEventListener("click", (e) => { e.stopPropagation(); closeMenus(); it.run(); });
    menu.appendChild(b);
  }
  // drop separators left dangling by mode filtering
  [...menu.children].forEach((el, i, arr) => { if (el.tagName === "HR" && (i === 0 || arr[i - 1].tagName === "HR" || i === arr.length - 1)) el.remove(); });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button:not(:disabled)")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); showMenu((mi + 1) % MENUS.length, true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); showMenu((mi - 1 + MENUS.length) % MENUS.length, true); }
    else if (e.key === "Escape") { closeMenus(); top.focus(); }
  });
  wrap.appendChild(menu);
  const over = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
  if (over > 0) menu.style.left = `${-over}px`;                     // keep the menu inside the window
  if (focusFirst) menu.querySelector("button:not(:disabled)")?.focus();
}
function closeMenus() {
  openMenu = null;
  document.querySelectorAll("#menubar .menu").forEach((m) => m.remove());
  document.querySelectorAll("#menubar .top").forEach((t) => t.setAttribute("aria-expanded", "false"));
}

const SHORTCUTS = [
  ["⌥⌘N", "New project: clear the recording, settings for it and results"], ["Space", "Play or pause the recording (outside a text field)"], ["⌘O", "Open a recording"], ["⇧⌘O", "Paste a file path (Mac app)"], ["⌘↩", "Transcribe"], ["⌘.", "Cancel transcription"],
  ["⌘R", "Start, pause or resume live recording"], ["⌘S", "Stop and save the live recording"], ["1 – 9", "Tag the current moment (live, outside a text field)"],
  ["⇧⌘C", "Copy the transcript as Markdown"], ["⌘1 / ⌘2", "File mode / Live mode"], ["⌘/", "How to use Transcriber"], ["Esc", "Close a menu or dialog"],
];
function showKeys() {
  $("keys").innerHTML = SHORTCUTS.map(([k, d]) => `<tr><td style="width:110px"><kbd>${k}</kbd></td><td>${d}</td></tr>`).join("");
  $("dlg-keys").showModal();
}
function showLog() {
  $("logtext").textContent = (S.job && S.job.log && S.job.log.length ? S.job.log.join("\n") : "Nothing logged.");
  $("dlg-log").showModal();
}

async function showAbout() {
  $("about-ver").textContent = `Version ${S.version}`;
  const rows = [["Created by", `<a href="https://github.com/dmberry" target="_blank" rel="noopener">David M. Berry</a>`],
                ["Copyright", "© 2026 David M. Berry"],
                ["Source", `<a href="${REPO}" target="_blank" rel="noopener">github.com/critical-code-studies/transcriber</a>`]];
  if (isMac) {
    const a = S.about || await fetch("/api/about").then((r) => r.json()).catch(() => null);
    if (a) {
      const models = Object.entries(a.models).map(([k, ok]) => `${k === "turbo" ? "large-v3-turbo" : k} ${ok ? "✓" : "missing"}`).join(", ");
      rows.push(["Engine", `whisper.cpp ${esc(a.whisper || "?")} with Metal, on this Mac`],
                ["Tools", `FFmpeg ${esc(a.ffmpeg || "?")} · Python ${esc(a.python)}`],
                ["Models", `${esc(models)} <span class="muted">(${esc(a.model_dir)})</span>`],
                ["Installed in", `${esc(a.folder)} · port ${a.port}`]);
    }
  } else {
    const dev = S.web.device || await detectDevice();
    rows.push(["Engine", `transformers.js ${TJS_VERSION} in this browser, ${dev === "webgpu" ? "WebGPU" : "WebAssembly"}`],
              ["Models", "Whisper base, small and large-v3-turbo (ONNX, from Hugging Face), cached by the browser after the first download"],
              ["Privacy", "Recordings and transcripts stay in this browser and are not stored after the page closes. Only the models are downloaded."],
              ["Mac app", S.localAbout ? `running, whisper.cpp ${esc(S.localAbout.whisper || "")}` : "not detected"]);
  }
  $("about-dl").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("dlg-about").showModal();
}

function resetSettings() {
  if (!confirm("Clear the find/replace list, tags and remembered choices?")) return;
  ["replacements", "language", "autostart", "lastoutdir", "theme", "tags", `model.${ENGINE}.file`, `model.${ENGINE}.live`].forEach(store.del);
  location.reload();
}

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  const typing = e.target.closest && e.target.closest("input, textarea, [contenteditable]");
  if (e.key === "Escape" && openMenu != null) { closeMenus(); return; }
  if (mod && e.altKey && (e.code === "KeyN" || k === "n")) { e.preventDefault(); newProject(); return; }
  if (mod && !e.altKey) {
    const map = {
      o: () => { if (!setMode("file")) return; if (e.shiftKey && isMac) $("pastepath").focus(); else chooseFile(); },
      enter: () => S.mode === "file" && start(),
      ".": cancel,
      r: () => { if (setMode("live")) liveStart(); },
      s: () => S.mode === "live" && liveStop(),
      "/": () => $("dlg-help").showModal(),
      1: () => setMode("file"),
      2: () => setMode("live"),
    };
    if (k === "c" && e.shiftKey) { e.preventDefault(); copyTranscript("md"); return; }
    if (!e.shiftKey || k === "o") {
      const f = map[k];
      if (f) { e.preventDefault(); f(); }
    }
    return;
  }
  if (!typing && e.key === " " && S.doc && S.doc.mode === S.mode && !$("summary").classList.contains("hidden")) {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (!typing && S.mode === "live" && /^[1-9]$/.test(e.key) && ["recording", "paused"].includes(S.live.state)) {
    e.preventDefault();
    addTag(tagList()[+e.key - 1]);
  }
}

/* ================================================================ start-up */

async function init() {
  document.body.classList.add(isMac ? "engine-mac" : "engine-web");
  if (!isMac && !["127.0.0.1", "localhost"].includes(location.hostname)) {
    // remove anything an earlier version of the web page stored
    for (const k of PRIVATE_KEYS) { try { localStorage.removeItem("transcriber." + k); } catch (e) { /* private mode */ } }
  }
  applyTheme(store.get("theme") || "system");
  S.version = await fetch("VERSION").then((r) => (r.ok ? r.text() : "")).then((t) => t.trim()).catch(() => "");
  $("brandver").textContent = S.version ? `v${S.version}` : "";
  buildMenus();
  document.addEventListener("click", () => { closeMenus(); document.querySelector(".menu.ctx")?.remove(); });
  document.addEventListener("keydown", onKey);
  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  // file mode wiring
  $("drop").addEventListener("click", chooseFile);
  $("drop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseFile(); } });
  $("change").addEventListener("click", chooseFile);
  $("fileinput").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) setFile(webFileInfo(f)); e.target.value = ""; });
  $("usepath").addEventListener("click", usePath);
  $("pastepath").addEventListener("keydown", (e) => { if (e.key === "Enter") usePath(); });
  $("pickdir").addEventListener("click", pickDir);
  $("go").addEventListener("click", start);
  $("cancel").addEventListener("click", cancel);
  $("rewrite").addEventListener("click", rewrite);
  const audio = $("audio");
  ["timeupdate", "play", "pause", "loadedmetadata", "seeked"].forEach((ev) => audio.addEventListener(ev, () => updatePlayer()));
  $("playbtn").addEventListener("click", togglePlay);
  $("psource").value = store.get("psource") || "audio";
  $("pvoice").value = store.get("pvoice") || "female";
  try { S.voices = JSON.parse(store.get("voices") || "{}"); } catch (e) { S.voices = {}; }
  const sourceUi = () => { $("pvoice").classList.toggle("hidden", !reading()); renderSpeakerBar(); updatePlayer(true); };
  $("psource").addEventListener("change", () => {
    store.set("psource", $("psource").value);
    if (reading()) audio.pause(); else stopSpeaking();
    sourceUi();
  });
  $("pvoice").addEventListener("change", () => { store.set("pvoice", $("pvoice").value); renderSpeakerBar(); });
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};   // loads the voice list
  sourceUi();
  $("back5").addEventListener("click", () => { if (reading()) speakFrom(TTS.i - 1); else audio.currentTime = Math.max(0, audio.currentTime - 5); });
  $("fwd5").addEventListener("click", () => { if (reading()) speakFrom(TTS.i + 1); else audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 5); });
  $("prate").addEventListener("change", () => { audio.playbackRate = +$("prate").value; });
  const vol = store.get("volume");
  $("pvol").value = vol !== null ? vol : "0.5";               // playback starts at half volume
  audio.volume = +$("pvol").value;
  $("pvol").addEventListener("input", () => { audio.volume = +$("pvol").value; store.set("volume", $("pvol").value); });
  $("scrub").addEventListener("click", (e) => {
    const r = $("scrub").getBoundingClientRect();
    if (S.doc) seekPlay(((e.clientX - r.left) / r.width) * (S.doc.duration || audio.duration || 0));
  });
  $("speakers").value = store.get("speakers") || "auto";
  $("speakers").addEventListener("change", () => store.set("speakers", $("speakers").value));
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (S.mode === "file") $("drop").classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || !e.relatedTarget) $("drop").classList.remove("over"); }));
  document.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    if (S.mode !== "file" && !setMode("file")) return;
    droppedFile(f);
  });
  $("wave").addEventListener("mousemove", waveHover);
  $("wave").addEventListener("mouseleave", () => { hoverX = null; $("wavetip").classList.add("hidden"); drawWave(); });
  window.addEventListener("resize", () => { drawWave(); drawLanes(); if (S.stats) drawWpm(S.stats.per_minute, $("wpm"), S.stats.duration); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawWave(); drawLanes(); });
  (function animate() {
    if (!S.wave && running() && S.mode === "file") drawWave();
    requestAnimationFrame(animate);
  })();

  // live mode wiring
  $("tags").value = store.get("tags") ?? DEFAULT_TAGS;
  $("tags").addEventListener("input", () => { store.set("tags", $("tags").value); renderTagbar(); });
  $("rec").addEventListener("click", liveStart);
  $("lstop").addEventListener("click", liveStop);
  $("tab-file").addEventListener("click", () => setMode("file"));
  $("tab-live").addEventListener("click", () => setMode("live"));
  window.addEventListener("beforeunload", (e) => {
    const unsaved = !isMac && (S.web.outputs || S.live.outputs);    // web results exist only in this page
    if (["recording", "paused"].includes(S.live.state) || running() || unsaved) { e.preventDefault(); e.returnValue = ""; }
  });

  // remembered settings
  for (const id of ["replacements", "language"]) {
    const v = store.get(id);
    if (v !== null) $(id).value = v;
    $(id).addEventListener("change", () => store.set(id, $(id).value));
  }
  $("autostart").checked = store.get("autostart") !== "0";
  $("autostart").addEventListener("change", () => store.set("autostart", $("autostart").checked ? "1" : "0"));
  $("keepaudio").checked = store.get("keepaudio") !== "0";
  $("keepaudio").addEventListener("change", () => store.set("keepaudio", $("keepaudio").checked ? "1" : "0"));
  if (!isMac) {
    $("prompt").disabled = false;
    $("termshint").textContent = "proper nouns and jargon; the browser engine can't take a prompt, so use these with Find and replace, or use the Mac app.";
  }

  setMode(params.get("mode") === "live" ? "live" : "file");   // always opens in FILE unless asked for LIVE
  offerDraft();

  if (isMac) {
    S.about = await fetch("/api/about").then((r) => r.json()).catch(() => null);
    renderEngine();
    poll(true);
  } else {
    renderEngine();
    detectDevice().then((d) => { S.web.device = d; renderEngine(); });
    // Is the Mac app running? Offer to switch to it.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1500);
    fetch(LOCAL_URL + "api/about", { signal: ctl.signal }).then((r) => r.json()).then((a) => { S.localAbout = a; renderEngine(); }).catch(() => {});
  }
}

init();
