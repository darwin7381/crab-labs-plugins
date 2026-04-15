---
name: ffmpeg
description: >
  Complete ffmpeg toolkit for video and audio processing. Use when asked to extract frames,
  compress audio, convert formats, trim clips, create filmstrips, get media info, add subtitles,
  merge files, or any video/audio manipulation. Covers all common ffmpeg operations with
  ready-to-use scripts and direct commands.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎬",
        "requires": { "bins": ["ffmpeg"] },
      },
  }
---

# ffmpeg Toolkit

Complete video and audio processing toolkit. All scripts are in `{baseDir}/scripts/`.

---

## 1. Frame Extraction

### Single frame at timestamp

```bash
{baseDir}/scripts/frame.sh video.mp4 --time 00:01:30 --out frame.jpg
```

### Single frame by index

```bash
{baseDir}/scripts/frame.sh video.mp4 --index 0 --out first-frame.png
```

### Batch: one frame per second

```bash
ffmpeg -i video.mp4 -vf "fps=1" frames/frame_%04d.png
```

### Batch: one frame every N seconds

```bash
# One frame every 10 seconds
ffmpeg -i video.mp4 -vf "fps=1/10" frames/frame_%04d.png
```

### Keyframes only (I-frames)

```bash
ffmpeg -i video.mp4 -vf "select=eq(pict_type\,I)" -vsync vfr keyframes/kf_%04d.png
```

### Filmstrip / contact sheet

```bash
# 10 frames across, each 160px wide
ffmpeg -i video.mp4 -vf "fps=1/10,scale=160:-1,tile=10x1" filmstrip.png
```

### Grid thumbnail (e.g. 4x4)

```bash
ffmpeg -i video.mp4 -vf "fps=1/30,scale=320:-1,tile=4x4" grid.png
```

---

## 2. Audio Operations

### Extract audio from video

```bash
# Extract as m4a (keeps original codec if AAC)
ffmpeg -i video.mp4 -vn -acodec copy audio.m4a

# Extract and convert to mp3
ffmpeg -i video.mp4 -vn -acodec libmp3lame -q:a 2 audio.mp3
```

### Compress audio (for Whisper API 25MB limit)

```bash
# Mono 64k mp3 — typically shrinks 78%+ (e.g. 29MB → 6MB)
ffmpeg -i input.m4a -ac 1 -ar 16000 -b:a 64k compressed.mp3
```

### Get audio duration

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 audio.m4a
```

---

## 3. Video Info / Metadata

### Full media info

```bash
ffprobe -v quiet -print_format json -show_format -show_streams video.mp4
```

### Duration only (seconds)

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 video.mp4
```

### Dimensions (width x height)

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 video.mp4
```

### Codec info

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 video.mp4
```

### Frame count

```bash
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 video.mp4
```

---

## 4. Trimming / Cutting

### Cut a clip (start time + duration)

```bash
# 5 second clip starting at 1:00
ffmpeg -ss 00:01:00 -i video.mp4 -t 5 -c copy clip.mp4
```

### Cut a clip (start to end)

```bash
# From 1:00 to 1:30
ffmpeg -ss 00:01:00 -to 00:01:30 -i video.mp4 -c copy clip.mp4
```

### Remove first N seconds

```bash
ffmpeg -ss 00:00:10 -i video.mp4 -c copy trimmed.mp4
```

---

## 5. Format Conversion

### Video format conversion

```bash
# MP4 to WebM
ffmpeg -i input.mp4 -c:v libvpx-vp9 -c:a libopus output.webm

# MKV to MP4 (stream copy, fast)
ffmpeg -i input.mkv -c copy output.mp4

# MOV to MP4
ffmpeg -i input.mov -c:v libx264 -c:a aac output.mp4
```

### Audio format conversion

```bash
# WAV to MP3
ffmpeg -i input.wav -c:a libmp3lame -q:a 2 output.mp3

# M4A to WAV
ffmpeg -i input.m4a -c:a pcm_s16le output.wav

# Any to M4A (AAC)
ffmpeg -i input.mp3 -c:a aac -b:a 128k output.m4a
```

