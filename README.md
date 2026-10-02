# Transcriber

Local transcription of audio and video files with whisper.cpp, through a page in the browser.

## Start

Double-click **Transcriber** in `~/Applications`. It starts a small server on `http://127.0.0.1:8765/` (if one isn't already running) and opens the page. The server stops itself after 15 minutes with no page open and nothing running, or immediately via "Stop the transcriber" at the foot of the page.

To rebuild the app after moving this folder: `./make-app.sh`.

## Use

1. Drop a file on the page, click to choose one, or paste a path (in Finder, ⌥⌘C copies a file's path).
   A dropped file is located through Spotlight so the transcript can be saved beside it. If Spotlight can't find it, the file is copied in for the run and deleted afterwards, and the transcript goes to the last output folder used (or ~/Downloads).
   The page then fills in the title, output name, names and terms, and language from the file's tags (title, artist, date, URL, audio language: present in yt-dlp downloads, podcasts and many recordings) or, failing those, from a cleaned-up filename. With "Start as soon as a file is chosen" ticked (the default), transcription starts straight away with those settings; untick it to review them first.
2. Choose the model (Turbo: large-v3-turbo, about 20× real time; Base: faster, rougher), the language, title and output name.
3. Optional:
   - **Names and terms**: passed to whisper as `--prompt`, which improves the spelling of proper nouns. Filled from the file's name and tags; anything typed by hand is kept and the new file's terms added.
   - **Find and replace**: one `wrong => right` per line (`->` or a tab also work). Whole words, case-sensitive. Applied to all three files.
   - **Section headings**: one `time heading` per line, e.g. `12:30 First speaker`. Each heading goes before the sentence starting nearest that time. Without them the transcript sits under `## Transcript`.
4. Transcribe. The page shows the pipeline stage, the waveform filling in as whisper works through it, recognised speech, speed, time left and the text as it arrives.
5. When it finishes, the summary shows timing and speed, word counts, pace, silences measured from the audio, a words-per-minute chart, frequent words and capitalised words to check as possible names. Clicking a name adds it to Find and replace. "Apply current corrections and headings to these files" rewrites the outputs from the stored recognition, without re-transcribing.

The find/replace list, model, language and the auto-start setting are remembered in the browser between sessions. Names and terms are per recording.

Audio is extracted first (`ffmpeg -map 0:a:0 -vn`, 16 kHz mono WAV) without decoding any video; whisper-cli can't read video containers itself. This takes a few seconds even for a long lecture.

## Output

Written to the output folder (default: the recording's folder), never overwriting: `name.md`, `name.srt`, `name.txt` (or `name-2.*` and so on).

The `.md` has a title, a source line with the duration and any file metadata (creator, date, URL), a method note (model, language, date, whether a prompt and corrections were used), section headings, and paragraphs that break at the first sentence end after about 75 seconds, each starting with a bold timestamp such as `**[0:04:07]**`.

## Files

- `transcriber.py`: server and pipeline (Python standard library only; runs on Homebrew or system `python3`).
- `index.html`: the page.
- `launch.sh`: starts the server if needed and opens the page (`TRANSCRIBER_NO_OPEN=1` skips opening; `TRANSCRIBER_PORT` changes the port).
- `make-app.sh`: builds `~/Applications/Transcriber.app`, an AppleScript applet that runs `launch.sh`.

Server log: `~/Library/Logs/Transcriber.log`.

## Requirements

- `/opt/homebrew/bin/ffmpeg`, `ffprobe`, `whisper-cli`
- Models in `~/Documents/whisper-models/`: `ggml-large-v3-turbo.bin`, `ggml-base.bin`

The server listens on 127.0.0.1 only. It rejects requests with a foreign `Host` header, and POST/PUT requests without its own `X-Transcriber` header, so other web pages can't drive it.
