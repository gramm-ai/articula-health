import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractToKg } from './extract.mjs';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(path.join(__dirname, '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml'
};

function send(res, status, body, headers = {}){
  const buf = typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers });
  res.end(buf);
}

async function serveStatic(req, res){
  try{
    let reqPath = new URL(req.url, 'http://localhost').pathname;
    if (!reqPath || reqPath === '/') reqPath = '/index.html';
    if (reqPath.endsWith('/')) reqPath = reqPath + 'index.html';

    // Normalise the path and strip any leading slash so path.join doesn't escape ROOT
    let normalized = path.posix.normalize(reqPath);
    if (normalized.startsWith('/')) normalized = normalized.slice(1);

    const filePath = path.resolve(ROOT, normalized);
    const relative = path.relative(ROOT, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return send(res, 403, { error: 'Forbidden' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  } catch (e) {
    send(res, 404, { error: 'Not found' });
  }
}

async function handleAnalyze(req, res){
  try{
    let body = '';
    req.on('data', chunk => { body += chunk; });
    await new Promise(resolve => req.on('end', resolve));
    const parsed = body ? JSON.parse(body) : {};
    const text = String(parsed.text || '').trim();
    if (!text) return send(res, 400, { error: 'Missing text' });
    const analyzeModel = (process.env.ANALYZE_MODEL || 'gpt-4o-mini').trim();
    const json = await extractToKg(text, { writeFile: true, baseDir: ROOT, model: analyzeModel });
    send(res, 200, { ok: true, nodes: json.nodes?.length || 0, edges: json.edges?.length || 0 });
  } catch (e) {
    console.error('Analyze failed:', e);
    send(res, 500, { error: String(e.message || e) });
  }
}

async function handleGenerateSample(req, res){
  try{
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return send(res, 500, { error: 'Missing OpenAI API key. Set OPENAI_API_KEY to enable sample generation.' });
    }

    const preferredModel = (process.env.SAMPLE_MODEL || 'gpt-4o-mini').trim();
    const temperature = Number.isFinite(Number(process.env.SAMPLE_TEMPERATURE)) ? Number(process.env.SAMPLE_TEMPERATURE) : 0.8;
    const maxOutputTokens = Number.isFinite(Number(process.env.SAMPLE_TOKENS)) ? Number(process.env.SAMPLE_TOKENS) : 700;
    const rawConfiguredModels = String(process.env.SAMPLE_MODELS || '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
    const fallbackModels = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5'];
    const candidateModels = [...new Set([preferredModel, ...rawConfiguredModels, ...fallbackModels])];

    const client = new OpenAI({ apiKey });
    const prompt = `Write a realistic 1–2 page outpatient PRIMARY CARE conversation transcript between a doctor and the patient Ava Nguyen.

Constraints:
- Use natural dialogue turns labeled "Doctor:" and "Patient:" plus brief bracketed stage directions like [Exam room] or [Dictation].
- Work the patient's name (Ava Nguyen) naturally into the conversation (e.g., greetings, clarifications), but keep the turn labels as "Doctor:" and "Patient:".
- Include: symptoms (cough/wheeze), vitals (BP, SpO2), focused lung exam findings, active meds (lisinopril, albuterol), a documented penicillin allergy with anaphylaxis, and a proposed antibiotic plan (azithromycin) explicitly avoiding penicillins.
- Include an "Assessment and Plan" dictation section at the end with medication names and simple sigs.
- Keep PHI generic beyond the name. Avoid meta-commentary.

Output: only the transcript text.`;

    if (!candidateModels.length) {
      return send(res, 500, { error: 'No candidate models available for sample generation.' });
    }

    async function extractTextFromResponses(resp){
      if (!resp) return '';
      if (typeof resp.output_text === 'string' && resp.output_text.trim()) return resp.output_text.trim();
      try {
        const aggregates = [];
        const outputItems = Array.isArray(resp?.output) ? resp.output : (Array.isArray(resp?.outputs) ? resp.outputs : []);
        for (const item of outputItems) {
          const content = Array.isArray(item?.content) ? item.content : [];
          for (const seg of content) {
            if (typeof seg?.text === 'string' && seg.text.trim()) aggregates.push(seg.text);
            else if (typeof seg?.content === 'string' && seg.content.trim()) aggregates.push(seg.content);
          }
        }
        if (!aggregates.length && Array.isArray(resp?.choices) && resp.choices[0]?.message?.content) {
          aggregates.push(String(resp.choices[0].message.content));
        }
        return aggregates.join('\n').trim();
      } catch { return ''; }
    }

    async function tryResponses(model){
      let params = { model, input: prompt, temperature, max_output_tokens: maxOutputTokens };
      for (let i = 0; i < 3; i++) {
        try { return await client.responses.create(params); }
        catch (e) {
          const msg = String(e?.message || '');
          const bad = e?.error?.param || '';
          if (bad === 'temperature' || /temperature/i.test(msg)) { delete params.temperature; continue; }
          if (bad === 'max_output_tokens' || /max[_ ]?output[_ ]?tokens/i.test(msg)) { delete params.max_output_tokens; continue; }
          // If the model doesn't support Responses or is unknown, bubble up
          throw e;
        }
      }
      return null;
    }

    async function tryChatCompletions(model){
      try {
        const cc = await client.chat.completions.create({
          model,
          temperature,
          max_tokens: maxOutputTokens,
          messages: [
            { role: 'system', content: 'You are a clinical scribe generating realistic primary care transcripts.' },
            { role: 'user', content: prompt }
          ]
        });
        const txt = (cc?.choices?.[0]?.message?.content || '').trim();
        return txt ? { output_text: txt } : null;
      } catch (e) {
        return null;
      }
    }

    let lastError = null;
    for (const model of candidateModels) {
      try {
        // First try Responses API
        let resp = await tryResponses(model);
        if (!resp) throw new Error('No response object');
        let text = await extractTextFromResponses(resp);
        if (text) return send(res, 200, { text, modelUsed: model, api: 'responses' });
        // If empty, fall back to chat
        const ccResp = await tryChatCompletions(model);
        if (ccResp) {
          const text2 = await extractTextFromResponses(ccResp);
          if (text2) return send(res, 200, { text: text2, modelUsed: model, api: 'chat' });
        }
      } catch (e) {
        lastError = e;
        // Try chat completions as fallback if Responses failed hard (e.g., unsupported model)
        const ccResp = await tryChatCompletions(model);
        if (ccResp) {
          const text = await extractTextFromResponses(ccResp);
          if (text) return send(res, 200, { text, modelUsed: model, api: 'chat' });
        }
      }
    }

    // If we reach here, generation failed across candidates
    return send(res, 500, { error: 'Generation failed', detail: String(lastError?.message || lastError || 'Unknown error'), triedModels: candidateModels });
  } catch (e) {
    console.error('Generate sample failed:', e);
    return send(res, 500, { error: String(e.message || e) });
  }
}

const server = http.createServer(async (req, res) => {
  const method = (req.method || 'GET').toUpperCase();
  const url = req.url || '/';
  const { pathname } = new URL(url, 'http://localhost');

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end();
    return;
  }

  if (pathname === '/analyze') {
    if (method !== 'POST') {
      return send(res, 405, { error: 'Method not allowed' }, { 'access-control-allow-methods': 'POST,OPTIONS' });
    }
    return handleAnalyze(req, res);
  }

  if (pathname === '/generate-sample') {
    if (method !== 'POST') {
      return send(res, 405, { error: 'Method not allowed' }, { 'access-control-allow-methods': 'POST,OPTIONS' });
    }
    return handleGenerateSample(req, res);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return send(res, 404, { error: 'Not found' });
  }

  return serveStatic(req, res);
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
});


