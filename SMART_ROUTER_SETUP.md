# Smart Model Router Setup

This workflow automatically routes your prompts to **Haiku** (cheap) or **Sonnet** (powerful) based on complexity classification using a local Ollama model.

## How It Works

1. **Webhook receives prompt** → calls `/api/classify` endpoint
2. **Local Ollama (mistral)** classifies prompt as `simple` or `complex` (~1-2s, free)
3. **Routes to agent:**
   - `simple` → `automation` agent (Claude Haiku 3.5 — ~$0.0001 per 1K input tokens)
   - `complex` → `fredrick` agent (Claude Sonnet 4.6 — $0.003 per 1K input tokens)
4. **Haiku automatically falls back to Sonnet** if it times out or fails (configured in openclaw.json)
5. **Response sent back** with routing metadata

## Installation

### 1. Prerequisites

- Ollama running at `http://127.0.0.1:11434` with `mistral` model available
- n8n running at `http://127.0.0.1:5678`
- OpenClaw dashboard at `http://127.0.0.1:7891`

### 2. Import the Workflow into n8n

1. Open n8n dashboard: `http://127.0.0.1:5678`
2. Click **"Workflows"** → **"Import from file"**
3. Select `data/n8n-smart-router.workflow.json`
4. Click **"Import"**
5. The workflow will appear in your workflows list as **"Smart Model Router"**

### 3. Activate the Workflow

1. Open **"Smart Model Router"** in n8n
2. Click the **"Activate"** toggle (top right)
3. The webhook is now live at: `http://127.0.0.1:5678/webhook/smart-router`

### 4. Test It

```bash
# Test simple prompt → should route to Haiku
curl -X POST http://127.0.0.1:5678/webhook/smart-router \
  -H "Content-Type: application/json" \
  -d '{"message": "hey whats up", "sessionKey": "agent:fredrick:main"}'

# Test complex prompt → should route to Sonnet
curl -X POST http://127.0.0.1:5678/webhook/smart-router \
  -H "Content-Type: application/json" \
  -d '{"message": "refactor my React component to use hooks", "sessionKey": "agent:fredrick:main"}'
```

## Cost Savings

Estimated monthly savings (assuming 50% of prompts are "simple"):

- **Before:** 100 prompts × $0.003 per Sonnet = ~$0.30
- **After:** 50 prompts × $0.0001 Haiku + 50 × $0.003 Sonnet = ~$0.155
- **Savings:** ~50% reduction on token costs

## Architecture Diagram

```
User Message
    ↓
[Webhook: /webhook/smart-router]
    ↓
[Classify via /api/classify]
    ↓
    ├─ Simple → automation (Haiku) ← [falls back to Sonnet if needed]
    └─ Complex → fredrick (Sonnet)
    ↓
[Response + Routing Metadata]
```

## Files Included

- `data/classifier.js` — Local Ollama-based complexity classifier
- `data/n8n-smart-router.workflow.json` — n8n workflow definition
- `server.js` (updated) — Added `/api/classify` endpoint

## Monitoring

To see routing decisions in real-time:

```bash
# Watch n8n execution logs
curl http://127.0.0.1:5678/api/v1/executions?sort=startTime&order=DESC&limit=10
```

Each execution will include `routingDecision` showing which model was chosen and why.

## Customization

To adjust the classifier behavior:

1. Edit `data/classifier.js` line 14 (SYSTEM prompt) to change what counts as "simple" vs "complex"
2. Edit line 22 to change the Ollama model (e.g., `qwen2.5:14b` for higher accuracy)
3. Restart the dashboard server: `launchctl restart ai.openclaw.dashboard`
