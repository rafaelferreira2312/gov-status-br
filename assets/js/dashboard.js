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
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getStatus(agencyId) {
  return statusData?.agencies?.[agencyId]?.status || 'online';
}

function drawSparkline(canvas, values, status) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.scale(2, 2);
  const cw = w / 2;
  const ch = h / 2;

  ctx.clearRect(0, 0, cw, ch);

  if (status === 'offline') {
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = +2;
    ctx.beginPath();
    ctx.moveTo(0, ch / 2);
    ctx.lineTo(cw, ch / 2);
    ctx.stroke();
    return;
  }

  if (!values || values.length < 2) {
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, ch * 0.7);
    ctx.lineTo(cw, ch * 0.3);
    ctx.stroke();
    return;
  }

  const max = Math.max(...values, 100);
  const last = values[values.length - 1];
  const color = status === 'unstable' || last > 5000 ? '#facc15' : '#22c55e';

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * cw;
    const y = ch - (v / max) * (ch - 8) - 4;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function cardHtml(agency) {
  const st = statusData?.agencies?.[agency.id] || {};
  const status = st.status || 'online';
  const sphere = SPHERE_LABELS[agency.sphere] || agency.sphere;
  const stateBadge = agency.state_letter ? ` · ${agency.state_letter}` : '';
  const logo = agency.logo_url || 'assets/img/logo.png';

  return `
    <article class="card ${status}" onclick="location.href='orgao.html?slug=${agency.slug}'">
      <div class="card-header">
        <div class="card-header-top">
          <div class="card-org">
            <img src="${logo}" alt="" loading="lazy" onerror="this.src='assets/img/logo.png'">
            <div class="card-org-info">
              <h3>${agency.name}</h3>
              <small>${sphere}${stateBadge}</small>
            </div>
          </div>
          <span class="badge ${status}">${STATUS_LABELS[status] || status}</span>
        </div>
      </div>
      <div class="sparkline-wrap">
        <canvas class="sparkline" data-spark="${agency.id}" data-status="${status}"></canvas>
      </div>
      <div class="card-metrics">
        <div><label>Tempo Online (24h)</label><strong>${st.uptime_24h ?? '—'}%</strong></div>
        <div><label>Latência Atual</label><strong>${st.response_time_ms ?? '—'} ms</strong></div>
        <div><label>Última Checagem</label><strong>${formatTime(st.last_check)}</strong></div>
      </div>
    </article>
  `;
}

function paintSparklines(container, list) {
  list.forEach(agency => {
    const canvas = container.querySelector(`[data-spark="${agency.id}"]`);
    const hist = statusData?.agencies?.[agency.id]?.latency_history || [];
    const status = getStatus(agency.id);
    if (canvas) drawSparkline(canvas, hist, status);
  });
}

function renderAlert() {
  const alertEl = document.getElementById('alert-banner');
  const okEl = document.getElementById('status-ok-banner');
  if (!alertEl || !statusData?.alert) return;

  if (statusData.alert.active) {
    alertEl.classList.remove('hidden');
    okEl.classList.add('hidden');
    alertEl.classList.toggle('warning', statusData.alert.level !== 'critical');
    alertEl.querySelector('[data-alert-msg]').textContent = statusData.alert.message;
    alertEl.querySelector('[data-alert-sub]').textContent =
      `Status Geral da Infraestrutura: ${statusData.alert.level === 'critical' ? 'Crítico (Alerta Vermelho)' : 'Atenção (Alerta Amarelo)'} · ${statusData.global.uptime_percent}% operacional`;
  } else {
    alertEl.classList.add('hidden');
    okEl.classList.remove('hidden');
    okEl.querySelector('[data-ok-msg]').textContent =
      `${statusData.global.uptime_percent}% dos serviços operando normalmente neste momento`;
    okEl.querySelector('[data-ok-sub]').textContent =
      `${statusData.global.online} de ${statusData.global.total} órgãos online · ${statusData.global.problems} com problemas`;
  }
}

function renderStats() {
  const g = statusData?.global;
  if (!g) return;

  document.getElementById('stat-total').textContent = g.total;
  document.getElementById('stat-problems').textContent = g.problems;
  document.getElementById('stat-online').textContent = g.online;
  document.getElementById('stat-uptime').textContent = g.uptime_percent + '%';

  const bar = document.getElementById('uptime-bar');
  if (bar) bar.style.width = g.uptime_percent + '%';

  const updated = document.getElementById('last-update');
  if (updated) updated.textContent = 'Atualizado: ' + formatTime(statusData.updated_at);

  const activity = document.getElementById('stat-activity');
  if (activity && statusData.alert?.active) {
    activity.textContent = statusData.alert.message;
  } else if (activity) {
    activity.textContent = `Monitorando ${g.total} portais governamentais em tempo real.`;
  }
}

function getFilteredAgencies() {
  return agenciesData
    .filter(a => {
      if (activeFilter === 'essential' && a.category !== 'essential') return false;
      if (['federal', 'state', 'municipal'].includes(activeFilter) && a.sphere !== activeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return a.name.toLowerCase().includes(q) || a.slug.includes(q) ||
          (a.state_letter && a.state_letter.toLowerCase() === q);
      }
      return true;
    })
    .sort((a, b) => {
      const order = { offline: 0, unstable: 1, online: 2 };
      return (order[getStatus(a.id)] ?? 2) - (order[getStatus(b.id)] ?? 2);
    });
}

function renderCritical() {
  const section = document.getElementById('critical-section');
  const grid = document.getElementById('critical-grid');
  if (!section || !grid) return;

  const critical = agenciesData.filter(a => {
    const s = getStatus(a.id);
    return s === 'offline' || s === 'unstable';
  }).sort((a, b) => {
    const order = { offline: 0, unstable: 1 };
    return (order[getStatus(a.id)] ?? 1) - (order[getStatus(b.id)] ?? 1);
  });

  if (critical.length === 0 || activeFilter !== 'all') {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  grid.innerHTML = critical.map(cardHtml).join('');
  paintSparklines(grid, critical);
}

function renderCards() {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;

  const list = getFilteredAgencies();

  if (list.length === 0) {
    grid.innerHTML = '<div class="empty-state">Nenhum órgão encontrado.</div>';
    return;
  }

  grid.innerHTML = list.map(cardHtml).join('');
  paintSparklines(grid, list);
  renderCritical();
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
