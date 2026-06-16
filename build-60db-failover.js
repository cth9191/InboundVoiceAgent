/**
 * Merges a "60db failover layer" into the Inbound Voice Agent n8n workflow.
 *
 * For each speech capability the layer exposes an n8n webhook that calls
 * ElevenLabs FIRST and automatically falls back to 60db on any error, then
 * returns a single normalized (provider-agnostic) response. This is the
 * "very consistent" contract: callers get the same shape no matter which
 * provider actually served the request.
 *
 *   capability   | webhook path                | EL primary                                  | 60db fallback
 *   -------------|-----------------------------|---------------------------------------------|--------------------------
 *   tts          | /60db-fo-tts                | POST /v1/text-to-speech/{voice}             | POST /tts-synthesize
 *   tts-stream   | /60db-fo-tts-stream         | POST /v1/text-to-speech/{voice}/stream      | POST /tts-stream (NDJSON)
 *   stt          | /60db-fo-stt                | POST /v1/speech-to-text                     | POST /stt
 *   voices       | /60db-fo-voices             | GET  /v1/voices                             | GET  /myvoices
 *
 * Failover mechanism: the ElevenLabs HTTP node uses onError:"continueErrorOutput"
 * so its 2nd output (error) is wired to the 60db node. Success of either provider
 * (and a final 60db error) all funnel into a Normalize Code node -> Respond.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'Inbound Voice Agent.json');
const wf = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// Credential placeholders — user re-selects these in n8n after import.
const EL_CRED = { httpHeaderAuth: { id: 'EL_HEADER_CRED', name: 'ElevenLabs API (xi-api-key header)' } };
const DB_CRED = { httpHeaderAuth: { id: 'DB60_HEADER_CRED', name: '60db API (Authorization: Bearer)' } };

const nodes = [];
const conns = {};
const connect = (from, to, fromOut = 0) => {
  conns[from] = conns[from] || { main: [] };
  while (conns[from].main.length <= fromOut) conns[from].main.push([]);
  conns[from].main[fromOut].push({ node: to, type: 'main', index: 0 });
};

const httpHeaderAuth = (cred, authType) => ({
  authentication: 'genericCredentialType',
  genericAuthType: authType, // "httpHeaderAuth"
});

// ----- generic builders ---------------------------------------------------
let yBase = 1720;
function webhook(name, p, id, post = false) {
  const node = {
    parameters: { path: p, responseMode: 'responseNode', options: {} },
    type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
    position: [224, yBase], id, name, webhookId: p,
  };
  if (post) node.parameters.httpMethod = 'POST';
  nodes.push(node);
  return node;
}
function respond(name, id, y) {
  nodes.push({
    parameters: { options: {} },
    type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4,
    position: [1180, y], id, name,
  });
}
function code(name, id, y, js) {
  nodes.push({
    parameters: { jsCode: js },
    type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [940, y], id, name, onError: 'continueRegularOutput',
  });
}
function sticky(content, id, y, color, h = 176) {
  nodes.push({
    parameters: { content, height: h, width: 1300, color },
    type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
    position: [-32, y - 40], id, name: 'SN-' + id,
  });
}

// =====================================================================
// 1. TTS (REST)
// =====================================================================
yBase = 1720;
webhook('TTS Webhook (60db FO)', '60db-fo-tts', 'fo-tts-webhook');
sticky('## TTS  —  ElevenLabs primary → 60db fallback\n### GET ?text=&elVoiceId=&voiceId60db=', 'fo-tts-note', yBase, 4);

nodes.push({
  parameters: {
    method: 'POST',
    url: "=https://api.elevenlabs.io/v1/text-to-speech/{{ $json.query.elVoiceId || '21m00Tcm4TlvDq8ikWAM' }}",
    ...httpHeaderAuth(EL_CRED, 'httpHeaderAuth'),
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Accept', value: 'audio/mpeg' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $json.query.text, model_id: 'eleven_turbo_v2_5' }) }}",
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [480, yBase], id: 'fo-tts-el', name: 'ElevenLabs TTS',
  onError: 'continueErrorOutput', credentials: EL_CRED,
});
nodes.push({
  parameters: {
    method: 'POST', url: 'https://api.60db.ai/tts-synthesize',
    ...httpHeaderAuth(DB_CRED, 'httpHeaderAuth'),
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $('TTS Webhook (60db FO)').item.json.query.text, voice_id: $('TTS Webhook (60db FO)').item.json.query.voiceId60db, output_format: 'mp3', enhance: true }) }}",
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [700, yBase + 60], id: 'fo-tts-60db', name: '60db TTS (fallback)',
  onError: 'continueErrorOutput', credentials: DB_CRED,
});
code('Normalize TTS', 'fo-tts-norm', yBase, `
const it = items[0] || { json: {} };
let provider = 'none', audio_base64 = null, format = 'mp3', sample_rate = null, error = null;
if (it.binary && it.binary.data) {                 // ElevenLabs success (binary file)
  provider = 'elevenlabs';
  audio_base64 = it.binary.data.data;
  format = it.binary.data.fileExtension || 'mp3';
} else if (it.json && it.json.audio_base64) {      // 60db success
  provider = '60db';
  audio_base64 = it.json.audio_base64;
  format = it.json.output_format || 'mp3';
  sample_rate = it.json.sample_rate || null;
} else {                                            // both failed
  error = (it.json && (it.json.message || it.json.error)) || 'TTS failed on both ElevenLabs and 60db';
}
return [{ json: { success: !!audio_base64, provider, audio_base64, format, sample_rate, error } }];
`.trim());
respond('Respond TTS', 'fo-tts-resp', yBase);

connect('TTS Webhook (60db FO)', 'ElevenLabs TTS');
connect('ElevenLabs TTS', 'Normalize TTS', 0);
connect('ElevenLabs TTS', '60db TTS (fallback)', 1);
connect('60db TTS (fallback)', 'Normalize TTS', 0);
connect('60db TTS (fallback)', 'Normalize TTS', 1);
connect('Normalize TTS', 'Respond TTS');

// =====================================================================
// 2. TTS stream
// =====================================================================
yBase = 1920;
webhook('TTS Stream Webhook (60db FO)', '60db-fo-tts-stream', 'fo-ttss-webhook');
sticky('## TTS Stream  —  ElevenLabs /stream primary → 60db /tts-stream (NDJSON) fallback\n### Note: returns assembled base64. True WebSocket (wss://api.60db.ai/ws/tts) is not supported by the n8n HTTP node — use a Code node with the `ws` lib or an external worker for that.', 'fo-ttss-note', yBase, 5);

nodes.push({
  parameters: {
    method: 'POST',
    url: "=https://api.elevenlabs.io/v1/text-to-speech/{{ $json.query.elVoiceId || '21m00Tcm4TlvDq8ikWAM' }}/stream",
    ...httpHeaderAuth(EL_CRED, 'httpHeaderAuth'),
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Accept', value: 'audio/mpeg' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $json.query.text, model_id: 'eleven_turbo_v2_5' }) }}",
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [480, yBase], id: 'fo-ttss-el', name: 'ElevenLabs TTS Stream',
  onError: 'continueErrorOutput', credentials: EL_CRED,
});
nodes.push({
  parameters: {
    method: 'POST', url: 'https://api.60db.ai/tts-stream',
    ...httpHeaderAuth(DB_CRED, 'httpHeaderAuth'),
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $('TTS Stream Webhook (60db FO)').item.json.query.text, voice_id: $('TTS Stream Webhook (60db FO)').item.json.query.voiceId60db }) }}",
    options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [700, yBase + 60], id: 'fo-ttss-60db', name: '60db TTS Stream (fallback)',
  onError: 'continueErrorOutput', credentials: DB_CRED,
});
code('Normalize TTS Stream', 'fo-ttss-norm', yBase, `
const it = items[0] || { json: {} };
let provider = 'none', audio_base64 = null, format = 'mp3', error = null;
if (it.binary && it.binary.data) {                       // ElevenLabs stream -> binary
  provider = 'elevenlabs';
  audio_base64 = it.binary.data.data;
  format = it.binary.data.fileExtension || 'mp3';
} else if (it.json && typeof it.json.data === 'string') { // 60db NDJSON text
  const bufs = [];
  for (const line of it.json.data.split('\\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o.type === 'chunk' && o.result && o.result.audioContent) {
        bufs.push(Buffer.from(o.result.audioContent, 'base64'));
      } else if (o.type === 'error') {
        error = o.message || 'stream error';
      }
    } catch (e) { /* skip non-JSON lines */ }
  }
  if (bufs.length) { provider = '60db'; audio_base64 = Buffer.concat(bufs).toString('base64'); }
} else {
  error = (it.json && (it.json.message || it.json.error)) || 'TTS stream failed on both providers';
}
return [{ json: { success: !!audio_base64, provider, audio_base64, format, error } }];
`.trim());
respond('Respond TTS Stream', 'fo-ttss-resp', yBase);

connect('TTS Stream Webhook (60db FO)', 'ElevenLabs TTS Stream');
connect('ElevenLabs TTS Stream', 'Normalize TTS Stream', 0);
connect('ElevenLabs TTS Stream', '60db TTS Stream (fallback)', 1);
connect('60db TTS Stream (fallback)', 'Normalize TTS Stream', 0);
connect('60db TTS Stream (fallback)', 'Normalize TTS Stream', 1);
connect('Normalize TTS Stream', 'Respond TTS Stream');

// =====================================================================
// 3. STT  (download audio by URL, then transcribe)
// =====================================================================
yBase = 2120;
webhook('STT Webhook (60db FO)', '60db-fo-stt', 'fo-stt-webhook');
sticky('## STT  —  ElevenLabs scribe primary → 60db /stt fallback\n### GET ?audioUrl=  (audio is downloaded, then sent as multipart file)', 'fo-stt-note', yBase, 6);

nodes.push({
  parameters: {
    method: 'GET', url: '={{ $json.query.audioUrl }}',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [360, yBase], id: 'fo-stt-dl', name: 'Download Audio',
});
nodes.push({
  parameters: {
    method: 'POST', url: 'https://api.elevenlabs.io/v1/speech-to-text',
    ...httpHeaderAuth(EL_CRED, 'httpHeaderAuth'),
    contentType: 'multipart-form-data', sendBody: true,
    bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      { name: 'model_id', value: 'scribe_v1' },
    ] },
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [560, yBase], id: 'fo-stt-el', name: 'ElevenLabs STT',
  onError: 'continueErrorOutput', credentials: EL_CRED,
});
nodes.push({
  parameters: {
    method: 'POST', url: 'https://api.60db.ai/stt',
    ...httpHeaderAuth(DB_CRED, 'httpHeaderAuth'),
    contentType: 'multipart-form-data', sendBody: true,
    bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      { name: 'language', value: 'auto' },
    ] },
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [760, yBase + 60], id: 'fo-stt-60db', name: '60db STT (fallback)',
  onError: 'continueErrorOutput', credentials: DB_CRED,
});
code('Normalize STT', 'fo-stt-norm', yBase, `
const it = items[0] || { json: {} };
const j = it.json || {};
let provider = 'none', text = null, language = null, segments = [], error = null;
if (j.request_id !== undefined && j.text !== undefined) {        // 60db
  provider = '60db'; text = j.text; language = j.language || null; segments = j.segments || [];
} else if (j.text !== undefined && (j.language_code !== undefined || j.words !== undefined)) { // ElevenLabs
  provider = 'elevenlabs'; text = j.text; language = j.language_code || null;
} else if (j.text !== undefined) {                               // best-effort
  provider = 'unknown'; text = j.text;
} else {
  error = j.message || j.error || 'STT failed on both ElevenLabs and 60db';
}
return [{ json: { success: text !== null, provider, text, language, segments, error } }];
`.trim());
respond('Respond STT', 'fo-stt-resp', yBase);

connect('STT Webhook (60db FO)', 'Download Audio');
connect('Download Audio', 'ElevenLabs STT');
connect('ElevenLabs STT', 'Normalize STT', 0);
connect('ElevenLabs STT', '60db STT (fallback)', 1);
connect('60db STT (fallback)', 'Normalize STT', 0);
connect('60db STT (fallback)', 'Normalize STT', 1);
connect('Normalize STT', 'Respond STT');

// =====================================================================
// 4. Voices
// =====================================================================
yBase = 2320;
webhook('Voices Webhook (60db FO)', '60db-fo-voices', 'fo-voices-webhook');
sticky('## Voices  —  ElevenLabs /v1/voices primary → 60db /myvoices fallback', 'fo-voices-note', yBase, 4);

nodes.push({
  parameters: {
    method: 'GET', url: 'https://api.elevenlabs.io/v1/voices',
    ...httpHeaderAuth(EL_CRED, 'httpHeaderAuth'), options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [480, yBase], id: 'fo-voices-el', name: 'ElevenLabs Voices',
  onError: 'continueErrorOutput', credentials: EL_CRED,
});
nodes.push({
  parameters: {
    method: 'GET', url: 'https://api.60db.ai/myvoices',
    ...httpHeaderAuth(DB_CRED, 'httpHeaderAuth'), options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [700, yBase + 60], id: 'fo-voices-60db', name: '60db Voices (fallback)',
  onError: 'continueErrorOutput', credentials: DB_CRED,
});
code('Normalize Voices', 'fo-voices-norm', yBase, `
const it = items[0] || { json: {} };
const j = it.json || {};
let provider = 'none', voices = [], error = null;
if (Array.isArray(j.voices)) {                       // ElevenLabs
  provider = 'elevenlabs';
  voices = j.voices.map(v => ({ voice_id: v.voice_id, name: v.name, category: v.category || null, labels: v.labels || {} }));
} else if (Array.isArray(j.data)) {                  // 60db
  provider = '60db';
  voices = j.data.map(v => ({ voice_id: v.voice_id, name: v.name, category: v.category || null, model: v.model || null, labels: v.labels || {} }));
} else {
  error = j.message || j.error || 'Voice listing failed on both ElevenLabs and 60db';
}
return [{ json: { success: !error, provider, count: voices.length, voices, error } }];
`.trim());
respond('Respond Voices', 'fo-voices-resp', yBase);

connect('Voices Webhook (60db FO)', 'ElevenLabs Voices');
connect('ElevenLabs Voices', 'Normalize Voices', 0);
connect('ElevenLabs Voices', '60db Voices (fallback)', 1);
connect('60db Voices (fallback)', 'Normalize Voices', 0);
connect('60db Voices (fallback)', 'Normalize Voices', 1);
connect('Normalize Voices', 'Respond Voices');

// Section header sticky
nodes.push({
  parameters: {
    content: '## 🔁 60db Failover Layer\n### ElevenLabs primary · 60db automatic fallback · normalized output\n### Endpoints: /60db-fo-tts · /60db-fo-tts-stream · /60db-fo-stt · /60db-fo-voices',
    height: 760, width: 1360, color: 7,
  },
  type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
  position: [-48, 1620], id: 'fo-section-note', name: 'SN-60db-section',
});

// ----- merge --------------------------------------------------------------
wf.nodes.push(...nodes);
for (const [k, v] of Object.entries(conns)) {
  if (wf.connections[k]) {
    // merge main arrays (shouldn't collide since names are unique, but be safe)
    v.main.forEach((arr, i) => {
      wf.connections[k].main[i] = (wf.connections[k].main[i] || []).concat(arr);
    });
  } else {
    wf.connections[k] = v;
  }
}

fs.writeFileSync(FILE, JSON.stringify(wf, null, 2));
console.log('Merged. Added', nodes.length, 'nodes. Total nodes now', wf.nodes.length);
// quick re-parse sanity check
JSON.parse(fs.readFileSync(FILE, 'utf8'));
console.log('JSON re-parse OK');
