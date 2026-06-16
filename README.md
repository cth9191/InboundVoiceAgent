# 🤖 AI Inbound Voice Agent for n8n

Automated voice agent that books appointments, manages clients, and integrates into your CRM.

---

## 🎥 Video Guide

[![Watch the Setup Tutorial](https://img.youtube.com/vi/8evYjk8vXtI/maxresdefault.jpg)](https://youtu.be/8evYjk8vXtI)

**[👉 Watch Full Tutorial](https://youtu.be/8evYjk8vXtI)**

**[🎁 Join FREE Skool Community - Get 50+ AI Agent Templates](https://www.skool.com/chase-ai-community)**

---

## ⚡ How It Works
```
📞 Call → 🎙️ ElevenLabs AI → 🔧 n8n Webhooks → 📊 Google Services → 💬 Response
```

> 🔁 **New:** a **60db failover layer** now backs ElevenLabs for speech tasks.
> See [🔁 60db Failover](#-60db-failover-layer) below.

---

## 🎯 What It Does

- 📅 **Check availability** - Finds open calendar slots (9 AM - 5 PM)
- 📝 **Book appointments** - Creates events with auto-invites
- 🔄 **Modify/Cancel** - Updates or removes bookings
- 👥 **Client lookup** - Retrieves customer data by email
- ➕ **Add clients** - Onboards new customers
- 📊 **Track calls** - Logs transcripts and summaries

---

## 🛠️ Requirements

| Service | Cost |
|---------|------|
| ElevenLabs | $5-25/mo |
| 60db (failover, optional) | pay-as-you-go (~$0.00002/char TTS) |
| Twilio | $20 one-time |
| Google (Calendar + Sheets) | Free |
| n8n | Free (self-hosted) |

---

## 🚀 Quick Setup

1. Import workflow to n8n
2. Connect OAuth (Google Calendar + Sheets)
3. Add ElevenLabs + Twilio credentials
4. Update Calendar ID and Sheet Document ID
5. Map n8n webhook URLs to ElevenLabs tools
6. Test and deploy 🎉

---

## ⚙️ Configuration
```javascript
workdayStartHour: 9           // Business hours start
workdayEndHour: 17            // Business hours end
minGapMinutes: 60             // Minimum appointment length
timeZone: 'America/Chicago'   // Your timezone
```

---

## 📋 Database Structure

**Clients:** First Name | Last Name | Email | Phone | Balance  
**Calls:** Email | Phone | Call Summary

---

## 🎬 Perfect For

🏋️ Gyms | 🏥 Medical | 💼 Consulting | 🔧 Services | 📚 Coaching

---

## 🌟 Benefits

| Before | After |
|--------|-------|
| ❌ Manual scheduling | ✅ Automatic 24/7 |
| ❌ Missed calls | ✅ Never miss a booking |
| ❌ Data entry | ✅ Auto-logged |
| ❌ Expensive staff | ✅ $5-25/month |

---

## 💡 Key Features

✅ Smart gap detection between appointments  
✅ Timezone-aware formatting  
✅ Robust error handling  
✅ Real-time calendar sync  
✅ Call analytics tracking

---

## 🔁 60db Failover Layer

ElevenLabs stays the **primary** voice provider. **60db** is wired in as an
**automatic fallback** so speech operations keep working if ElevenLabs errors
out — and every endpoint returns the **same normalized response** no matter
which provider served it.

### ⚠️ What this is (and isn't)
- ✅ Fails over the **discrete speech operations** (TTS, STT, voice listing) that tools / post-call steps call.
- ❌ Does **not** fail over the **live phone call** — n8n isn't in the real-time audio path, so it can't take over a call mid-stream. (That would need a separate Twilio Media-Streams orchestrator.)

### 🧩 What was added
- **4 new webhook endpoints**, each: ElevenLabs first → 60db on error → normalized output.
- ElevenLabs nodes use `onError: continueErrorOutput` (output 0 = success → Normalize, output 1 = error → 60db).
- A **Normalize** Code node per endpoint so callers get one consistent shape.
- Files: `60DB-FAILOVER.md` (full reference) and `build-60db-failover.js` (the generator).

| Endpoint | Primary (ElevenLabs) | Fallback (60db) | Input |
|---|---|---|---|
| `/60db-fo-tts` | `POST /v1/text-to-speech/{voice}` | `POST /tts-synthesize` | `?text=&elVoiceId=&voiceId60db=` |
| `/60db-fo-tts-stream` | `…/{voice}/stream` | `POST /tts-stream` (NDJSON) | `?text=&elVoiceId=&voiceId60db=` |
| `/60db-fo-stt` | `POST /v1/speech-to-text` | `POST /stt` | `?audioUrl=` |
| `/60db-fo-voices` | `GET /v1/voices` | `GET /myvoices` | — |

### 📦 Normalized response (the "consistent" contract)
```jsonc
// TTS / TTS stream
{ "success": true, "provider": "elevenlabs|60db", "audio_base64": "...", "format": "mp3", "sample_rate": 24000, "error": null }
// STT
{ "success": true, "provider": "elevenlabs|60db", "text": "...", "language": "en", "segments": [...], "error": null }
// Voices
{ "success": true, "provider": "elevenlabs|60db", "count": 2, "voices": [{ "voice_id": "...", "name": "..." }], "error": null }
```

### 🚀 How to use it
1. **Import** the updated `Inbound Voice Agent.json` into n8n.
2. Create two **HTTP Header Auth** credentials and select them on the new nodes:
   - **ElevenLabs API** → header `xi-api-key` = your ElevenLabs key
   - **60db API** → header `Authorization` = `Bearer <your 60db key>`
3. Pass voices per request: `elVoiceId` (ElevenLabs) and `voiceId60db` (a `voice_id` from `GET /myvoices`). ElevenLabs defaults to `21m00Tcm4TlvDq8ikWAM` (Rachel) if omitted.
4. **Activate** the workflow and call the webhook URLs, e.g.:
   ```bash
   curl "https://<your-n8n>/webhook/60db-fo-tts?text=Hello%20there&voiceId60db=<id>"
   ```
   If ElevenLabs fails, the response comes back from 60db with `"provider": "60db"` — same shape.

> ⚠️ **WebSocket note:** 60db's true streaming socket (`wss://api.60db.ai/ws/tts`)
> can't run in an n8n HTTP node, so `/60db-fo-tts-stream` uses 60db's HTTP NDJSON
> `/tts-stream` instead. For real WS streaming use an external `ws` worker.

For the complete reference, see **[`60DB-FAILOVER.md`](./60DB-FAILOVER.md)**.

---

## 🏆 Credits

**Created by [Chase AI](https://www.skool.com/chase-ai-community)**

**Ready to start your own AI Agency? Join [Chase AI+](https://www.skool.com/chase-ai)**

---

**Now go automate!** 🚀
