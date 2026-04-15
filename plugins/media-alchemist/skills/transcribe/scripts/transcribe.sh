#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'EOF'
Usage:
  transcribe.sh <audio-file> [options]

── First layer (Whisper) ─────────────────────────────────────────────
  --mode local|api|auto   Backend (default: auto)
  --model MODEL           Model size: tiny/base/small/medium/large (local)
                          or whisper-1 (api)
  --language LANG         Language hint e.g. zh, en, ja (default: auto-detect)
  --prompt TEXT           Hint for proper nouns / terminology
  --task transcribe|translate   Default: transcribe
  --format txt|srt|json   Output format (default: txt)
  --out PATH              Output file path

── Second layer (Gemini refinement) ──────────────────────────────────
  --refine                Enable LLM audio-aware refinement pass
  --refine-model MODEL    Gemini model (default: gemini-2.5-flash)
  --refine-mode MODE      Language behavior (default: preserve)
                            preserve         keep all original languages as spoken
                            <lang>           translate all (e.g. zh, en, ja, ko, fr)
                            bilingual-<lang> original + translation (e.g. bilingual-zh)
  --refine-key KEY        Gemini API key (or set GEMINI_API_KEY env)
EOF
  exit 2
}

[[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

in="$1"; shift || true

# ── Whisper args
mode="auto"
model=""
language=""
prompt_hint=""
task="transcribe"
format="txt"
out=""

# ── Refine args
refine=false
refine_model="gemini-2.5-flash"
refine_mode="preserve"
refine_key="${GEMINI_API_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)         mode="${2:-}";         shift 2 ;;
    --model)        model="${2:-}";        shift 2 ;;
    --language)     language="${2:-}";     shift 2 ;;
    --prompt)       prompt_hint="${2:-}";  shift 2 ;;
    --task)         task="${2:-}";         shift 2 ;;
    --format)       format="${2:-}";       shift 2 ;;
    --out)          out="${2:-}";          shift 2 ;;
    --refine)       refine=true;           shift   ;;
    --refine-model) refine_model="${2:-}"; shift 2 ;;
    --refine-mode)  refine_mode="${2:-}";  shift 2 ;;
    --refine-key)   refine_key="${2:-}";   shift 2 ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

[[ ! -f "$in" ]] && { echo "File not found: $in" >&2; exit 1; }

# Refine requires SRT format
if $refine && [[ "$format" != "srt" ]]; then
  echo "[transcribe] --refine requires --format srt, switching automatically." >&2
  format="srt"
fi

# Resolve auto mode (API-first: use OpenAI API when key available, fallback to local)
if [[ "$mode" == "auto" ]]; then
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    mode="api"
  elif command -v whisper &>/dev/null; then
    mode="local"
  else
    echo "No OPENAI_API_KEY set and no local whisper found." >&2
    echo "Set OPENAI_API_KEY for cloud mode (recommended)." >&2
    echo "Or install local: pip3 install openai-whisper --break-system-packages" >&2
    exit 1
  fi
fi

# Default output path
if [[ -z "$out" ]]; then
  base="${in%.*}"
  out="${base}.${format}"
fi
mkdir -p "$(dirname "$out")"

# ─────────────────────────────────────────
# FIRST LAYER: Whisper
# ─────────────────────────────────────────

if [[ "$mode" == "local" ]]; then
  [[ -z "$model" ]] && model="large-v3"
  tmpdir=$(mktemp -d)

  # ── Device selection: MPS (Apple Silicon) > CPU
  # IMPORTANT: whisper CLI defaults to --device cpu and has no way to force FP32 on MPS.
  # large-v3 on MPS with FP16 produces NaN (PyTorch MPS bug). Must use Python API with
  # model.float() + fp16=False to get correct results at 4x CPU speed.
  use_mps=false
  if python3 -c "import torch; exit(0 if torch.backends.mps.is_available() else 1)" 2>/dev/null; then
    use_mps=true
  fi

  # ── Always use Python API for local mode (CLI retired)
  # Reason: whisper CLI has no --fp32 flag. On MPS it forces FP16 which causes NaN with large-v3.
  # On CPU it works but is identical to the Python API path. Unified Python path = consistent,
  # stable, and avoids any CLI quirks on both MPS and CPU.
  device="cpu"
  [[ "$use_mps" == "true" ]] && device="mps"

  py_task="transcribe"
  [[ "$task" == "translate" ]] && py_task="translate"
  py_lang="None"
  [[ -n "$language" ]] && py_lang="\"${language}\""
  py_prompt="None"
  [[ -n "$prompt_hint" ]] && py_prompt="\"${prompt_hint}\""

  python3 - <<PYEOF
import whisper, json, sys, os

