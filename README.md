# Crab Labs Plugins

Official plugin marketplace for [Crab Labs](https://github.com/darwin7381). AI-powered tools for media processing, transcription, and content analysis.

Built for [Claude Code](https://claude.ai/code), compatible with [OpenClaw](https://openclaw.ai) and [Hermes Agent](https://github.com/NousResearch/hermes-agent).

## Available Plugins

| Plugin | Description | Version |
|---|---|---|
| [media-alchemist](./plugins/media-alchemist/) | Complete media-to-notes toolkit: multi-provider transcription, video/audio processing, multi-platform download | v1.0.0 |

## Installation

### Claude Code

```bash
claude plugin marketplace add darwin7381/crab-labs-plugins
claude plugin install media-alchemist@crab-labs-plugins
```

### OpenClaw

Skills inside each plugin follow the [AgentSkills](https://agentskills.io) specification. Copy the `skills/` directory from any plugin into your OpenClaw workspace.

### Hermes Agent

Same as OpenClaw — copy the `skills/` directory into your Hermes skills path.

## What's inside media-alchemist

**4 skills:**

- **media-to-notes-workflow** — Decision handbook that routes tasks to the right tool based on platform, content type, and depth level
- **transcribe** — Multi-provider transcription with 3 STT engines (Whisper / ElevenLabs Scribe v2 / AssemblyAI) as Layer 1 + Gemini audio-aware refinement as Layer 2
- **ffmpeg** — Complete ffmpeg toolkit: frame extraction, audio compression, format conversion, trimming, filmstrips, subtitles, and more
- **youtube-transcript** — YouTube subtitle extraction via API

**System tools used** (install separately):

- `ffmpeg` — Video/audio processing engine
- `yt-dlp` — Video download (YouTube + 1000+ sites)
- `gallery-dl` — Image/gallery download (389+ sites)
- `lux` — Chinese platform video download (Bilibili, Douyin, Kuaishou)
- `MediaCrawler` — Chinese social platform crawler (Xiaohongshu, Douyin, Weibo, etc.)

See [media-alchemist/README.md](./plugins/media-alchemist/README.md) for full setup instructions, API key requirements, and configuration guide.

## About Crab Labs

Crab Labs builds AI agent infrastructure and tools. Founded by [Joey](https://github.com/darwin7381).

## License

MIT
