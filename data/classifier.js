#!/usr/bin/env node
/**
 * classifier.js — Prompt complexity classifier using local Ollama
 * 
 * Usage: node classifier.js "your prompt here"
 * Output: "simple" or "complex"
 * 
 * simple  → route to Haiku (cheap)
 * complex → route to Sonnet (full power)
 */

const http = require('http');

const OLLAMA_URL  = 'http://127.0.0.1:11434';
const MODEL       = 'mistral'; // fast 4GB classifier

const SYSTEM = `You are a prompt complexity classifier. Classify the user prompt as either "simple" or "complex".

SIMPLE: casual chat, one-liner questions, basic lookups, short answers, greetings, status checks, yes/no questions, simple calculations, single-step tasks.

COMPLEX: coding tasks, debugging, file editing, multi-step reasoning, research, analysis, writing long-form content, system changes, anything requiring tools or multiple steps.

Respond with ONLY one word: simple or complex. No explanation.`;

async function classify(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt.slice(0, 500) } // cap at 500 chars
      ],
      stream: false,
      options: { temperature: 0, num_predict: 5 }
    });

    const req = http.request(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          const text = r.message?.content?.trim().toLowerCase() || '';
          resolve(text.includes('simple') ? 'simple' : 'complex');
        } catch { resolve('complex'); } // default to complex on error
      });
    });
    req.on('error', () => resolve('complex'));
    req.setTimeout(5000, () => { req.destroy(); resolve('complex'); }); // 5s timeout
    req.write(body);
    req.end();
  });
}

// CLI usage
const prompt = process.argv.slice(2).join(' ');
if (!prompt) { console.log('complex'); process.exit(0); }

classify(prompt).then(result => {
  console.log(result);
  process.exit(0);
});