device = "${device}"
model = whisper.load_model("${model}", device=device)
if device == "mps":
    model = model.float()  # Force FP32 on MPS — avoids PyTorch MPS NaN bug with large-v3

result = model.transcribe(
    "${in}",
    fp16=False,  # Always FP32 for correctness (MPS requires it; CPU ignores it gracefully)
    task="${py_task}",
    language=${py_lang},
    initial_prompt=${py_prompt},
    verbose=True,
)

fmt = "${format}"
outpath = "${tmpdir}/output"

if fmt == "srt":
    from whisper.utils import WriteSRT
    with open(outpath + ".srt", "w", encoding="utf-8") as f:
        writer = WriteSRT("${tmpdir}")
        writer.write_result(result, f, {})
elif fmt == "json":
    with open(outpath + ".json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
else:
    with open(outpath + ".txt", "w", encoding="utf-8") as f:
        f.write(result["text"])
PYEOF

  base_name="output"

  case "$format" in
    srt)  src="$tmpdir/${base_name}.srt" ;;
    json) src="$tmpdir/${base_name}.json" ;;
    *)    src="$tmpdir/${base_name}.txt" ;;
  esac

  if [[ -f "$src" ]]; then
    cp "$src" "$out"
    rm -rf "$tmpdir"
  else
    echo "Error: output file not found in $tmpdir" >&2
    ls "$tmpdir" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

elif [[ "$mode" == "api" ]]; then
  [[ -z "${OPENAI_API_KEY:-}" ]] && { echo "Missing OPENAI_API_KEY" >&2; exit 1; }
  [[ -z "$model" ]] && model="whisper-1"

  # ── Auto-compress if file exceeds OpenAI 25MB limit ──
  max_bytes=25000000
  file_bytes=$(stat -f%z "$in" 2>/dev/null || stat -c%s "$in" 2>/dev/null || echo 0)
  if [[ "$file_bytes" -gt "$max_bytes" ]]; then
    echo "[transcribe] File is ${file_bytes} bytes (>${max_bytes}). Compressing to mono 64k mp3 for API upload..." >&2
    compressed_tmp=$(mktemp /tmp/transcribe_compressed_XXXXXX.mp3)
    ffmpeg -y -i "$in" -ac 1 -ar 16000 -b:a 64k "$compressed_tmp" 2>/dev/null
    compressed_size=$(stat -f%z "$compressed_tmp" 2>/dev/null || stat -c%s "$compressed_tmp" 2>/dev/null || echo 0)
    echo "[transcribe] Compressed: ${compressed_size} bytes" >&2
    in="$compressed_tmp"
    _cleanup_compressed=true
  fi

  case "$format" in
    srt)  response_format="srt" ;;
    json) response_format="verbose_json" ;;
    *)    response_format="text" ;;
  esac

  curl_args=(-sS https://api.openai.com/v1/audio/transcriptions
    -H "Authorization: Bearer $OPENAI_API_KEY"
    -F "file=@${in}"
    -F "model=${model}"
    -F "response_format=${response_format}"
  )
  [[ "$task" == "translate" ]] && curl_args+=(-F "language=en")
  [[ -n "$language" && "$task" != "translate" ]] && curl_args+=(-F "language=${language}")
  [[ -n "$prompt_hint" ]] && curl_args+=(-F "prompt=${prompt_hint}")

  curl "${curl_args[@]}" > "$out"

  # Clean up compressed temp file if created (skip if refine needs it)
  _skip_cleanup=false
  if $refine && [[ "${_cleanup_compressed:-}" == "true" && -f "${compressed_tmp:-}" ]]; then
    _skip_cleanup=true
  fi
  if [[ "${_cleanup_compressed:-}" == "true" && "${_skip_cleanup}" == "false" && -f "${compressed_tmp:-}" ]]; then
    rm -f "$compressed_tmp"
  fi

else
  echo "Unknown mode: $mode (use local, api, or auto)" >&2
  exit 1
fi

echo "[transcribe] Whisper output → ${out}" >&2

# ─────────────────────────────────────────
# SECOND LAYER: Gemini refinement (optional)
# ─────────────────────────────────────────

if $refine; then
  [[ -z "$refine_key" ]] && { echo "[refine] Missing GEMINI_API_KEY or --refine-key" >&2; exit 1; }

  refined_out="${out%.srt}.refined.srt"

  "${SCRIPT_DIR}/refine.sh" "$in" "$out" \
    --model "$refine_model" \
    --mode  "$refine_mode" \
    --out   "$refined_out" \
    --api-key "$refine_key"

  if [[ "${_cleanup_compressed:-}" == "true" && -f "${compressed_tmp:-}" ]]; then
    rm -f "$compressed_tmp"
  fi

  echo "$refined_out"
else
  echo "$out"
fi