---

## 6. Scaling / Resizing

### Scale to specific width (keep aspect ratio)

```bash
ffmpeg -i video.mp4 -vf "scale=1280:-2" resized.mp4
```

### Scale to specific height

```bash
ffmpeg -i video.mp4 -vf "scale=-2:720" resized.mp4
```

### Scale to fit within bounds

```bash
# Fit within 1920x1080, keep aspect ratio
ffmpeg -i video.mp4 -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" resized.mp4
```

---

## 7. Merging / Concatenating

### Concat videos (same codec)

```bash
# Create file list
echo "file 'part1.mp4'" > list.txt
echo "file 'part2.mp4'" >> list.txt
echo "file 'part3.mp4'" >> list.txt

# Concat
ffmpeg -f concat -safe 0 -i list.txt -c copy merged.mp4
```

### Merge audio + video

```bash
ffmpeg -i video.mp4 -i audio.m4a -c:v copy -c:a copy -shortest merged.mp4
```

---

## 8. Subtitles

### Burn subtitles into video (hardcode)

```bash
ffmpeg -i video.mp4 -vf "subtitles=subs.srt" -c:a copy output.mp4
```

### Burn with style

```bash
ffmpeg -i video.mp4 -vf "subtitles=subs.srt:force_style='FontSize=24,PrimaryColour=&H00FFFFFF'" -c:a copy output.mp4
```

### Add subtitle track (softcode)

```bash
ffmpeg -i video.mp4 -i subs.srt -c copy -c:s mov_text output.mp4
```

---

## 9. Other Common Operations

### Create GIF from video

```bash
# 10 second GIF starting at 0:30, 320px wide, 10fps
ffmpeg -ss 00:00:30 -t 10 -i video.mp4 -vf "fps=10,scale=320:-1" output.gif
```

### Remove audio from video

```bash
ffmpeg -i video.mp4 -an -c:v copy silent.mp4
```

### Speed up / slow down

```bash
# 2x speed
ffmpeg -i video.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" fast.mp4

# 0.5x speed (slow motion)
ffmpeg -i video.mp4 -filter:v "setpts=2.0*PTS" -filter:a "atempo=0.5" slow.mp4
```

### Rotate video

```bash
# 90 degrees clockwise
ffmpeg -i video.mp4 -vf "transpose=1" rotated.mp4

# 180 degrees
ffmpeg -i video.mp4 -vf "transpose=1,transpose=1" rotated.mp4
```

---

## Common Flags Reference

| Flag | Meaning |
|---|---|
| `-y` | Overwrite output without asking |
| `-hide_banner` | Hide ffmpeg version info |
| `-loglevel error` | Only show errors |
| `-c copy` | Stream copy (fast, no re-encode) |
| `-c:v libx264` | Encode video as H.264 |
| `-c:a aac` | Encode audio as AAC |
| `-vn` | No video (audio only) |
| `-an` | No audio (video only) |
| `-ss HH:MM:SS` | Seek to timestamp |
| `-t N` | Duration in seconds |
| `-to HH:MM:SS` | End timestamp |
| `-vf "filter"` | Video filter |
| `-frames:v 1` | Output 1 frame |

---

## Decision Guide for Agent

| Task | Command |
|---|---|
| 「抽一張截圖」 | frame.sh or `-frames:v 1` |
| 「每秒抽一幀分析」 | `fps=1` batch extraction |
| 「做個縮圖牆」 | `tile` filter |
| 「壓縮音訊給 Whisper」 | mono 64k compression |
| 「這影片多長」 | `ffprobe` duration |
| 「剪一段 clip」 | `-ss` + `-t` or `-to` |
| 「轉格式」 | direct conversion |
| 「加字幕」 | `subtitles` filter |
| 「做 GIF」 | GIF pipeline |
| 「影片資訊」 | `ffprobe` JSON output |
