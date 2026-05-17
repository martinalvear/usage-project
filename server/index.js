import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 8787);
const root = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const connections = new Map();

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function getConnection(provider) {
  if (connections.has(provider)) return connections.get(provider);
  if (provider === 'openai' && process.env.OPENAI_ADMIN_KEY) {
    return { apiKey: process.env.OPENAI_ADMIN_KEY, organizationId: process.env.OPENAI_ORG_ID };
  }
  if (provider === 'anthropic' && process.env.ANTHROPIC_ADMIN_KEY) {
    return { apiKey: process.env.ANTHROPIC_ADMIN_KEY };
  }
  return undefined;
}

function clampRangeHours(value) {
  const parsed = Number(value ?? 24);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(168, Math.max(1, Math.round(parsed)));
}

function startUnix(rangeHours) {
  return Math.floor((Date.now() - rangeHours * 60 * 60 * 1000) / 1000);
}

function isoHoursAgo(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function sumBuckets(buckets) {
  const inputTokens = buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
  const outputTokens = buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0);
  const cacheTokens = buckets.reduce((sum, bucket) => sum + (bucket.cacheReadTokens ?? 0) + (bucket.cacheWriteTokens ?? 0), 0);
  const costUsd = buckets.reduce((sum, bucket) => sum + (bucket.costUsd ?? 0), 0);
  return { inputTokens, outputTokens, cacheTokens, totalTokens: inputTokens + outputTokens + cacheTokens, costUsd };
}

function demoUsage(provider, rangeHours) {
  const now = new Date();
  const length = Math.min(rangeHours, 24);
  const buckets = Array.from({ length }, (_, index) => {
    const wave = Math.sin(index / 2) + 1.6;
    const multiplier = provider === 'openai' ? 1450 : 1180;
    const inputTokens = Math.round(wave * multiplier + index * 83);
    const outputTokens = Math.round(wave * (multiplier / 2.4) + index * 39);
    const cacheReadTokens = Math.round(wave * (provider === 'openai' ? 220 : 410));
    return {
      timestamp: new Date(now.getTime() - (length - index - 1) * 60 * 60 * 1000).toISOString(),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUsd: Number(((inputTokens * 1.25 + outputTokens * 10) / 1_000_000).toFixed(4))
    };
  });
  const totals = sumBuckets(buckets);
  const isOpenAI = provider === 'openai';
  return {
    id: provider,
    name: isOpenAI ? 'Codex / OpenAI' : 'Claude / Anthropic',
    accent: isOpenAI ? '#10a37f' : '#d97757',
    connected: false,
    source: 'demo',
    lastUpdated: now.toISOString(),
    pollingSeconds: 60,
    totals,
    buckets,
    models: isOpenAI
      ? [
          { name: 'gpt-5.2-codex', tokens: Math.round(totals.totalTokens * 0.62), costUsd: totals.costUsd * 0.62 },
          { name: 'gpt-5-codex', tokens: Math.round(totals.totalTokens * 0.38), costUsd: totals.costUsd * 0.38 }
        ]
      : [
          { name: 'claude-sonnet', tokens: Math.round(totals.totalTokens * 0.7), costUsd: totals.costUsd * 0.7 },
          { name: 'claude-opus', tokens: Math.round(totals.totalTokens * 0.3), costUsd: totals.costUsd * 0.3 }
        ],
    message: 'Datos de demostración. Conecta una clave admin para uso real.'
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? response.statusText;
    throw new Error(`${response.status} ${detail}`);
  }
  return payload;
}

async function fetchOpenAIUsage(rangeHours, connection) {
  const params = new URLSearchParams({ start_time: String(startUnix(rangeHours)), bucket_width: rangeHours <= 24 ? '1h' : '1d', limit: '180' });
  const headers = { Authorization: `Bearer ${connection.apiKey}` };
  if (connection.organizationId) headers['OpenAI-Organization'] = connection.organizationId;
  const usage = await fetchJson(`https://api.openai.com/v1/organization/usage/completions?${params}`, { headers });

  let costsByStart = new Map();
  try {
    const costs = await fetchJson(`https://api.openai.com/v1/organization/costs?${params}`, { headers });
    costsByStart = new Map((costs.data ?? []).map((bucket) => [bucket.start_time, (bucket.results ?? []).reduce((sum, result) => sum + Number(result.amount?.value ?? 0), 0)]));
  } catch {
    costsByStart = new Map();
  }

  const modelTotals = new Map();
  const buckets = (usage.data ?? []).map((bucket) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    for (const result of bucket.results ?? []) {
      inputTokens += Number(result.input_tokens ?? 0);
      outputTokens += Number(result.output_tokens ?? 0);
      cacheReadTokens += Number(result.input_cached_tokens ?? 0);
      const model = result.model ?? 'openai-model';
      const previous = modelTotals.get(model) ?? { tokens: 0 };
      previous.tokens += Number(result.input_tokens ?? 0) + Number(result.output_tokens ?? 0) + Number(result.input_cached_tokens ?? 0);
      modelTotals.set(model, previous);
    }
    return { timestamp: new Date(Number(bucket.start_time) * 1000).toISOString(), inputTokens, outputTokens, cacheReadTokens, costUsd: costsByStart.get(bucket.start_time) ?? 0 };
  });
  const totals = sumBuckets(buckets);
  const models = [...modelTotals.entries()].map(([name, value]) => ({ name, tokens: value.tokens, costUsd: totals.totalTokens > 0 ? (value.tokens / totals.totalTokens) * totals.costUsd : 0 }));
  return { id: 'openai', name: 'Codex / OpenAI', accent: '#10a37f', connected: true, source: 'live', lastUpdated: new Date().toISOString(), pollingSeconds: 60, totals, buckets, models, message: 'Datos obtenidos desde Usage y Costs API de OpenAI.' };
}

