#!/usr/bin/env bash
# elevenlabs.sh — ElevenLabs Scribe v2 transcription
# Max file size: 3GB (direct upload), no compression needed
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  elevenlabs.sh <audio-file> [options]

Options:
  --language LANG         ISO 639-3 code e.g. zho, eng, jpn (default: auto-detect)
  --speakers N            Expected number of speakers (default: auto)
  --no-diarize            Disable speaker diarization
  --keyterms T1,T2,...    Comma-separated terms to boost recognition (max 1000, each <50 chars)
  --format srt|txt|json   Output format (default: json)
  --out PATH              Output file path
  --api-key KEY           ElevenLabs API key (or set ELEVENLABS_API_KEY env)

Notes:
  - Max 3GB file size (direct upload, no compression needed)
  - keyterms significantly improves proper noun recognition
  - Word-level timestamps included by default
  - Max 32 speakers for diarization
EOF
  exit 2
}

[[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

audio="$1"; shift

language=""
speakers=""
diarize=true
keyterms=""
out_format="json"
out=""
api_key="${ELEVENLABS_API_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --language)    language="${2:-}";   shift 2 ;;
    --speakers)    speakers="${2:-}";   shift 2 ;;
    --no-diarize)  diarize=false;      shift ;;
    --keyterms)    keyterms="${2:-}";   shift 2 ;;
    --format)      out_format="${2:-}"; shift 2 ;;
    --out)         out="${2:-}";        shift 2 ;;
    --api-key)     api_key="${2:-}";    shift 2 ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

[[ ! -f "$audio" ]] && { echo "[elevenlabs] Audio file not found: $audio" >&2; exit 1; }
[[ -z "$api_key" ]] && { echo "[elevenlabs] Missing ELEVENLABS_API_KEY or --api-key" >&2; exit 1; }

# Default output path
if [[ -z "$out" ]]; then
  base="${audio%.*}"
  out="${base}.elevenlabs.${out_format}"
fi

# ─── Build curl command ───
echo "[elevenlabs] Transcribing $(du -h "$audio" | cut -f1) with Scribe v2..." >&2

curl_args=(
  -sS -X POST "https://api.elevenlabs.io/v1/speech-to-text"
  -H "xi-api-key: ${api_key}"
  -F "model_id=scribe_v2"
  -F "timestamps_granularity=word"
  -F "tag_audio_events=true"
  -F "file=@${audio}"
)

if [[ "$diarize" == "true" ]]; then
  curl_args+=(-F "diarize=true")
  if [[ -n "$speakers" ]]; then
    curl_args+=(-F "num_speakers=${speakers}")
  fi
fi

if [[ -n "$language" ]]; then
  curl_args+=(-F "language_code=${language}")
fi

# keyterms: each term as separate -F field (NOT JSON array)
if [[ -n "$keyterms" ]]; then
  IFS=',' read -ra terms <<< "$keyterms"
  for term in "${terms[@]}"; do
    term=$(echo "$term" | xargs)  # trim whitespace
    if [[ ${#term} -ge 50 ]]; then
      echo "[elevenlabs] WARNING: keyterm '${term:0:20}...' exceeds 50 chars, skipping" >&2
      continue
    fi
    curl_args+=(-F "keyterms=${term}")
  done
fi

# ─── Call API (synchronous, no polling needed) ───
result=$(curl "${curl_args[@]}")

# ─── Check for errors ───
has_error=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'detail' in d:
    print(d['detail'].get('message', str(d['detail'])), file=sys.stderr)
    print('yes')
else:
    print('no')
" 2>&1)

if echo "$has_error" | grep -q "^yes"; then
  echo "[elevenlabs] ERROR: $(echo "$has_error" | head -1)" >&2
  exit 1
fi

# ─── Extract metadata ───
echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
lang = d.get('language_code','?')
prob = d.get('language_probability','?')
words = d.get('words') or []
speakers = set(w.get('speaker_id','') for w in words if w.get('speaker_id'))
print(f'Language: {lang} (prob: {prob})', file=sys.stderr)
print(f'Words: {len(words)}', file=sys.stderr)
print(f'Speakers: {len(speakers)}', file=sys.stderr)
" 2>&1 >&2

# ─── Format output ───
case "$out_format" in
  json)
    echo "$result" > "$out"
    ;;
  txt)
    echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''))" > "$out"
    ;;
  srt)
    echo "$result" | python3 -c "
import sys, json

d = json.load(sys.stdin)
words = d.get('words') or []

def s_to_srt(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'

# Group words into ~5s / ~40 char segments
idx = 1
chunk_words = []
chunk_start = None
current_speaker = None

for w in words:
    if w.get('type') != 'word':
        continue

    wstart = w.get('start', 0)
    wend = w.get('end', 0)
    speaker = w.get('speaker_id', '')

    if chunk_start is None:
        chunk_start = wstart
        current_speaker = speaker

    # Break on speaker change, time limit, or char limit
    text_so_far = ''.join(cw['text'] for cw in chunk_words)
    should_break = (
        (speaker and speaker != current_speaker) or
        (wend - chunk_start >= 5.0 and len(chunk_words) > 0) or
        (len(text_so_far) > 40 and len(chunk_words) > 0)
    )

    if should_break and chunk_words:
        start_t = s_to_srt(chunk_start)
        end_t = s_to_srt(chunk_words[-1].get('end', 0))
        text = ''.join(cw['text'] for cw in chunk_words)
        prefix = f'[Speaker {current_speaker}] ' if current_speaker else ''
        print(f'{idx}')
        print(f'{start_t} --> {end_t}')
        print(f'{prefix}{text}')
        print()
        idx += 1
        chunk_words = []
        chunk_start = wstart
        current_speaker = speaker

    chunk_words.append(w)

# Last chunk
if chunk_words:
    start_t = s_to_srt(chunk_start)
    end_t = s_to_srt(chunk_words[-1].get('end', 0))
    text = ''.join(cw['text'] for cw in chunk_words)
    prefix = f'[Speaker {current_speaker}] ' if current_speaker else ''
    print(f'{idx}')
    print(f'{start_t} --> {end_t}')
    print(f'{prefix}{text}')
    print()
" > "$out"
    ;;
esac

echo "[elevenlabs] Done → ${out}" >&2
echo "$out"
