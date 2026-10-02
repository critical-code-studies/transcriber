// Browser-side models, run off the main thread. Models come from Hugging Face once and are
// cached by the browser.
//   Whisper via transformers.js (WebGPU, or WebAssembly as a fallback): the browser engine.
//   WeSpeaker ResNet34 speaker embeddings: speaker identification, for both engines.
//
// Messages in: {type: "run" | "load" | "live" | "embed", id?, ...}
// Replies carry the request's id, except the streaming messages of "run".
import { pipeline, WhisperTextStreamer, AutoProcessor, AutoModel, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";

env.allowLocalModels = false;

const MODELS = {
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
  turbo: "onnx-community/whisper-large-v3-turbo",
};
const SPEAKER_MODEL = "onnx-community/wespeaker-voxceleb-resnet34-LM";
const LANGUAGES = {
  en: "english", fr: "french", de: "german", es: "spanish", it: "italian", pt: "portuguese",
  nl: "dutch", sv: "swedish", da: "danish", no: "norwegian", pl: "polish", el: "greek",
  ru: "russian", ja: "japanese", zh: "chinese",
};
const CHUNK = 30, STRIDE = 5;
const STEP = CHUNK - 2 * STRIDE;   // transformers.js advances each 30 s window by 20 s
const loaded = {};
let speaker = null;

const progress = (id) => (p) => {
  if (p.status === "progress" || p.status === "done") {
    self.postMessage({ type: "download", id, file: p.file, loaded: p.loaded, total: p.total, status: p.status });
  }
};

function load(model, device, id) {
  const key = `${model}:${device}`;
  if (!loaded[key]) {
    loaded[key] = pipeline("automatic-speech-recognition", MODELS[model], {
      device,
      dtype: device === "webgpu"
        ? { encoder_model: model === "turbo" ? "fp16" : "fp32", decoder_model_merged: "q4" }
        : "q8",
      progress_callback: progress(id),
    });
  }
  return loaded[key];
}

function loadSpeaker(device, id) {
  if (!speaker) {
    speaker = (async () => {
      const processor = await AutoProcessor.from_pretrained(SPEAKER_MODEL, { progress_callback: progress(id) });
      let model;
      try {
        model = await AutoModel.from_pretrained(SPEAKER_MODEL, { device: device === "webgpu" ? "webgpu" : "wasm", dtype: "fp32", progress_callback: progress(id) });
      } catch (e) {
        model = await AutoModel.from_pretrained(SPEAKER_MODEL, { device: "wasm", dtype: "fp32", progress_callback: progress(id) });
      }
      return { processor, model };
    })();
  }
  return speaker;
}

const language = (code) => (code === "auto" ? undefined : (LANGUAGES[code] || code));

async function embedOne(audio) {
  const { processor, model } = await speaker;
  const out = await model(await processor(audio));
  const t = out.embeddings || out.embedding || Object.values(out)[0];
  const v = Array.from(t.data);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  const fail = (e) => self.postMessage({ type: "error", id, message: String((e && e.message) || e) });

  if (data.type === "load") {
    try { await load(data.model, data.device, id); self.postMessage({ type: "loaded", id }); } catch (e) { fail(e); }
    return;
  }

  if (data.type === "live") {
    // One short window (under 30 s), from the live recorder or the gap check.
    try {
      const asr = await load(data.model, data.device, id);
      const out = await asr(data.audio, { language: language(data.language), task: "transcribe", return_timestamps: true, top_k: 0, do_sample: false });
      const dur = data.audio.length / 16000;
      const chunks = (out.chunks || [{ timestamp: [0, dur], text: out.text || "" }]).map((c) => ({
        s: c.timestamp[0] ?? 0, e: c.timestamp[1] ?? dur, t: c.text.trim(),
      })).filter((c) => c.t);
      self.postMessage({ type: "live-result", id, chunks });
    } catch (e) { fail(e); }
    return;
  }

  if (data.type === "embed") {
    // One speaker embedding per clip (16 kHz audio, cut by the page); null clips stay null.
    try {
      await loadSpeaker(data.device, id);
      const vectors = [];
      for (let i = 0; i < data.clips.length; i++) {
        vectors.push(data.clips[i] ? await embedOne(data.clips[i]) : null);
        if (i % 10 === 9) self.postMessage({ type: "embed-progress", id, done: i + 1, total: data.clips.length });
      }
      self.postMessage({ type: "embed-result", id, vectors });
    } catch (e) { fail(e); }
    return;
  }

  if (data.type !== "run") return;
  const { audio, model, duration } = data;
  try {
    const asr = await load(model, data.device, id);
    self.postMessage({ type: "loaded" });
    const precision = asr.processor.feature_extractor.config.chunk_length / asr.model.config.max_source_positions;
    let windows = 0, current = null;
    const streamer = new WhisperTextStreamer(asr.tokenizer, {
      time_precision: precision,
      skip_prompt: true,
      on_chunk_start: (x) => { current = { s: STEP * windows + x, e: null, t: "" }; },
      callback_function: (text) => {
        if (!current) return;
        current.t += text;
        self.postMessage({ type: "partial", seg: current, position: Math.min(duration, current.s) });
      },
      on_chunk_end: (x) => {
        if (!current) return;
        current.e = STEP * windows + x;
        self.postMessage({ type: "segment", seg: { s: current.s, e: current.e, t: current.t.trim() } });
        current = null;
      },
      on_finalize: () => {
        windows++;
        self.postMessage({ type: "position", position: Math.min(duration, STEP * windows) });
      },
    });
    const out = await asr(audio, {
      language: language(data.language), task: "transcribe", chunk_length_s: CHUNK, stride_length_s: STRIDE,
      return_timestamps: true, top_k: 0, do_sample: false, streamer,
    });
    const chunks = (out.chunks || []).map((c) => ({ s: c.timestamp[0] ?? 0, e: c.timestamp[1] ?? duration, t: c.text.trim() })).filter((c) => c.t);
    self.postMessage({ type: "done", chunks });
  } catch (e) {
    self.postMessage({ type: "error", message: String((e && e.message) || e) });
  }
};
