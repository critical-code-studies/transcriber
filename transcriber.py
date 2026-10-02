#!/usr/bin/env python3
"""Local transcription tool: whisper.cpp behind a small standard-library web server.

Serves index.html on http://127.0.0.1:8765/ and runs one transcription job at a time:
ffmpeg extracts 16 kHz mono audio, whisper-cli transcribes it, and the result is
written as .md (timestamped paragraphs), .srt and .txt.

No third-party packages. Runs on the system or Homebrew python3 (3.9+).
"""

import array
import atexit
import collections
import datetime
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("TRANSCRIBER_PORT", "8765"))
HERE = os.path.dirname(os.path.abspath(__file__))

BIN = "/opt/homebrew/bin"
FFMPEG = os.path.join(BIN, "ffmpeg")
FFPROBE = os.path.join(BIN, "ffprobe")
WHISPER = os.path.join(BIN, "whisper-cli")
MODEL_DIR = os.path.expanduser("~/Documents/whisper-models")
MODELS = {
    "turbo": ("ggml-large-v3-turbo.bin", "large-v3-turbo"),
    "base": ("ggml-base.bin", "base"),
}
THREADS = 8

PARAGRAPH_SECONDS = 75    # start a new paragraph at the first sentence end after this long
IDLE_SECONDS = 15 * 60    # exit when no page has polled for this long and nothing is running

# Only one server runs (fixed port), so upload folders left by an earlier run are stale.
for _old in glob.glob(os.path.join(tempfile.gettempdir(), "transcriber-uploads-*")):
    shutil.rmtree(_old, True)
UPLOAD_ROOT = tempfile.mkdtemp(prefix="transcriber-uploads-")
atexit.register(shutil.rmtree, UPLOAD_ROOT, True)

last_seen = time.time()
last_dir = os.path.expanduser("~")
job = None
job_lock = threading.Lock()
server = None


# ---------------------------------------------------------------- helpers

def hms(seconds):
    s = int(seconds)
    return "%d:%02d:%02d" % (s // 3600, s // 60 % 60, s % 60)


def srt_time(ms):
    return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)


def parse_clock(text):
    """'1:02:03', '62:03' or '45' -> seconds."""
    secs = 0
    for part in text.split(":"):
        secs = secs * 60 + int(part)
    return secs


LANG3 = {"eng": "en", "fra": "fr", "fre": "fr", "deu": "de", "ger": "de", "spa": "es",
         "ita": "it", "por": "pt", "nld": "nl", "dut": "nl", "swe": "sv", "dan": "da",
         "nor": "no", "nob": "no", "pol": "pl", "ell": "el", "gre": "el", "rus": "ru",
         "jpn": "ja", "zho": "zh", "chi": "zh"}


def probe(path):
    """Duration, container tags and audio language from one ffprobe call."""
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries",
         "format=duration:format_tags:stream=codec_type:stream_tags=language",
         "-of", "json", path],
        capture_output=True, text=True)
    try:
        data = json.loads(r.stdout or "{}")
        duration = float(data["format"]["duration"])
    except (ValueError, KeyError, TypeError):
        raise JobError("Not a readable audio or video file: %s" % os.path.basename(path))
    tags = {k.lower(): str(v).strip() for k, v in (data["format"].get("tags") or {}).items()}
    language = None
    for stream in data.get("streams", []):
        code = (stream.get("tags") or {}).get("language", "").lower()
        if stream.get("codec_type") == "audio" and code in LANG3:
            language = LANG3[code]
            break
    return duration, tags, language


def probe_duration(path):
    return probe(path)[0]


def file_metadata(tags):
    """The descriptive tags worth recording in the transcript header."""
    meta = {}
    if tags.get("title"):
        meta["title"] = tags["title"]
    for key in ("artist", "album_artist", "composer", "author"):
        if tags.get(key):
            meta["by"] = tags[key]
            break
    date = tags.get("date", "")
    if re.fullmatch(r"\d{8}", date):                   # yt-dlp writes YYYYMMDD
        date = "%s-%s-%s" % (date[:4], date[4:6], date[6:])
    if date:
        meta["date"] = date
    for key in ("purl", "comment", "description", "synopsis"):
        m = re.search(r"https?://\S+", tags.get(key, ""))
        if m:
            meta["url"] = m.group(0).rstrip(").,")
            break
    if tags.get("album") and tags.get("album") != meta.get("title"):
        meta["album"] = tags["album"]
    return meta


