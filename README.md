# 🦞 OpenClaw Dashboard

Local control center for OpenClaw with audio → transcription → LLM → Notion pipeline.

## Quick Start

```bash
npm install
npm start
# → http://127.0.0.1:7891
```

## Audio Pipeline Setup

### 1. Prerequisites

- **ffmpeg** (required): `brew install ffmpeg`
- **Node.js 18+** (with built-in fetch)

### 2. API Keys

Create a `.env` file (or export environment variables):

```bash
# Required for transcription
export OPENAI_API_KEY="sk-your-key"

# Optional: Notion integration
export NOTION_API_KEY="secret_your-token"
export NOTION_DATABASE_ID="your-database-id"
```

### 3. Notion Setup (Optional)

1. Create a [Notion Integration](https://www.notion.so/my-integrations)
2. Share your target database with the integration
3. Copy the database ID from the URL: `notion.so/{workspace}/{DATABASE_ID}?v=...`
4. Add the integration token and database ID to your env

## Features

### Voice Notes Tab 🎙️

- **Record**: Click to start/stop browser-based audio recording
- **Transcribe**: Automatic transcription via OpenAI Whisper API
- **Structure**: LLM rewrites transcript into structured notes (title, bullets, summary, tags)
- **Save**: Raw + clean transcripts saved to `data/transcripts/`
- **Notion**: Auto-push structured notes to Notion database

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/record` | POST | Upload audio blob (body: raw audio) |
| `/api/process` | POST | Full pipeline: transcribe → rewrite → save → notion |
| `/api/transcripts` | GET | List all saved transcripts |
| `/api/transcript/:name` | GET | Get specific transcript content |
| `/api/audio-config` | GET | Check pipeline configuration status |

## File Structure

```
openclaw-dashboard/
├── server.js          # Backend with audio pipeline routes
├── index.html         # Dashboard UI
├── data/
│   └── transcripts/   # Saved transcripts
│       ├── transcript_*_raw.txt    # Raw whisper output
│       └── transcript_*_clean.json # Structured notes
├── .env.example       # Configuration template
└── README.md
```

## Running with env vars

```bash
OPENAI_API_KEY=sk-... NOTION_API_KEY=secret_... NOTION_DATABASE_ID=abc123 node server.js
```

Or use a process manager like pm2:

```bash
pm2 start server.js --name openclaw-dashboard
```
