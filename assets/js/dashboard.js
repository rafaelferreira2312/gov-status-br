const STATUS_LABELS = {
  online: 'ONLINE',
  unstable: 'INSTÁVEL',
  offline: 'FORA DO AR',
};

const SPHERE_LABELS = {
  federal: 'Federal',
  state: 'Estadual',
  municipal: 'Municipal',
};

let agenciesData = [];
let statusData = null;
let activeFilter = 'all';
let searchQuery = '';

async function loadData() {
  const [agenciesRes, statusRes] = await Promise.all([
    fetch('data/agencies.json?_=' + Date.now()),
    fetch('data/status.json?_=' + Date.now()),
  ]);

  const agenciesJson = await agenciesRes.json();
  statusData = await statusRes.json();
  agenciesData = agenciesJson.agencies || [];
  return { agenciesData, statusData };
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR');
}

function drawSparkline(canvas, values) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.scale(2, 2);
  const cw = w / 2;
  const ch = h / 2;

  ctx.clearRect(0, 0, cw, ch);
  if (!values || values.length < 2) {
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, ch / 2);
    ctx.lineTo(cw, ch / 2);
    ctx.stroke();
    return;
  }

  const max = Math.max(...values, 100);
  const color = values[values.length - 1] > 3000 ? '#eab308' : '#22c55e';

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * cw;
    const y = ch - (v / max) * (ch - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderAlert() {
  const el = document.getElementById('alert-banner');
  if (!el || !statusData?.alert) return;

  if (!statusData.alert.active) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden', 'warning', 'critical');
  el.classList.add(statusData.alert.level === 'critical' ? '' : 'warning');
  el.querySelector('[data-alert-msg]').textContent = statusData.alert.message;
  el.querySelector('[data-alert-sub]').textContent =
    `Status Geral: ${statusData.global.uptime_percent}% operacional · ${statusData.global.problems} com problemas`;
}

function renderStats() {
  const g = statusData?.global;
  if (!g) return;

  document.getElementById('stat-total').textContent = g.total;
  document.getElementById('stat-problems').textContent = g.problems;
  document.getElementById('stat-online').textContent = g.online;
  document.getElementById('stat-uptime').textContent = g.uptime_percent + '%';

  const updated = document.getElementById('last-update');
  if (updated) updated.textContent = 'Atualizado: ' + formatTime(statusData.updated_at);
}

function getFilteredAgencies() {
  return agenciesData
    .filter(a => {
      if (activeFilter !== 'all' && a.sphere !== activeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return a.name.toLowerCase().includes(q) || a.slug.includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      const sa = statusData?.agencies?.[a.id]?.status || 'online';
      const sb = statusData?.agencies?.[b.id]?.status || 'online';
      const order = { offline: 0, unstable: 1, online: 2 };
      return (order[sa] ?? 2) - (order[sb] ?? 2);
    });
}

function renderCards() {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;

  const list = getFilteredAgencies();

  if (list.length === 0) {
    grid.innerHTML = '<div class="empty-state">Nenhum órgão encontrado.</div>';
    return;
  }

  grid.innerHTML = list.map(agency => {
    const st = statusData?.agencies?.[agency.id] || {};
    const status = st.status || 'online';
    const sphere = SPHERE_LABELS[agency.sphere] || agency.sphere;
    const stateBadge = agency.state_letter ? ` · ${agency.state_letter}` : '';
    const logo = agency.logo_url || 'assets/img/logo.png';

    return `
      <article class="card ${status}" onclick="location.href='orgao.html?slug=${agency.slug}'">
        <div class="card-header">
          <div class="card-org">
            <img src="${logo}" alt="" loading="lazy" onerror="this.src='assets/img/logo.png'">
            <div>
              <h3>${agency.name}</h3>
              <small>${sphere}${stateBadge}</small>
            </div>
          </div>
          <span class="badge ${status}">${STATUS_LABELS[status] || status}</span>
        </div>
        <canvas class="sparkline" data-spark="${agency.id}"></canvas>
        <div class="card-metrics">
          <div><label>Tempo Online (24h)</label><strong>${st.uptime_24h ?? '—'}%</strong></div>
          <div><label>Latência Atual</label><strong>${st.response_time_ms ?? '—'} ms</strong></div>
          <div><label>Última Checagem</label><strong>${formatTime(st.last_check)}</strong></div>
        </div>
      </article>
    `;
  }).join('');

  list.forEach(agency => {
    const canvas = grid.querySelector(`[data-spark="${agency.id}"]`);
    const hist = statusData?.agencies?.[agency.id]?.latency_history || [];
    if (canvas) drawSparkline(canvas, hist);
  });
}

function setupFilters() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      renderCards();
    });
  });

  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', e => {
      searchQuery = e.target.value.trim();
      renderCards();
    });
  }
}

async function init() {
  try {
    await loadData();
    renderAlert();
    renderStats();
    renderCards();
    setupFilters();
  } catch (err) {
    document.getElementById('cards-grid').innerHTML =
      '<div class="empty-state">Erro ao carregar dados. Execute o monitor: <code>php scripts/monitor.php</code></div>';
    console.error(err);
  }
}

init();
setInterval(async () => {
  try {
    await loadData();
    renderAlert();
    renderStats();
    renderCards();
  } catch (_) {}
}, 60000);