def stem_of(path):
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = re.sub(r"\s*\[[A-Za-z0-9_-]{6,}\]\s*$", "", stem)       # yt-dlp video id
    stem = re.sub(r"\s*\((?:\d{3,4}p|HD|4K|audio|video)\)", "", stem, flags=re.I)
    stem = re.sub(r"[_]+", " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" .-")
    return stem[:1].upper() + stem[1:] if stem else "Recording"


def suggest_title(path, tags):
    title = tags.get("title") or stem_of(path)
    if len(title) > 110:                               # long descriptive filenames
        cut = re.split(r"\s+(?:on|about|in which|where|that|discussing)\s+", title, maxsplit=1)[0]
        title = cut if 20 <= len(cut) < len(title) else title[:110].rsplit(" ", 1)[0] + "…"
    return title


def suggest_outname(title):
    words = [w for w in re.findall(r"[a-z0-9]+", title.lower()) if w not in STOPWORDS]
    return "-".join(words[:6] or ["recording"]) + "-transcript"


def suggest_terms(path, tags):
    """Proper nouns from the filename and descriptive tags, for whisper's --prompt."""
    text = " . ".join([stem_of(path)] + [tags.get(k, "") for k in
                      ("title", "artist", "album_artist", "composer", "album",
                       "description", "synopsis", "comment")])
    text = re.sub(r"https?://\S+", " ", text)
    found = []
    name = r"[A-Z][\w’'-]*[a-z][\w’'-]*"
    for m in re.finditer(r"\b%s(?:\s+(?:of |de |van |von |da |le )?%s)*" % (name, name), text):
        term = m.group(0).strip(" -")
        sentence_start = re.search(r"(?:^|[.!?:;]\s*)$", text[:m.start()]) is not None
        if " " not in term and (sentence_start or term.lower() in STOPWORDS):
            continue
        if term not in found:
            found.append(term)
    out = ", ".join(found)
    return out[:300].rsplit(",", 1)[0] if len(out) > 300 else out


def describe(path):
    duration, tags, language = probe(path)
    title = suggest_title(path, tags)
    return {
        "path": path,
        "name": os.path.basename(path),
        "dir": os.path.dirname(path),
        "duration": duration,
        "title": title,
        "outname": suggest_outname(title),
        "terms": suggest_terms(path, tags),
        "language": language,
        "meta": file_metadata(tags),
    }


def parse_replacements(text):
    pairs = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\s*(?:=>|->|→|\t)\s*", line, maxsplit=1)
        if len(parts) == 2 and parts[0]:
            src, dst = parts
            pattern = re.escape(src)
            if re.match(r"\w", src):
                pattern = r"\b" + pattern
            if re.search(r"\w$", src):
                pattern += r"\b"
            pairs.append((re.compile(pattern), dst, src))
    return pairs


def apply_replacements(text, pairs):
    for pattern, dst, _ in pairs:
        text = pattern.sub(lambda m: dst, text)
    return text


def parse_sections(text):
    sections = []
    for line in (text or "").splitlines():
        m = re.match(r"\s*\[?(\d+(?::\d{1,2}){0,2})\]?\s+(.+?)\s*$", line)
        if m:
            sections.append((parse_clock(m.group(1)), m.group(2)))
    return sorted(sections)


def parse_srt(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        blocks = re.split(r"\n\s*\n", f.read().strip())
    segs = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue
        m = re.match(r"(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)", lines[1])
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        start = ((g[0] * 60 + g[1]) * 60 + g[2]) * 1000 + g[3]
        end = ((g[4] * 60 + g[5]) * 60 + g[6]) * 1000 + g[7]
        text = " ".join(l.strip() for l in lines[2:]).strip()
        if text and text != "[BLANK_AUDIO]":
            segs.append({"start": start, "end": end, "text": text})
    return segs


SENTENCE_END = re.compile(r"[.?!][\"'”’)\]]*$")


def sentences(segs):
    """Re-cut whisper segments at sentence ends; a sentence's start time is interpolated
    from its character offset within the segment it begins in."""
    out, cur = [], None
    for seg in segs:
        text = seg["text"]
        span = max(seg["end"] - seg["start"], 1)
        pieces = re.split(r"(?<=[.?!])[\"'”’)\]]*\s+", text)
        offset = 0
        for piece in pieces:
            if not piece:
                continue
            at = text.find(piece, offset)
            offset = max(at, offset) + len(piece)
            start = seg["start"] + span * max(at, 0) / max(len(text), 1)
            if cur is None:
                cur = {"start": start, "parts": []}
            cur["parts"].append(piece)
            cur["end"] = seg["end"]
            if SENTENCE_END.search(piece) or (cur["end"] - cur["start"]) / 1000 > 60:
                out.append(cur)
                cur = None
    if cur:
        out.append(cur)
    for s in out:
        s["text"] = re.sub(r"\s+", " ", " ".join(s.pop("parts"))).strip()
    return out


def build_markdown(segs, sections, pairs, header):
    sents = sentences(segs)
    # Each heading goes before the sentence that starts closest to its time.
    breaks, lo = {}, 0
    for t, title in sections:
        if lo >= len(sents):
            break
        i = min(range(lo, len(sents)), key=lambda k: abs(sents[k]["start"] / 1000 - t))
        breaks.setdefault(i, []).append(title)
        lo = i
    out = [header]
    if not sections:
        out.append("## Transcript\n")
    count = 0
    para, para_start = [], 0

    def flush():
        nonlocal count
        if para:
            text = apply_replacements(" ".join(para), pairs)
            out.append("**[%s]** %s\n" % (hms(para_start / 1000), text))
            count += 1
            del para[:]

    for i, s in enumerate(sents):
        if i in breaks:
            flush()
            out.extend("## %s\n" % title for title in breaks[i])
        if not para:
            para_start = s["start"]
        para.append(s["text"])
        if (s["end"] - para_start) / 1000 >= PARAGRAPH_SECONDS:
            flush()
    flush()
    return "\n".join(out), count


STOPWORDS = set("""a about above after again against all also am an and any are as at be because
been before being below between both but by can could did do does doing down during each even
few for from further get got had has have having he her here hers him his how i if in into is
it its itself just know like made make many may me might more most much must my no nor not now
of off on once one only or other our ours out over own really right said same say see she should
so some something such than that the their theirs them then there these they thing things think
this those through to too um uh under until up us very was way we well were what when where
which while who whom why will with would yeah yes you your yours going go kind sort lot actually
okay ok gonna want little bit""".split())


def analyse_audio(wav, buckets=720):
    """Peak level per 100 ms window: a display waveform plus silences of 2 s or more.
    A window counts as silent below 8% of the 95th-percentile window peak."""
    with wave.open(wav, "rb") as w:
        rate = w.getframerate()
        win = rate // 10
        levels = []
        while True:
            data = w.readframes(win)
            if len(data) < 2:
                break
            a = array.array("h")
            a.frombytes(data[:len(data) // 2 * 2])
            if sys.byteorder == "big":
                a.byteswap()
            levels.append(max(max(a), -min(a)))
    if not levels:
        return {"peaks": [], "pauses": [], "audible": 0.0}
    group = -(-len(levels) // buckets)
    peaks = [max(levels[i:i + group]) for i in range(0, len(levels), group)]
    top = max(peaks) or 1
    ref = sorted(levels)[int(len(levels) * 0.95)] or 1
    threshold = 0.08 * ref
    pauses, run = [], 0
    for i, level in enumerate(levels + [threshold]):
        if level < threshold:
            run += 1
        else:
            if run >= 20:
                pauses.append((run / 10, (i - run) / 10))
            run = 0
    return {
        "peaks": [round((p / top) ** 0.5, 3) for p in peaks],
        "pauses": pauses,
        "audible": sum(1 for level in levels if level >= threshold) / 10,
    }


def compute_stats(segs, duration, pairs, raw_text, timings, paragraphs, sections, audio):
    tokens = re.findall(r"[A-Za-z][A-Za-z'’-]*", raw_text)
    words = len(tokens)
    minutes = max(duration / 60, 1 / 60)

    # Words per minute of recording, spreading each segment's words over its span.
    per_minute = [0.0] * max(1, -int(-duration // 60))
    for s in segs:
        n = len(re.findall(r"[A-Za-z][A-Za-z'’-]*", s["text"]))
        a, b = s["start"] / 1000, max(s["end"] / 1000, s["start"] / 1000 + 0.01)
        m = int(a // 60)
        while m * 60 < b and m < len(per_minute):
            overlap = min(b, (m + 1) * 60) - max(a, m * 60)
            per_minute[m] += n * overlap / (b - a)
            m += 1

    # Whisper's segments abut each other, so silence is measured from the audio.
    audio = audio or {}
    speech = audio.get("audible") or duration
    pauses = audio.get("pauses") or []
    longest = max(pauses) if pauses else None

    counts = collections.Counter(t.lower().strip("'’-") for t in tokens)
    top_words = [(w, c) for w, c in counts.most_common(200)
                 if len(w) > 3 and w not in STOPWORDS][:16]

    # Capitalised words not at a sentence start: candidates for name checking.
    names = collections.Counter()
    corrected = apply_replacements(raw_text, pairs)
    for m in re.finditer(r"(?<![.?!]\s)(?<!^)\b[A-Z][\w’'-]*(?:\s+[A-Z][\w’'-]*)*", corrected):
        kept = [w for w in m.group(0).split() if w.lower().strip("’'") not in STOPWORDS
                and not re.match(r"I(?:['’].*)?$", w)]
        if kept:
            names[" ".join(kept)] += 1

    return {
        "duration": duration,
        "processing": timings.get("total", 0),
        "transcribe_seconds": timings.get("transcribe", 0),
        "speed": duration / timings["transcribe"] if timings.get("transcribe") else None,
        "words": words,
        "unique_words": len(counts),
        "wpm": words / minutes,
        "speaking_wpm": words / (speech / 60) if speech else 0,
        "audible_ratio": min(1.0, speech / duration) if duration else 0,
        "segments": len(segs),
        "paragraphs": paragraphs,
        "sections": sections,
        "pauses": len(pauses),
        "longest_pause": {"seconds": longest[0], "at": longest[1]} if longest else None,
        "pause_list": [{"seconds": p[0], "at": p[1]} for p in pauses],
        "per_minute": [round(x, 1) for x in per_minute],
        "top_words": top_words,
        "names": names.most_common(24),
        "replacements": [{"from": src, "to": d, "count": len(p.findall(raw_text))}
                         for p, d, src in pairs],
    }


def osa_choose(kind, prompt, default_dir=None):
    expr = 'choose %s with prompt "%s"' % (kind, prompt)
    if default_dir and os.path.isdir(default_dir):
        quoted = default_dir.replace("\\", "\\\\").replace('"', '\\"')
        expr += ' default location (POSIX file "%s")' % quoted
    r = subprocess.run(["osascript", "-e", "activate", "-e", "POSIX path of (%s)" % expr],
                       capture_output=True, text=True)
    path = r.stdout.strip()
    if r.returncode != 0 or not path:
        return None
    return path.rstrip("/") if kind == "folder" else path


def resolve_dropped(name, size, modified_ms):
    """Find the real path of a file dropped on the page, via Spotlight."""
    quoted = name.replace("\\", "\\\\").replace('"', '\\"')
    try:
        r = subprocess.run(["mdfind", 'kMDItemFSName == "%s"' % quoted],
                           capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        return None
    hits = []
    for p in r.stdout.splitlines():
        try:
            st = os.stat(p)
        except OSError:
            continue
        if os.path.basename(p) == name and st.st_size == size and not p.startswith(UPLOAD_ROOT):
            hits.append((abs(st.st_mtime * 1000 - (modified_ms or 0)), p))
    hits.sort()
    if len(hits) == 1 or (hits and hits[0][0] < 2000):
        return hits[0][1]
    return None


def unique_base(outdir, name):
    base, n = os.path.join(outdir, name), 2
    while any(os.path.exists(base + ext) for ext in (".md", ".srt", ".txt")):
        base = os.path.join(outdir, "%s-%d" % (name, n))
        n += 1
    return base


# ---------------------------------------------------------------- the job

class JobError(Exception):
    pass


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, opts):
        self.opts = opts
        self.state = "running"
        self.stage = "Starting"
        self.progress = 0.0
        self.message = ""
        self.outputs = []
        self.segments = []
        self.wave = None
        self.audio = None
        self.meta = {}
        self.stats = None
        self.timings = {}
        self.preview = collections.deque(maxlen=6)
        self.log = collections.deque(maxlen=40)
        self.detected_language = None
        self.duration = 0.0
        self.proc = None
        self.cancelled = False
        self.started = time.time()
        self.stage_started = self.started
        self.finished = None

    def snapshot(self, since=0, want_wave=False):
        now = self.finished or time.time()
        eta = None
        if self.state == "running" and self.stage == "Transcribing" and self.progress > 12:
            done = (self.progress - 8) / 90
            eta = (now - self.stage_started) * (1 - done) / done
        return {
            "state": self.state, "stage": self.stage, "progress": round(self.progress, 1),
            "message": self.message, "outputs": self.outputs, "preview": list(self.preview),
            "log": list(self.log), "elapsed": now - self.started, "eta": eta,
            "stage_elapsed": now - self.stage_started,
            "input": self.opts.get("path"), "name": self.opts.get("name"),
            "duration": self.duration, "segments": self.segments[since:],
            "segment_count": len(self.segments), "stats": self.stats,
            "wave": self.wave if want_wave else None, "has_wave": self.wave is not None,
            "model": self.opts.get("model") or "turbo",
        }

    def set_stage(self, stage, progress):
        now = time.time()
        if self.stage in ("Extracting audio", "Transcribing"):
            self.timings["extract" if self.stage == "Extracting audio" else "transcribe"] = \
                now - self.stage_started
        self.stage, self.progress, self.stage_started = stage, progress, now

    def cancel(self):
        self.cancelled = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def run(self):
        work = tempfile.mkdtemp(prefix="transcriber-")
        try:
            self._run(work)
            self.state = "done"
        except Cancelled:
            self.state, self.message = "cancelled", "Cancelled."
        except JobError as e:
            self.state, self.message = "error", str(e)
        except Exception as e:
            self.state, self.message = "error", "%s: %s" % (type(e).__name__, e)
        finally:
            self.finished = time.time()
            shutil.rmtree(work, True)
            if self.opts.get("uploaded"):
                shutil.rmtree(os.path.dirname(self.opts["path"]), True)

    def _stream(self, cmd, on_line, label):
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                     errors="replace", bufsize=1)

        def read_err():
            for line in self.proc.stderr:
                line = line.rstrip()
                if line:
                    self.log.append(line)
                m = re.search(r"auto-detected language: (\w+)", line)
                if m:
                    self.detected_language = m.group(1)
        t = threading.Thread(target=read_err, daemon=True)
        t.start()
        for line in self.proc.stdout:
            on_line(line.rstrip())
        rc = self.proc.wait()
        t.join(2)
        if self.cancelled:
            raise Cancelled()
        if rc != 0:
            tail = " ".join(list(self.log)[-3:])
            raise JobError("%s failed (exit %d). %s" % (label, rc, tail))

    def _on_ffmpeg(self, line):
        m = re.match(r"out_time_(?:us|ms)=(\d+)", line)
        if m and self.duration:
            self.progress = min(8.0, 8.0 * int(m.group(1)) / 1e6 / self.duration)

    def _on_whisper(self, line):
        m = re.match(r"\[(\d+):(\d+):(\d+)\.\d+ --> (\d+):(\d+):(\d+)\.\d+\]\s*(.*)", line)
        if not m:
            return
        g = [int(x) for x in m.groups()[:6]]
        end = g[3] * 3600 + g[4] * 60 + g[5]
        if self.duration:
            self.progress = max(self.progress, min(98.0, 8 + 90 * end / self.duration))
        text = m.group(7).strip()
        if text and text != "[BLANK_AUDIO]":
            start = g[0] * 3600 + g[1] * 60 + g[2]
            self.segments.append({"s": start, "e": max(end, start + 0.5), "t": text})
            self.preview.append("[%s] %s" % (hms(g[0] * 3600 + g[1] * 60 + g[2]), text))

    def _run(self, work):
        o = self.opts
        src = o["path"]
        if not os.path.isfile(src):
            raise JobError("File not found: %s" % src)
        model_file, model_label = MODELS.get(o.get("model") or "turbo", MODELS["turbo"])
        model = os.path.join(MODEL_DIR, model_file)
        if not os.path.isfile(model):
            raise JobError("Model not found: %s" % model)
        outdir = os.path.expanduser(o.get("outdir") or os.path.dirname(src))
        if not os.path.isdir(outdir):
            raise JobError("Output folder does not exist: %s" % outdir)
        if not os.access(outdir, os.W_OK):
            raise JobError("Output folder is not writable: %s" % outdir)

        self.set_stage("Reading file", 0)
        self.duration, tags, _ = probe(src)
        self.meta = file_metadata(tags)

        self.set_stage("Extracting audio", 0)
        wav = os.path.join(work, "audio.wav")
        self._stream([FFMPEG, "-nostdin", "-v", "error", "-y", "-i", src, "-map", "0:a:0", "-vn",
                      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                      "-progress", "pipe:1", "-nostats", wav],
                     self._on_ffmpeg, "ffmpeg")
        try:
            self.audio = analyse_audio(wav)
            self.wave = self.audio["peaks"]
        except Exception as e:
            self.log.append("audio analysis skipped: %s" % e)

        self.set_stage("Transcribing", 8)
        language = (o.get("language") or "en").strip() or "en"
        raw = os.path.join(work, "whisper")
        cmd = [WHISPER, "-m", model, "-f", wav, "-l", language, "-t", str(THREADS),
               "-osrt", "-of", raw]
        prompt = (o.get("prompt") or "").strip()
        if prompt:
            cmd += ["--prompt", prompt]
        self._stream(cmd, self._on_whisper, "whisper-cli")
        if self.cancelled:
            raise Cancelled()

        self.set_stage("Writing files", 99)
        self.raw_segs = parse_srt(raw + ".srt")
        if not self.raw_segs:
            raise JobError("No speech was recognised in this file.")
        self.timings["total"] = time.time() - self.started
        self.language = self.detected_language if language == "auto" else language
        self.model_label = model_label
        self.outdir = outdir
        self.base = unique_base(outdir, re.sub(r"[/:]", "-", (o.get("outname") or "").strip())
                                or suggest_outname(suggest_title(src, {})))
        self.write_outputs()
        self.progress = 100.0
        self.stage = "Finished"

    def write_outputs(self):
        """Write .md/.srt/.txt from the recognised segments; rerun to re-apply corrections."""
        o, src, segs, base = self.opts, self.opts["path"], self.raw_segs, self.base
        pairs = parse_replacements(o.get("replacements"))
        sections = parse_sections(o.get("sections"))

        with open(base + ".srt", "w", encoding="utf-8") as f:
            for i, s in enumerate(segs, 1):
                f.write("%d\n%s --> %s\n%s\n\n" % (i, srt_time(s["start"]), srt_time(s["end"]),
                                                   apply_replacements(s["text"], pairs)))
        with open(base + ".txt", "w", encoding="utf-8") as f:
            f.write("\n".join(apply_replacements(s["text"], pairs) for s in segs) + "\n")

        title = (o.get("title") or "").strip() or stem_of(src)
        same_dir = os.path.realpath(self.outdir) == os.path.realpath(os.path.dirname(src))
        where = ", in this folder" if same_dir and not o.get("uploaded") else ""
        method = "Machine transcript (whisper.cpp, %s, language: %s), transcribed %s." % (
            self.model_label, self.language or "auto-detected", datetime.date.today().isoformat())
        notes = []
        if (o.get("prompt") or "").strip():
            notes.append("Names and terms supplied to the model as a prompt.")
        if pairs:
            notes.append("%d find/replace correction%s applied." % (len(pairs), "" if len(pairs) == 1 else "s"))
        notes.append("Names, technical terms and quotations not checked against the recording. "
                     "Timestamps mark paragraph starts.")
        meta = []
        if self.meta.get("title") and self.meta["title"] != title:
            meta.append("title “%s”" % self.meta["title"])
        for key, label in (("by", "by"), ("album", "from"), ("date", "dated")):
            if self.meta.get(key):
                meta.append("%s %s" % (label, self.meta[key]))
        if self.meta.get("url"):
            meta.append("<%s>" % self.meta["url"])
        meta_line = " File metadata: %s." % "; ".join(meta) if meta else ""
        header = "# %s\n\nSource: `%s` (%s)%s.%s\n\n%s %s\n" % (
            title, o.get("name") or os.path.basename(src), hms(self.duration), where,
            meta_line, method, " ".join(notes))
        markdown, paragraphs = build_markdown(segs, sections, pairs, header)
        with open(base + ".md", "w", encoding="utf-8") as f:
            f.write(markdown)

        raw_text = re.sub(r"\s+", " ", " ".join(s["text"] for s in segs))
        self.stats = compute_stats(segs, self.duration, pairs, raw_text, self.timings,
                                   paragraphs, len(sections), self.audio)
        self.stats["language"] = self.language
        self.stats["model"] = self.model_label
        self.outputs = [base + ext for ext in (".md", ".srt", ".txt")]


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "Transcriber/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _guard(self, write=False):
        """Refuse other hosts (DNS rebinding) and cross-site writes (no custom header)."""
        global last_seen
        last_seen = time.time()
        host_ok = self.headers.get("Host", "") in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)
        if not host_ok or (write and self.headers.get("X-Transcriber") != "1"):
            self._json({"error": "forbidden"}, 403)
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif path == "/api/status":
            q = parse_qs(urlparse(self.path).query)
            since = int(q.get("since", ["0"])[0] or 0)
            self._json({
                "job": job.snapshot(since, q.get("wave") == ["1"]) if job else None,
                "models": {k: os.path.isfile(os.path.join(MODEL_DIR, v[0])) for k, v in MODELS.items()},
                "downloads": os.path.expanduser("~/Downloads"),
            })
        else:
            self._json({"error": "not found"}, 404)

    def do_PUT(self):
        if not self._guard(write=True):
            return
        url = urlparse(self.path)
        if url.path != "/api/upload":
            return self._json({"error": "not found"}, 404)
        name = os.path.basename(unquote(parse_qs(url.query).get("name", ["upload"])[0])) or "upload"
        remaining = int(self.headers.get("Content-Length") or 0)
        dest = os.path.join(tempfile.mkdtemp(dir=UPLOAD_ROOT), name)
        with open(dest, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        try:
            info = describe(dest)
        except JobError as e:
            shutil.rmtree(os.path.dirname(dest), True)
            return self._json({"error": str(e)}, 400)
        info["uploaded"] = True
        self._json(info)

    def do_POST(self):
        global job, last_dir
        if not self._guard(write=True):
            return
        path = urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if path == "/api/choose-file":
                p = osa_choose("file", "Choose a recording to transcribe", last_dir)
                if p:
                    last_dir = os.path.dirname(p)
                return self._json(describe(p) if p else {"cancelled": True})
            if path == "/api/choose-folder":
                p = osa_choose("folder", "Choose where to save the transcript",
                               body.get("start") or last_dir)
                return self._json({"path": p} if p else {"cancelled": True})
            if path == "/api/resolve":
                p = resolve_dropped(body.get("name", ""), int(body.get("size") or 0),
                                    body.get("modified"))
                return self._json(describe(p) if p else {"path": None})
            if path == "/api/probe":
                p = os.path.expanduser(body.get("path", "").strip().strip("'\""))
                if not os.path.isfile(p):
                    return self._json({"error": "File not found: %s" % p}, 400)
                return self._json(describe(p))
            if path == "/api/transcribe":
                with job_lock:
                    if job and job.state == "running":
                        return self._json({"error": "A transcription is already running."}, 409)
                    job = Job(body)
                    threading.Thread(target=job.run, daemon=True).start()
                return self._json({"ok": True})
            if path == "/api/rewrite":
                if not job or job.state != "done":
                    return self._json({"error": "No finished transcript to update."}, 409)
                for key in ("replacements", "sections", "title"):
                    if key in body:
                        job.opts[key] = body[key]
                job.write_outputs()
                return self._json({"ok": True, "stats": job.stats})
            if path == "/api/cancel":
                if job:
                    job.cancel()
                return self._json({"ok": True})
            if path == "/api/open":
                p = body.get("path", "")
                if job and p in job.outputs:
                    subprocess.run(["open", "-R", p] if body.get("reveal") else ["open", p])
                return self._json({"ok": True})
            if path == "/api/quit":
                if job:
                    job.cancel()
                self._json({"ok": True})
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            self._json({"error": "not found"}, 404)
        except JobError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": "%s: %s" % (type(e).__name__, e)}, 500)


def watchdog():
    while True:
        time.sleep(30)
        busy = job is not None and job.state == "running"
        if not busy and time.time() - last_seen > IDLE_SECONDS:
            server.shutdown()
            return


def main():
    global server
    for tool in (FFMPEG, FFPROBE, WHISPER):
        if not os.path.isfile(tool):
            sys.exit("Missing %s" % tool)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # so atexit cleanup runs
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    threading.Thread(target=watchdog, daemon=True).start()
    print("Transcriber on http://%s:%d/" % (HOST, PORT), flush=True)
    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        if job and job.state == "running":
            job.cancel()


if __name__ == "__main__":
    main()