async function fetchAnthropicUsage(rangeHours, connection) {
  const startingAt = isoHoursAgo(rangeHours);
  const endingAt = new Date().toISOString();
  const bucketWidth = rangeHours <= 24 ? '1h' : '1d';
  const params = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, bucket_width: bucketWidth, group_by: 'model' });
  const headers = { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01', 'User-Agent': 'TokenPulse/0.1.0 (local dashboard)' };
  const usage = await fetchJson(`https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`, { headers });

  let costBuckets = [];
  try {
    const costParams = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, bucket_width: bucketWidth, group_by: 'description' });
    const costs = await fetchJson(`https://api.anthropic.com/v1/organizations/cost_report?${costParams}`, { headers });
    costBuckets = costs.data ?? [];
  } catch {
    costBuckets = [];
  }
  const costsByStart = new Map(costBuckets.map((bucket) => [bucket.starting_at ?? bucket.start_time, (bucket.results ?? []).reduce((sum, result) => sum + Number(result.amount ?? result.cost_usd ?? 0), 0)]));

  const modelTotals = new Map();
  const buckets = (usage.data ?? []).map((bucket) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (const result of bucket.results ?? []) {
      inputTokens += Number(result.uncached_input_tokens ?? result.input_tokens ?? 0);
      outputTokens += Number(result.output_tokens ?? 0);
      cacheReadTokens += Number(result.cache_read_input_tokens ?? 0);
      cacheWriteTokens += Number(result.cache_creation_input_tokens ?? 0);
      const model = result.model ?? 'claude-model';
      const previous = modelTotals.get(model) ?? { tokens: 0 };
      previous.tokens += Number(result.uncached_input_tokens ?? result.input_tokens ?? 0) + Number(result.output_tokens ?? 0) + Number(result.cache_read_input_tokens ?? 0) + Number(result.cache_creation_input_tokens ?? 0);
      modelTotals.set(model, previous);
    }
    const timestamp = bucket.starting_at ?? bucket.start_time ?? new Date().toISOString();
    return { timestamp, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: costsByStart.get(timestamp) ?? 0 };
  });
  const totals = sumBuckets(buckets);
  const models = [...modelTotals.entries()].map(([name, value]) => ({ name, tokens: value.tokens, costUsd: totals.totalTokens > 0 ? (value.tokens / totals.totalTokens) * totals.costUsd : 0 }));
  return { id: 'anthropic', name: 'Claude / Anthropic', accent: '#d97757', connected: true, source: 'live', lastUpdated: new Date().toISOString(), pollingSeconds: 60, totals, buckets, models, message: 'Datos obtenidos desde Usage & Cost Admin API de Anthropic.' };
}

async function providerUsage(provider, rangeHours) {
  const connection = getConnection(provider);
  if (!connection) return demoUsage(provider, rangeHours);
  try {
    return provider === 'openai' ? await fetchOpenAIUsage(rangeHours, connection) : await fetchAnthropicUsage(rangeHours, connection);
  } catch (error) {
    return { ...demoUsage(provider, rangeHours), connected: true, source: 'error', message: error instanceof Error ? error.message : 'Error desconocido al obtener uso real.' };
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    json(response, 200, { ok: true, generatedAt: new Date().toISOString() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/usage') {
    const rangeHours = clampRangeHours(url.searchParams.get('rangeHours'));
    const providers = await Promise.all(['openai', 'anthropic'].map((provider) => providerUsage(provider, rangeHours)));
    json(response, 200, { generatedAt: new Date().toISOString(), rangeHours, providers });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/connections') {
    const { provider, apiKey, organizationId } = await readBody(request);
    if (!['openai', 'anthropic'].includes(provider)) return json(response, 400, { error: 'Proveedor no soportado.' });
    if (!apiKey || apiKey.trim().length < 12) return json(response, 400, { error: 'La clave API parece incompleta.' });
    connections.set(provider, { apiKey: apiKey.trim(), organizationId: organizationId?.trim() || undefined });
    json(response, 200, { ok: true, provider });
    return;
  }
  if (request.method === 'DELETE' && url.pathname.startsWith('/api/connections/')) {
    const provider = url.pathname.split('/').pop();
    connections.delete(provider);
    json(response, 200, { ok: true, provider });
    return;
  }
  json(response, 404, { error: 'Ruta API no encontrada.' });
}

async function serveStatic(response, pathname) {
  const safePath = normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = join(root, safePath || 'index.html');
  if (!filePath.startsWith(root)) return json(response, 403, { error: 'Forbidden' });
  try {
    const file = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream' });
    response.end(file);
  } catch {
    const index = await readFile(join(root, 'index.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(index);
  }
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : 'Error interno.' });
  }
}).listen(port, () => {
  console.log(`Token Pulse running on http://localhost:${port}`);
});
