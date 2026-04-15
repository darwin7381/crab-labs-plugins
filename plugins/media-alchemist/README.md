# media-alchemist

Complete media-to-notes toolkit for Claude Code. Turn any video, audio, or social media content into structured text with transcription, frame analysis, and multi-platform download support.

## Skills included

| Skill | Description |
|---|---|
| `media-to-notes-workflow` | Decision handbook — routes tasks to the right tool based on platform, content type, and depth level |
| `transcribe` | Multi-provider transcription: Whisper API / ElevenLabs Scribe v2 / AssemblyAI (Layer 1) + Gemini audio-aware refinement (Layer 2, always applied) |
| `ffmpeg` | Complete ffmpeg toolkit: frame extraction, audio compression, format conversion, trimming, filmstrips, subtitles, and more |
| `youtube-transcript` | Direct YouTube subtitle extraction via API |

## System dependencies

Install these before using the plugin:

```bash
# Required
brew install ffmpeg        # Video/audio processing engine
brew install yt-dlp        # Video download (YouTube + 1000+ sites)

# Recommended
brew install gallery-dl    # Image/gallery download (389+ sites)
brew install lux           # Chinese platform video download (Bilibili, Douyin, Kuaishou)

# For Chinese social platforms (Xiaohongshu, Douyin, Weibo, etc.)
# See: skills/media-to-notes-workflow/references/PLATFORM-SETUP-NOTES.md
git clone https://github.com/NanmiCoder/MediaCrawler <your-preferred-path>
cd <your-preferred-path> && uv sync && uv run playwright install chromium
```

## API Keys

Set these environment variables for full functionality:

| Key | Required for | Get it at |
|---|---|---|
| `OPENAI_API_KEY` | Whisper API transcription (Layer 1 default) | https://platform.openai.com/api-keys |
| `GEMINI_API_KEY` | Gemini audio-aware refinement (Layer 2) | https://aistudio.google.com/apikey |
| `ELEVENLABS_API_KEY` | ElevenLabs Scribe v2 (multi-speaker, best Chinese) | https://elevenlabs.io → Profile → API Key |
| `ASSEMBLYAI_API_KEY` | AssemblyAI (best English, LeMUR analysis) | https://www.assemblyai.com/dashboard |

Minimum to get started: `OPENAI_API_KEY` + `GEMINI_API_KEY`.

## Installation

```bash
claude plugin marketplace add darwin7381/crab-labs-plugins
claude plugin install media-alchemist@crab-labs-plugins
```

## Usage

After installation, skills are available as:

```
/media-alchemist:transcribe
/media-alchemist:ffmpeg
/media-alchemist:media-to-notes-workflow
/media-alchemist:youtube-transcript
```

Or just describe what you need — the agent reads `media-to-notes-workflow` to route automatically.

## Transcription chain

```
Audio → Layer 1 (choose one):
  ├── ElevenLabs Scribe v2  (best Chinese + speaker diarization)
  ├── Whisper API            (default, cheapest)
  └── AssemblyAI             (best English + LeMUR)
       ↓
     Layer 2 (always apply):
       Gemini refine → add punctuation, fix errors, correct terms
       ↓
     Final .refined.srt
```

## Platform compatibility

- **Claude Code**: Full support (primary target)
- **OpenClaw**: Compatible (`{baseDir}` paths and `openclaw` metadata preserved)
- **Hermes Agent**: Should work (AgentSkills spec compatible)

## License

MIT

## Author

Joey / Crab Labs — https://github.com/darwin7381

## User Configuration

Create `.claude/media-alchemist.local.md` in your project root with your settings:

```yaml
---
# MediaCrawler path (required for Chinese platform crawling)
mediacrawler_path: ~/Development/MediaCrawler

# VPN config (required for youtube-transcript on cloud VPS)
vpn_interface: wg0
vpn_source_ip: 10.x.x.x

# Xiaohongshu domain override (for regions where xiaohongshu.com is blocked)
xiaohongshu_domain: rednote.com
---
```

This file is automatically gitignored (`.local` suffix). Your personal settings stay local.
