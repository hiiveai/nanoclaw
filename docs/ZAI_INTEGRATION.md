# Z.ai Integration Guide

## Overview

This document describes how NanoClaw was integrated with Z.ai's GLM models instead of Anthropic's Claude models.

## The Problem

NanoClaw was using the `@anthropic-ai/claude-agent-sdk` which performs model validation by calling `/v1/models` before making API requests. When configured to use Z.ai's Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic`), the SDK received only GLM models (glm-4.5, glm-4.6, glm-4.7, glm-5) and rejected all requests because it expected Claude model names.

Error: `There's an issue with the selected model (X). It may not exist or you may not have access to it.`

## Initial Attempts

1. **Setting ANTHROPIC_MODEL environment variable** - Failed, SDK still validated the model
2. **Modifying credential proxy to inject Claude model names** - Failed, ZenZGA/2.4 proxy intercepted requests
3. **Using GLM model names directly** - Failed, SDK rejected non-Claude names

## The Breakthrough

Testing revealed that **Z.ai's Anthropic-compatible endpoint fully supports tool calling with the standard Anthropic SDK** (`@anthropic-ai/sdk`):

```bash
curl -X POST https://api.z.ai/api/anthropic/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 100,
    "tools": [...],
    "messages": [{"role": "user", "content": "..."}]
  }'
```

The model name `claude-3-5-sonnet-20241022` is automatically translated to `glm-4.7` by Z.ai's API.

## The Solution

### 1. Replace SDK

Changed from `@anthropic-ai/claude-agent-sdk` to `@anthropic-ai/sdk`:

**container/agent-runner/package.json:**
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    ...
  }
}
```

### 2. Create New Agent Runner

Created `container/agent-runner/src/index.ts` using the standard Anthropic SDK with:
- Custom tool execution loop (bash, read_file, write_file)
- Session management
- Conversation history tracking
- IPC message handling

### 3. Fix Credential Proxy Bug

The credential proxy wasn't prepending the base URL pathname to API paths:

**src/credential-proxy.ts (line 86):**
```typescript
// Before (bug):
path: req.url,

// After (fixed):
path: upstreamUrl.pathname + req.url,
```

This ensures requests like `/v1/messages` are correctly forwarded to `https://api.z.ai/api/anthropic/v1/messages`.

### 4. Update Environment Configuration

No changes needed to `.env`:
```bash
ANTHROPIC_API_KEY=dc58e19e76704bb0b47ba9b127619f8e.KorFYg6lBPdHzTku
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
```

The credential proxy intercepts container requests, injects the real API key, and forwards to Z.ai.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Telegram Bot (@lnboltbot)                                   │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ NanoClaw Service (src/index.ts)                             │
│ - Spawns Docker containers                                  │
│ - Routes messages                                           │
│ - Manages sessions                                          │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Docker Container (nanoclaw-agent:latest)                   │
│ - New agent runner (@anthropic-ai/sdk)                     │
│ - Tool execution (bash, read, write)                        │
│ - ANTHROPIC_BASE_URL=http://host.docker.internal:3001       │
│ - ANTHROPIC_API_KEY=placeholder                             │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Credential Proxy (localhost:3001)                          │
│ - Injects real API key                                     │
│ - Forwards to Z.ai                                         │
│ - Fixed: path = upstreamUrl.pathname + req.url             │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Z.ai API (https://api.z.ai/api/anthropic)                  │
│ - Translates claude-3-5-sonnet → glm-4.7                   │
│ - Returns GLM model responses                              │
└─────────────────────────────────────────────────────────────┘
```

## Model Translation

Z.ai automatically translates Claude model names to GLM models:

| Claude Model Name | GLM Model |
|-------------------|-----------|
| claude-3-5-sonnet-20241022 | glm-4.7 |
| claude-3-5-haiku-20241022 | glm-4.6 |
| claude-3-opus-20240229 | glm-4.5 |

## Building and Deploying

```bash
# Update cached source (for existing groups)
cp container/agent-runner/src/index.ts data/sessions/telegram_main/agent-runner-src/

# Rebuild container
./container/build.sh

# Rebuild main project
npm run build

# Restart service
systemctl --user restart nanoclaw
```

## Testing

### Test Container Directly
```bash
echo '{"prompt":"what is 2+2?","groupFolder":"telegram_main","chatJid":"tg:486845512","isMain":true}' | \
  docker run -i --rm \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  --add-host=host.docker.internal:host-gateway \
  nanoclaw-agent:latest
```

### Test via Telegram
Send a message to @lnboltbot:
- "What is 2+2?"
- "List files in /workspace/group"
- "Tell me a joke"

Expected response: "The answer is 2 + 2 = 4." (or similar response from GLM-4.7)

## Current Tool Support

The new agent runner implements these tools:
- ✅ **bash** - Run shell commands
- ✅ **read_file** - Read file contents (security: /workspace only)
- ✅ **write_file** - Write files (security: /workspace/group only)

## Limitations

Compared to the Claude Agent SDK, the current implementation has:
- ❌ No Agent Teams (subagents)
- ❌ No MCP integration
- ❌ No context compaction
- ❌ Limited tool set (3 tools vs 15+)

These can be added incrementally as needed.

## Troubleshooting

### 401 Unauthorized
- Check API key is valid: Test with curl directly
- Verify credential proxy is running: `curl http://localhost:3001/v1/models`

### 404 Not Found
- Verify credential proxy fix is applied (pathname prepending)
- Check ANTHROPIC_BASE_URL includes `/api/anthropic` path

### Model Validation Error
- Ensure standard Anthropic SDK is being used (not claude-agent-sdk)
- Verify container environment variables are set correctly

## Files Changed

1. `container/agent-runner/package.json` - Changed SDK dependency
2. `container/agent-runner/src/index.ts` - Complete rewrite with Anthropic SDK
3. `container/agent-runner/src/index-claude-agent-sdk.bak` - Backup of original
4. `src/credential-proxy.ts` - Fixed pathname bug (line 86)
5. `data/sessions/telegram_main/agent-runner-src/` - Cached source updated

## Next Steps

To enhance capabilities:
1. Add more tools (web_search, glob, grep, etc.)
2. Implement MCP server integration
3. Add context compaction for long sessions
4. Add Agent Teams support
5. Create additional channels (Discord, Slack, etc.)

## References

- Z.ai API: https://api.z.ai/api/anthropic
- Anthropic SDK: https://www.npmjs.com/package/@anthropic-ai/sdk
- NanoClaw Repository: https://github.com/qwibitai/nanoclaw

---

**Integration Date:** March 11, 2026
**Z.ai Models:** GLM-4.5, GLM-4.6, GLM-4.7, GLM-5
**Tested On:** Telegram (@lnboltbot)
**Status:** ✅ Working
