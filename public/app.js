const state = { rangeHours: 24, loading: false, data: null };

const providerLabels = {
  openai: { label: 'Codex / OpenAI', placeholder: 'sk-admin… o clave con permisos de organización', org: 'Organization ID opcional' },
  anthropic: { label: 'Claude / Anthropic', placeholder: 'sk-ant-admin…', org: 'Anthropic usa claves admin de organización' }
};

const $ = (selector) => document.querySelector(selector);
const providersEl = $('#providers');
const errorEl = $('#error');
const modal = $('#modal');
const formMessage = $('#form-message');

function formatTokens(value) {
  return new Intl.NumberFormat('es', { notation: value > 999_999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value ?? 0);
}

function formatUsd(value) {
  return new Intl.NumberFormat('es', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value ?? 0);
}

function timeAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  return `hace ${Math.round(minutes / 60)}h`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderSparkline(provider) {
  const max = Math.max(1, ...provider.buckets.map((bucket) => bucket.inputTokens + bucket.outputTokens + (bucket.cacheReadTokens ?? 0) + (bucket.cacheWriteTokens ?? 0)));
  return provider.buckets.map((bucket) => {
    const total = bucket.inputTokens + bucket.outputTokens + (bucket.cacheReadTokens ?? 0) + (bucket.cacheWriteTokens ?? 0);
    const height = Math.max(8, (total / max) * 100);
    const title = `${new Date(bucket.timestamp).toLocaleString()} · ${formatTokens(total)} tokens`;
    return `<div class="bar-wrap" title="${escapeHtml(title)}"><div class="bar" style="height:${height}%;background:${provider.accent}"></div></div>`;
  }).join('');
}

function renderProvider(provider) {
  const status = provider.source === 'live' ? 'En vivo' : provider.source === 'error' ? 'Revisar conexión' : 'Demo';
  const statusIcon = provider.source === 'live' ? '✓' : provider.source === 'error' ? '!' : '✦';
  const models = provider.models.length
    ? provider.models.slice(0, 5).map((model) => `<div class="model-row"><span>${escapeHtml(model.name)}</span><strong>${formatTokens(model.tokens)}</strong></div>`).join('')
    : '<p class="muted">Sin desglose por modelo en este rango.</p>';

  return `<section class="provider-panel" style="--accent:${provider.accent}">
    <div class="provider-head">
      <div>
        <div class="provider-kicker">🤖 ${escapeHtml(provider.name)}</div>
        <h2>${formatTokens(provider.totals.totalTokens)} tokens</h2>
      </div>
      <div class="status-pill ${provider.source}">${statusIcon} ${status}</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><span>Entrada</span><strong>${formatTokens(provider.totals.inputTokens)}</strong></div>
      <div class="stat-card"><span>Salida</span><strong>${formatTokens(provider.totals.outputTokens)}</strong></div>
      <div class="stat-card"><span>Cache</span><strong>${formatTokens(provider.totals.cacheTokens)}</strong></div>
      <div class="stat-card"><span>Costo</span><strong>${formatUsd(provider.totals.costUsd)}</strong><small>estimado / reportado</small></div>
    </div>
    <div class="sparkline" aria-label="Uso por bucket de ${escapeHtml(provider.name)}">${renderSparkline(provider)}</div>
    <div class="model-list"><div class="section-title">Modelos principales</div>${models}</div>
    <p class="provider-note">${escapeHtml(provider.message ?? '')} Actualizado ${timeAgo(provider.lastUpdated)}.</p>
  </section>`;
}

function render() {
  if (!state.data) return;
  const combined = state.data.providers.reduce((total, provider) => ({
    tokens: total.tokens + provider.totals.totalTokens,
    cost: total.cost + provider.totals.costUsd,
    live: total.live + (provider.source === 'live' ? 1 : 0)
  }), { tokens: 0, cost: 0, live: 0 });
  $('#summary-time').textContent = `Generado ${timeAgo(state.data.generatedAt)}`;
  $('#summary-tokens').textContent = formatTokens(combined.tokens);
  $('#summary-detail').textContent = `tokens combinados · ${formatUsd(combined.cost)} · ${combined.live}/2 conexiones live`;
  providersEl.innerHTML = state.data.providers.map(renderProvider).join('');
}

async function loadUsage() {
  state.loading = true;
  $('#refresh').disabled = true;
  errorEl.classList.add('hidden');
  try {
    const response = await fetch(`/api/usage?rangeHours=${state.rangeHours}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    state.data = await response.json();
    render();
  } catch (error) {
    errorEl.textContent = error instanceof Error ? error.message : 'No se pudo cargar el uso.';
    errorEl.classList.remove('hidden');
  } finally {
    state.loading = false;
    $('#refresh').disabled = false;
  }
}

function updateProviderHints() {
  const provider = $('#provider-select').value;
  $('#api-key').placeholder = providerLabels[provider].placeholder;
  $('#organization-id').placeholder = provider === 'openai' ? 'org_…' : 'No requerido';
  $('#organization-id').disabled = provider === 'anthropic';
}

async function saveConnection(event) {
  event.preventDefault();
  formMessage.classList.add('hidden');
  const provider = $('#provider-select').value;
  const apiKey = $('#api-key').value;
  const organizationId = $('#organization-id').value;
  $('#save-connection').disabled = true;
  try {
    const response = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey, organizationId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? 'No se pudo guardar la conexión.');
    formMessage.textContent = 'Conexión guardada en memoria local del servidor.';
    $('#api-key').value = '';
    await loadUsage();
  } catch (error) {
    formMessage.textContent = error instanceof Error ? error.message : 'Error inesperado.';
  } finally {
    formMessage.classList.remove('hidden');
    $('#save-connection').disabled = false;
  }
}

$('#range').addEventListener('change', (event) => { state.rangeHours = Number(event.target.value); void loadUsage(); });
$('#refresh').addEventListener('click', () => void loadUsage());
$('#open-modal').addEventListener('click', () => modal.classList.remove('hidden'));
$('#close-modal').addEventListener('click', () => modal.classList.add('hidden'));
$('#provider-select').addEventListener('change', updateProviderHints);
$('#connection-form').addEventListener('submit', saveConnection);

updateProviderHints();
void loadUsage();
window.setInterval(() => void loadUsage(), 60_000);
