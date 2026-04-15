# Changelog

## v1.0.0 (2026-04-15)

Initial release.

### Skills
- **media-to-notes-workflow**: Decision handbook for media processing tasks
- **transcribe**: Multi-provider transcription (Whisper/ElevenLabs/AssemblyAI + Gemini refine)
- **ffmpeg**: Complete ffmpeg toolkit (frame extraction, compression, conversion, trimming, subtitles)
- **youtube-transcript**: YouTube subtitle extraction

### Scripts
- `transcribe.sh` — Whisper API transcription with auto-compression for 25MB limit
- `refine.sh` — Gemini audio-aware refinement with 5-model fallback chain
- `elevenlabs.sh` — ElevenLabs Scribe v2 with keyterms and speaker diarization
- `assemblyai.sh` — AssemblyAI with Universal-3 Pro / Universal-2 fallback
- `frame.sh` — Single frame extraction from video

### References
- STT provider test log (Whisper vs ElevenLabs vs AssemblyAI benchmark)
- Platform setup notes (MediaCrawler, gallery-dl, lux configuration)
