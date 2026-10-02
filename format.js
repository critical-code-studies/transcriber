// Transcript formatting and statistics for the browser engine.
// Mirrors the equivalent functions in transcriber.py, which the Mac engine uses.

export const PARAGRAPH_SECONDS = 75;

export const STOPWORDS = new Set(`a about above after again against all also am an and any are as at be because
been before being below between both but by can could did do does doing down during each even
few for from further get got had has have having he her here hers him his how i if in into is
it its itself just know like made make many may me might more most much must my no nor not now
of off on once one only or other our ours out over own really right said same say see she should
so some something such than that the their theirs them then there these they thing things think
this those through to too um uh under until up us very was way we well were what when where
which while who whom why will with would yeah yes you your yours going go kind sort lot actually
okay ok gonna want little bit`.split(/\s+/));

const WORD = /[A-Za-z][A-Za-z'’-]*/g;
const SENTENCE_END = /[.?!]["'”’)\]]*$/;

export function hms(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export const wordCount = (text) => (text.match(WORD) || []).length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseReplacements(text) {
  const pairs = [];
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s*(?:=>|->|→|\t)\s*/);
    if (parts.length < 2 || !parts[0]) continue;
    const src = parts[0], dst = parts.slice(1).join(" ");
    let pattern = escapeRe(src);
    if (/^\w/.test(src)) pattern = "\\b" + pattern;
    if (/\w$/.test(src)) pattern += "\\b";
    pairs.push({ re: new RegExp(pattern, "g"), dst, src });
  }
  return pairs;
}

export function applyReplacements(text, pairs) {
  for (const p of pairs) text = text.replace(p.re, () => p.dst);
  return text;
}

export function parseSections(text) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^\s*\[?(\d+(?::\d{1,2}){0,2})\]?\s+(.+?)\s*$/);
    if (m) out.push([m[1].split(":").reduce((a, b) => a * 60 + +b, 0), m[2]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Re-cut segments ({start, end} in ms, text, speaker?) at sentence ends, interpolating start
 *  times. A change of speaker also ends a sentence. */
export function sentences(segs) {
  const out = [];
  let cur = null;
  for (const seg of segs) {
    const text = seg.text, span = Math.max(seg.end - seg.start, 1), speaker = seg.speaker || null;
    if (cur && speaker !== cur.speaker) { out.push(cur); cur = null; }
    let offset = 0;
    for (const piece of text.split(/(?<=[.?!]["'”’)\]]?)\s+/)) {
      if (!piece) continue;
      const at = text.indexOf(piece, offset);
      offset = Math.max(at, offset) + piece.length;
      const start = seg.start + (span * Math.max(at, 0)) / Math.max(text.length, 1);
      if (!cur) cur = { start, parts: [], speaker };
      cur.parts.push(piece);
      cur.end = seg.end;
      if (SENTENCE_END.test(piece) || (cur.end - cur.start) / 1000 > 60) { out.push(cur); cur = null; }
    }
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.parts.join(" ").replace(/\s+/g, " ").trim() }));
}

export function buildMarkdown(segs, sections, pairs, header, pauses = []) {
  const sents = sentences(segs);
  const breaks = new Map();
  let lo = 0;
  for (const [t, title] of sections) {
    if (lo >= sents.length) break;
    let best = lo;
    for (let k = lo; k < sents.length; k++) {
      if (Math.abs(sents[k].start / 1000 - t) < Math.abs(sents[best].start / 1000 - t)) best = k;
    }
    if (!breaks.has(best)) breaks.set(best, []);
    breaks.get(best).push(title);
    lo = best;
  }
  const out = [header];
  if (!sections.length) out.push("## Transcript\n");
  let para = [], paraStart = 0, paraSpeaker = null, labelled = null, count = 0;
  const flush = () => {
    if (!para.length) return;
    let label = "";
    if (paraSpeaker && paraSpeaker !== labelled) { label = `[${paraSpeaker}] `; labelled = paraSpeaker; }
    out.push(`**[${hms(paraStart / 1000)}]** ${label}${applyReplacements(para.join(" "), pairs)}\n`);
    count++;
    para = [];
  };
  let prevEnd = null;
  sents.forEach((s, i) => {
    if (breaks.has(i)) { flush(); for (const title of breaks.get(i)) out.push(`## ${title}\n`); labelled = null; }
    else if (para.length && (s.speaker || null) !== paraSpeaker) flush();     // a new speaker starts a paragraph
    else if (para.length && prevEnd != null && (s.start - paraStart) / 1000 >= 15 &&
             pauses.some(([len, at]) => at >= prevEnd / 1000 - 0.6 && at + len <= s.start / 1000 + 0.6)) {
      flush();                                       // a silence of 2 s or more starts a paragraph
    }
    prevEnd = s.end;
    if (!para.length) { paraStart = s.start; paraSpeaker = s.speaker || null; }
    para.push(s.text);
    if ((s.end - paraStart) / 1000 >= PARAGRAPH_SECONDS) flush();
  });
  flush();
  return { markdown: out.join("\n"), paragraphs: count };
}

/** Segment texts with "[Speaker]" prefixed wherever the speaker changes. */
export function speakerLines(segs, pairs) {
  let last = null;
  return segs.map((s) => {
    let text = applyReplacements(s.text, pairs);
    if (s.speaker && s.speaker !== last) text = `[${s.speaker}] ${text}`;
    last = s.speaker || null;
    return text;
  });
}

export function buildSrt(segs, pairs) {
  const lines = speakerLines(segs, pairs);
  return segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${lines[i]}\n`).join("\n");
}

export const buildTxt = (segs, pairs) => speakerLines(segs, pairs).join("\n") + "\n";

/** Peak level per 100 ms window: display peaks plus silences of 2 s or more. */
export function analyseAudio(samples, rate = 16000, buckets = 720) {
  const win = Math.floor(rate / 10), levels = [];
  for (let i = 0; i < samples.length; i += win) {
    let peak = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) { const v = Math.abs(samples[j]); if (v > peak) peak = v; }
    levels.push(peak);
  }
  return summariseLevels(levels, buckets);
}

/** From 100 ms peak levels: display peaks, silences of 2 s or more (below 8% of the
 *  95th-percentile level), and seconds of audible sound. */
export function summariseLevels(levels, buckets = 720) {
  if (!levels.length) return { peaks: [], pauses: [], audible: 0 };
  const group = Math.ceil(levels.length / buckets), peaks = [];
  for (let i = 0; i < levels.length; i += group) peaks.push(Math.max(...levels.slice(i, i + group)));
  const top = Math.max(...peaks) || 1;
  const ref = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.95)] || 1;
  const threshold = 0.08 * ref, pauses = [];
  let run = 0, audible = 0;
  levels.concat([threshold]).forEach((level, i) => {
    if (level < threshold) run++;
    else { if (run >= 20) pauses.push([run / 10, (i - run) / 10]); run = 0; }
  });
  for (const level of levels) if (level >= threshold) audible++;
  return { peaks: peaks.map((p) => Math.round(Math.sqrt(p / top) * 1000) / 1000), pauses, audible: audible / 10, levels, threshold };
}

export const MIN_GAP = 4;

/** Stretches of at least MIN_GAP seconds with clear sound but no recognised text.
 *  segs: [{s, e}] in seconds. Mirrors find_gaps in transcriber.py. */
export function findGaps(segs, duration, audio) {
  if (!audio || !audio.levels) return [];
  const { levels, threshold } = audio, candidates = [];
  let cursor = 0;
  for (const seg of [...segs].sort((a, b) => a.s - b.s)) {
    if (seg.s - cursor >= MIN_GAP) candidates.push([cursor, seg.s]);
    cursor = Math.max(cursor, seg.e);
  }
  if (duration - cursor >= MIN_GAP) candidates.push([cursor, duration]);
  return candidates.filter(([a, b]) => {
    const audible = levels.slice(Math.floor(a * 10), Math.floor(b * 10)).filter((l) => l >= threshold).length / 10;
    return audible >= 2.5 && audible >= 0.4 * (b - a);
  });
}

/** Drop words at the edges of text that repeat the end of before or the start of after. */
export function trimOverlap(before, text, after) {
  const norm = (w) => w.toLowerCase().replace(/[^\w']/g, "");
  let words = text.split(/\s+/).filter(Boolean);
  const prev = before.split(/\s+/).filter(Boolean).map(norm).slice(-8);
  for (let k = Math.min(8, words.length, prev.length); k > 0; k--) {
    if (words.slice(0, k).map(norm).join(" ") === prev.slice(-k).join(" ")) { words = words.slice(k); break; }
  }
  const next = after.split(/\s+/).filter(Boolean).map(norm).slice(0, 8);
  for (let k = Math.min(8, words.length, next.length); k > 0; k--) {
    if (words.slice(-k).map(norm).join(" ") === next.slice(0, k).join(" ")) { words = words.slice(0, -k); break; }
  }
  return words.join(" ");
}

export function computeStats(segs, duration, pairs, rawText, timings, paragraphs, sections, audio) {
  const tokens = rawText.match(WORD) || [];
  const minutes = Math.max(duration / 60, 1 / 60);
  const perMinute = new Array(Math.max(1, Math.ceil(duration / 60))).fill(0);
  for (const s of segs) {
    const n = wordCount(s.text), a = s.start / 1000, b = Math.max(s.end / 1000, a + 0.01);
    for (let m = Math.floor(a / 60); m * 60 < b && m < perMinute.length; m++) {
      perMinute[m] += (n * (Math.min(b, (m + 1) * 60) - Math.max(a, m * 60))) / (b - a);
    }
  }
  const speech = (audio && audio.audible) || duration;
  const pauses = (audio && audio.pauses) || [];
  const longest = pauses.reduce((best, p) => (!best || p[0] > best[0] ? p : best), null);

  const counts = new Map();
  for (const t of tokens) {
    const w = t.toLowerCase().replace(/^['’-]+|['’-]+$/g, "");
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const topWords = [...counts].filter(([w]) => w.length > 3 && !STOPWORDS.has(w))
    .sort((a, b) => b[1] - a[1]).slice(0, 16);

  const names = new Map();
  const corrected = applyReplacements(rawText, pairs);
  for (const m of corrected.matchAll(/(?<![.?!]\s)(?<!^)\b[A-Z][\w’'-]*(?:\s+[A-Z][\w’'-]*)*/g)) {
    const kept = m[0].split(/\s+/).filter((w) => !STOPWORDS.has(w.toLowerCase().replace(/['’]/g, "")) && !/^I(['’].*)?$/.test(w));
    if (kept.length) names.set(kept.join(" "), (names.get(kept.join(" ")) || 0) + 1);
  }

  return {
    duration,
    processing: timings.total || 0,
    timings,
    speed: timings.Transcribing ? duration / timings.Transcribing : null,
    words: tokens.length,
    unique_words: counts.size,
    wpm: tokens.length / minutes,
    speaking_wpm: speech ? tokens.length / (speech / 60) : 0,
    audible_ratio: duration ? Math.min(1, speech / duration) : 0,
    segments: segs.length,
    paragraphs,
    sections,
    pauses: pauses.length,
    longest_pause: longest ? { seconds: longest[0], at: longest[1] } : null,
    pause_list: pauses.map((p) => ({ seconds: p[0], at: p[1] })),
    per_minute: perMinute.map((x) => Math.round(x * 10) / 10),
    top_words: topWords,
    names: [...names].sort((a, b) => b[1] - a[1]).slice(0, 24),
    replacements: pairs.map((p) => ({ from: p.src, to: p.dst, count: (rawText.match(p.re) || []).length })),
  };
}

// ---- autofill from a filename (the browser can't read container tags)

export function stemOf(name) {
  let stem = name.replace(/\.[^.]+$/, "");
  stem = stem.replace(/\s*\[[A-Za-z0-9_-]{6,}\]\s*$/, "")
    .replace(/\s*\((?:\d{3,4}p|HD|4K|audio|video)\)/gi, "")
    .replace(/_+/g, " ").replace(/\s+/g, " ").replace(/^[ .-]+|[ .-]+$/g, "");
  if (!stem.includes(" ")) stem = stem.replace(/-/g, " ");   // analytical-engine-talk
  return stem ? stem[0].toUpperCase() + stem.slice(1) : "Recording";
}

export function suggestTitle(name) {
  let title = stemOf(name);
  if (title.length > 110) {
    const cut = title.split(/\s+(?:on|about|in which|where|that|discussing)\s+/)[0];
    title = cut.length >= 20 && cut.length < title.length ? cut : title.slice(0, 110).replace(/\s+\S*$/, "") + "…";
  }
  return title;
}

export function suggestOutname(title) {
  const words = (title.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOPWORDS.has(w));
  return (words.slice(0, 6).join("-") || "recording") + "-transcript";
}

export function suggestTerms(name) {
  const text = stemOf(name), found = [];
  const word = "[A-Z][\\w’'-]*[a-z][\\w’'-]*";
  const re = new RegExp(`\\b${word}(?:\\s+(?:of |de |van |von |da |le )?${word})*`, "g");
  for (const m of text.matchAll(re)) {
    const term = m[0].replace(/^[ -]+|[ -]+$/g, "");
    const atStart = /(?:^|[.!?:;]\s*)$/.test(text.slice(0, m.index));
    if (!term.includes(" ") && (atStart || STOPWORDS.has(term.toLowerCase()))) continue;
    if (!found.includes(term)) found.push(term);
  }
  return found.join(", ");
}

export function makeHeader({ title, name, duration, sameFolder, meta, model, language, prompt, pairs, recovered, speakers }) {
  const metaBits = [];
  if (meta) {
    if (meta.title && meta.title !== title) metaBits.push(`title “${meta.title}”`);
    if (meta.by) metaBits.push(`by ${meta.by}`);
    if (meta.album) metaBits.push(`from ${meta.album}`);
    if (meta.date) metaBits.push(`dated ${meta.date}`);
    if (meta.url) metaBits.push(`<${meta.url}>`);
  }
  const metaLine = metaBits.length ? ` File metadata: ${metaBits.join("; ")}.` : "";
  const notes = [];
  if (prompt) notes.push("Names and terms supplied to the model as a prompt.");
  if (pairs.length) notes.push(`${pairs.length} find/replace correction${pairs.length === 1 ? "" : "s"} applied.`);
  if (speakers) notes.push(`Speakers identified automatically by voice (${speakers}); check the attributions.`);
  if (recovered && recovered.length) {
    notes.push(`${recovered.length} passage${recovered.length === 1 ? "" : "s"} skipped by the first pass (${recovered.map((g) => `${hms(g.s)}–${hms(g.e)}`).join(", ")}) re-transcribed separately.`);
  }
  notes.push("Names, technical terms and quotations not checked against the recording. Timestamps mark paragraph starts.");
  const today = new Date().toISOString().slice(0, 10);
  return `# ${title}\n\nSource: \`${name}\` (${hms(duration)})${sameFolder ? ", in this folder" : ""}.${metaLine}\n\n` +
    `Machine transcript (${model}, language: ${language || "auto-detected"}), transcribed ${today}. ${notes.join(" ")}\n`;
}
