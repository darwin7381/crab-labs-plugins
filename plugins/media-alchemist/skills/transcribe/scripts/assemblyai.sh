#!/usr/bin/env bash
# assemblyai.sh — AssemblyAI transcription (Universal-2/3 Pro with fallback)
# No file size limit (uploads to AssemblyAI CDN first)
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  assemblyai.sh <audio-file> [options]

Options:
  --language LANG         Language code e.g. zh, en, ja (default: auto-detect)
  --speakers N            Expected number of speakers (default: auto)
  --no-diarize            Disable speaker diarization
  --format srt|txt|json   Output format (default: json)
  --out PATH              Output file path
  --api-key KEY           AssemblyAI API key (or set ASSEMBLYAI_API_KEY env)

Notes:
  - No file size limit (audio is uploaded to AssemblyAI CDN)
  - Chinese routes to Universal-2 automatically (U3 Pro doesn't support Chinese)
  - speech_models uses fallback chain: ["universal-3-pro", "universal-2"]
EOF
  exit 2
}

[[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

audio="$1"; shift

language=""
speakers=""
diarize=true
out_format="json"
out=""
api_key="${ASSEMBLYAI_API_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --language)    language="${2:-}";   shift 2 ;;
    --speakers)    speakers="${2:-}";   shift 2 ;;
    --no-diarize)  diarize=false;      shift ;;
    --format)      out_format="${2:-}"; shift 2 ;;
    --out)         out="${2:-}";        shift 2 ;;
    --api-key)     api_key="${2:-}";    shift 2 ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

[[ ! -f "$audio" ]] && { echo "[assemblyai] Audio file not found: $audio" >&2; exit 1; }
[[ -z "$api_key" ]] && { echo "[assemblyai] Missing ASSEMBLYAI_API_KEY or --api-key" >&2; exit 1; }

# Default output path
if [[ -z "$out" ]]; then
  base="${audio%.*}"
  out="${base}.assemblyai.${out_format}"
fi

# ─── Step 1: Upload audio to AssemblyAI CDN (no size limit) ───
echo "[assemblyai] Uploading $(du -h "$audio" | cut -f1) to AssemblyAI CDN..." >&2

upload_url=$(curl -sS -X POST "https://api.assemblyai.com/v2/upload" \
  -H "authorization: ${api_key}" \
  --data-binary "@${audio}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['upload_url'])")

[[ -z "$upload_url" ]] && { echo "[assemblyai] Upload failed" >&2; exit 1; }
echo "[assemblyai] Uploaded: ${upload_url:0:60}..." >&2

# ─── Step 2: Build transcript request ───
# CRITICAL: speech_models (PLURAL), not speech_model (singular, deprecated)
# Fallback chain: U3 Pro for supported languages, U2 for everything else
request="{
  \"audio_url\": \"${upload_url}\",
  \"speech_models\": [\"universal-3-pro\", \"universal-2\"],
  \"speaker_labels\": ${diarize}"

if [[ -n "$language" ]]; then
  request="${request}, \"language_code\": \"${language}\""
else
  request="${request}, \"language_detection\": true"
fi

if [[ -n "$speakers" ]]; then
  request="${request}, \"speakers_expected\": ${speakers}"
fi

request="${request}}"

echo "[assemblyai] Creating transcript..." >&2

transcript_id=$(curl -sS -X POST "https://api.assemblyai.com/v2/transcript" \
  -H "authorization: ${api_key}" \
  -H "content-type: application/json" \
  -d "$request" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'error' in d:
    print('ERROR:' + d['error'], file=sys.stderr)
    sys.exit(1)
print(d['id'])
")

[[ "$transcript_id" == ERROR* ]] && exit 1
echo "[assemblyai] Transcript ID: ${transcript_id}" >&2

# ─── Step 3: Poll until complete ───
echo "[assemblyai] Waiting for transcription..." >&2

max_polls=120  # 10 minutes max (5s intervals)
poll=0
while [[ $poll -lt $max_polls ]]; do
  sleep 5
  result=$(curl -sS "https://api.assemblyai.com/v2/transcript/${transcript_id}" \
    -H "authorization: ${api_key}")

  status=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

  case "$status" in
    completed)
      echo "[assemblyai] Transcription complete." >&2
      break
      ;;
    error)
      err=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))")
      echo "[assemblyai] ERROR: ${err}" >&2
      exit 1
      ;;
    *)
      poll=$((poll + 1))
      ;;
  esac
done

if [[ $poll -ge $max_polls ]]; then
  echo "[assemblyai] Timeout waiting for transcription" >&2
  exit 1
fi

# ─── Step 4: Extract and format output ───
model_used=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('speech_model_used','?'))")
echo "[assemblyai] Model used: ${model_used}" >&2

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
utterances = d.get('utterances') or []
words = d.get('words') or []

def ms_to_srt(ms):
    s = ms // 1000
    m = s // 60
    h = m // 60
    ms_rem = ms % 1000
    return f'{h:02d}:{m%60:02d}:{s%60:02d},{ms_rem:03d}'

# If utterances exist (diarization), use those
if utterances:
    for i, u in enumerate(utterances, 1):
        start = ms_to_srt(u['start'])
        end = ms_to_srt(u['end'])
        speaker = u.get('speaker', '?')
        print(f'{i}')
        print(f'{start} --> {end}')
        print(f'[Speaker {speaker}] {u[\"text\"]}')
        print()
# Otherwise segment by words with ~5s chunks
elif words:
    idx = 1
    chunk = []
    chunk_start = None
    for w in words:
        if chunk_start is None:
            chunk_start = w['start']
        chunk.append(w['text'])
        if w['end'] - chunk_start >= 5000 or len(' '.join(chunk)) > 80:
            start = ms_to_srt(chunk_start)
            end = ms_to_srt(w['end'])
            print(f'{idx}')
            print(f'{start} --> {end}')
            print(' '.join(chunk))
            print()
            idx += 1
            chunk = []
            chunk_start = None
    if chunk:
        start = ms_to_srt(chunk_start)
        end = ms_to_srt(words[-1]['end'])
        print(f'{idx}')
        print(f'{start} --> {end}')
        print(' '.join(chunk))
        print()
" > "$out"
    ;;
esac

echo "[assemblyai] Done → ${out}" >&2
echo "$out"
