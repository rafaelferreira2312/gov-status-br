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

function getSlug() {
  return new URLSearchParams(location.search).get('slug');
}

function formatDateTime(ts) {
  return new Date(ts * 1000).toLocaleString('pt-BR');
}

async function loadData() {
  const slug = getSlug();
  const [agenciesRes, statusRes, historyRes] = await Promise.all([
    fetch('data/agencies.json'),
    fetch('data/status.json?_=' + Date.now()),
    fetch('data/history.json?_=' + Date.now()),
  ]);

  const agenciesJson = await agenciesRes.json();
  const status = await statusRes.json();
  const history = await historyRes.json();

  const agency = (agenciesJson.agencies || []).find(a => a.slug === slug);
  if (!agency) throw new Error('Órgão não encontrado');

  return { agency, status: status.agencies?.[agency.id], history: history[agency.id] || [], globalUpdated: status.updated_at };
}

function drawLatencyChart(canvas, entries) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.scale(2, 2);
  const cw = w / 2;
  const ch = h / 2;

  ctx.clearRect(0, 0, cw, ch);
  const slice = entries.slice(-48);
  if (slice.length < 2) return;

  const values = slice.map(e => e.ms || 0);
  const max = Math.max(...values, 200);

  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * cw;
    const y = ch - (v / max) * (ch - 10) - 5;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '10px Inter, sans-serif';
  ctx.fillText('0 ms', 4, ch - 4);
  ctx.fillText(max + ' ms', 4, 12);
}

function renderUptimeGrid(container, entries) {
  container.innerHTML = '';
  const days = 30;
  const buckets = [];

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = Math.floor(Date.now() / 1000) - i * 86400;
    const dayEnd = dayStart + 86400;
    const dayEntries = entries.filter(e => e.t >= dayStart && e.t < dayEnd);
    if (dayEntries.length === 0) {
      buckets.push('empty');
    } else {
      const online = dayEntries.filter(e => e.online).length / dayEntries.length;
      buckets.push(online >= 0.95 ? 'ok' : online >= 0.7 ? 'warn' : 'down');
    }
  }

  buckets.forEach(b => {
    const cell = document.createElement('div');
    cell.className = 'uptime-cell' + (b === 'ok' ? '' : b === 'warn' ? ' warn' : b === 'down' ? ' down' : ' empty');
    cell.title = b === 'ok' ? 'Estável' : b === 'warn' ? 'Instável' : b === 'down' ? 'Indisponível' : 'Sem dados';
    container.appendChild(cell);
  });
}

function renderTimeline(list, incidents) {
  if (!incidents || incidents.length === 0) {
    list.innerHTML = '<li><span>Nenhum incidente registrado recentemente.</span></li>';
    return;
  }

  list.innerHTML = incidents.map(inc => {
    const start = formatDateTime(inc.start);
    const end = inc.end ? formatDateTime(inc.end) : 'Em andamento';
    const dur = inc.duration_min ? ` · ${inc.duration_min} min` : '';
    return `<li>
      <time>${start}</time>
      <span>Instabilidade detectada (HTTP ${inc.status_code || '—'}). Retorno: ${end}${dur}</span>
    </li>`;
  }).join('');
}

async function init() {
  const slug = getSlug();
  if (!slug) {
    location.href = 'index.html';
    return;
  }

  try {
    const { agency, status, history, globalUpdated } = await loadData();
    const st = status || { status: 'online', response_time_ms: 0, uptime_24h: 100 };

    document.title = `${agency.name} — GovStatus BR`;
    document.getElementById('org-name').textContent = agency.name;
    document.getElementById('org-logo').src = agency.logo_url || 'assets/img/logo.png';
    document.getElementById('org-logo').onerror = () => { document.getElementById('org-logo').src = 'assets/img/logo.png'; };
    document.getElementById('org-sphere').textContent = (SPHERE_LABELS[agency.sphere] || agency.sphere) + (agency.state_letter ? ` · ${agency.state_letter}` : '');
    document.getElementById('org-url').href = agency.base_url;
    document.getElementById('org-url').textContent = agency.base_url;
    document.getElementById('org-status').textContent = STATUS_LABELS[st.status] || st.status;
    document.getElementById('org-status').className = 'badge ' + (st.status || 'online');
    document.getElementById('org-latency').textContent = (st.response_time_ms ?? '—') + ' ms';
    document.getElementById('org-uptime').textContent = (st.uptime_24h ?? '—') + '%';

    const contacts = document.getElementById('org-contacts');
    if (agency.contacts?.length) {
      contacts.innerHTML = agency.contacts.map(c =>
        `<span class="chip">${c.type}: ${c.value}</span>`
      ).join('');
    } else {
      contacts.innerHTML = '<span class="chip">Contatos serão descobertos pelo robô (--discover)</span>';
    }

    const contingency = document.getElementById('contingency');
    if (st.status === 'offline' || st.status === 'unstable') {
      contingency.classList.remove('hidden');
      contingency.querySelector('p').textContent =
        st.status === 'offline'
          ? `O site principal (${agency.base_url}) está inacessível neste momento. Tente novamente mais tarde ou utilize os canais alternativos abaixo.`
          : `O site apresenta lentidão ou erros intermitentes. Latência atual: ${st.response_time_ms} ms.`;
    }

    drawLatencyChart(document.getElementById('latency-chart'), history);
    renderUptimeGrid(document.getElementById('uptime-grid'), history);
    renderTimeline(document.getElementById('timeline'), st.incidents || []);

    document.getElementById('last-update').textContent = 'Atualizado: ' + new Date(globalUpdated).toLocaleString('pt-BR');
  } catch (err) {
    document.querySelector('.detail-grid').innerHTML =
      '<div class="panel"><p>Órgão não encontrado ou dados indisponíveis. <a href="index.html">Voltar</a></p></div>';
  }
}

init();
