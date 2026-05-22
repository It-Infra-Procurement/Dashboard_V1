'use strict';

/* ================================================================
   IT Infrastructure Procurement Dashboard — script.js
   ================================================================
   Data flow:
   1. User uploads CSV exports from Power BI (tab- or semicolon-separated)
   2. parseCSV() converts raw text to array of row objects
   3. loadSpendData() / loadContractData() filter for IT Infrastructure
      and map to clean typed objects
   4. checkAndRender() updates all panels whenever either file loads
   ================================================================ */

// ── State ─────────────────────────────────────────────────────────
let spendData    = [];   // [{supplier, country, spend, ...}]
let contractData = [];   // [{id, supplier, status, expiryDate, ...}]
let charts       = {};   // Chart.js instances, keyed by canvas id

// ── Formatting utils ──────────────────────────────────────────────
const fmt = {

  currency(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1e6) return '€' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '€' + Math.round(v / 1e3) + 'k';
    return '€' + Math.round(v).toLocaleString('de-DE');
  },

  date(d) {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  },

  daysLeft(d) {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return null;
    return Math.round((d.getTime() - Date.now()) / 86400000);
  },

  initials(name) {
    return (name || '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  }
};

// ── Date conversion ────────────────────────────────────────────────
// Power BI exports Excel serial dates (e.g. 44431 = 2021-08-15).
// The function also handles ISO date strings as fallback.
function excelToDate(val) {
  if (!val || val === '' || val.toLowerCase() === 'unclassified') return null;
  const n = parseFloat(val);
  if (!isNaN(n) && n > 40000 && n < 65000) {
    // Excel epoch: days since 1900-01-01 with Lotus 1-2-3 leap-year bug correction
    return new Date((n - 25569) * 86400000);
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ── CSV Parsing ────────────────────────────────────────────────────
function detectSep(line) {
  const t = (line.match(/\t/g)  || []).length;
  const s = (line.match(/;/g)   || []).length;
  const c = (line.match(/,/g)   || []).length;
  if (t >= s && t >= c) return '\t';
  if (s >= c)           return ';';
  return ',';
}

// Splits a single CSV line, respecting double-quoted fields.
function splitRow(line, sep) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (!inQ && ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  // Strip BOM and normalise line endings
  const clean = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  const lines  = clean.split('\n');
  if (lines.length < 2) return [];

  const sep     = detectSep(lines[0]);
  const headers = splitRow(lines[0], sep).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows    = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitRow(lines[i], sep);
    const row  = {};

    headers.forEach((h, idx) => {
      row[h] = (cols[idx] || '').trim().replace(/^"|"$/g, '');
    });

    // Extra columns beyond the header count → stored as _col{index}
    // The contract export has an unlabelled value column at the end.
    for (let j = headers.length; j < cols.length; j++) {
      row[`_col${j}`] = (cols[j] || '').trim().replace(/^"|"$/g, '');
    }
    rows.push(row);
  }
  return rows;
}

// Extracts the contract value from unlabelled trailing columns.
function extractValue(row) {
  let value = parseFloat(row['value'] || row['Value'] || row['Contract Value'] || '') || 0;
  if (!value) {
    // Try extra cols in ascending order; take the first positive numeric one
    const extraKeys = Object.keys(row)
      .filter(k => k.startsWith('_col'))
      .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
    for (const k of extraKeys) {
      const v = parseFloat(row[k]);
      if (!isNaN(v) && v > 0) { value = v; break; }
    }
  }
  return value;
}

// ── File Inputs ────────────────────────────────────────────────────
function setupFileInputs() {

  document.getElementById('f-spend').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadSpendData(ev.target.result);
    reader.readAsText(file, 'UTF-8');
  });

  document.getElementById('f-contracts').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadContractData(ev.target.result);
    reader.readAsText(file, 'UTF-8');
  });
}

// ── Data Loaders ──────────────────────────────────────────────────
function loadSpendData(text) {
  const rows = parseCSV(text);

  spendData = rows
    .filter(r => {
      const cat = (r['Category'] || r['OneProcurement Category'] || '').toLowerCase();
      return cat.includes('it infrastructure');
    })
    .map(r => ({
      supplier:    r['Supplier'] || '',
      oe:          r['OE'] || '',
      oeName:      r['OE Name as in Spend Visibility'] || '',
      country:     r['Company Site - Company Level 1'] || '',
      category:    r['Category'] || '',
      subcategory: r['Subcategory'] || '',
      spend:       parseFloat(r['Spend 2026'] || r['Spend'] || '0') || 0,
    }))
    .filter(r => r.spend > 0);

  const lbl = document.getElementById('lbl-spend');
  lbl.textContent = `✓ ${spendData.length} Einträge`;
  lbl.className = 'file-lbl loaded';
  checkAndRender();
}

function loadContractData(text) {
  const rows = parseCSV(text);

  contractData = rows
    .filter(r => {
      const cat = (r['OneProcurement Category'] || '').toLowerCase();
      return cat.includes('it infrastructure');
    })
    .map(r => ({
      id:            r['Contract Id'] || '',
      name:          r['Contract - Contract'] || '',
      supplier:      r['Affected Parties - Supplier Name (L1)'] || '',
      status:        r['Contract Status'] || '',
      compliant:     r['Compliant/Non-Compliant'] || '',
      category:      r['OneProcurement Category'] || '',
      hierarchy:     r['Hierarchy Type'] || '',
      referent:      r['Procurement referent'] || '',
      referentEmail: r['Procurement referent email'] || '',
      projectType:   r['Project Type'] || '',
      sourcing:      r['Sourcing Strategy'] || '',
      termType:      r['Term Type'] || '',
      effectiveDate: excelToDate(r['Effective Date - Date'] || r['Begin Date'] || ''),
      expiryDate:    excelToDate(r['Expiration Date - Date'] || ''),
      scope:         r['Global/Local Scope'] || '',
      stock2026:     r['Stock/Flow_2026'] || '',
      regionL1:      r['Region - Region (L1)'] || '',
      regionL2:      r['Region - Region (L2)'] || '',
      tprmId:        r['TPRM ID'] || '',
      value:         extractValue(r),
    }));

  const lbl = document.getElementById('lbl-contracts');
  lbl.textContent = `✓ ${contractData.length} Verträge`;
  lbl.className = 'file-lbl loaded';
  checkAndRender();
}

// ── Main Dispatcher ────────────────────────────────────────────────
function checkAndRender() {
  const hasData = spendData.length > 0 || contractData.length > 0;
  document.getElementById('empty').classList.toggle('hidden', hasData);
  document.getElementById('dash').classList.toggle('hidden', !hasData);
  if (!hasData) return;

  document.getElementById('last-upd').textContent =
    'Aktualisiert: ' + new Date().toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

  renderKPIs();
  renderSpend();
  renderContracts();
  renderExpiryWatch();
  renderReferents();
  updateExpiryBadge();
}

// ── KPI Bar ────────────────────────────────────────────────────────
function renderKPIs() {
  const totalSpend     = spendData.reduce((s, r) => s + r.spend, 0);
  const totalContracts = contractData.length;
  const published      = contractData.filter(c => c.status === 'Published').length;
  const compliant      = contractData.filter(c => c.compliant === 'Compliant').length;
  const totalValue     = contractData.reduce((s, c) => s + c.value, 0);
  const expiring30     = contractData.filter(c => {
    const d = fmt.daysLeft(c.expiryDate);
    return d !== null && d >= 0 && d <= 30 && c.status === 'Published';
  }).length;
  const compRate = totalContracts > 0 ? Math.round(compliant / totalContracts * 100) : 0;

  const kpis = [
    {
      label: 'Spend 2026',
      value: fmt.currency(totalSpend),
      sub:   'IT Infrastructure gesamt',
      icon:  'ti-chart-line',
    },
    {
      label: 'Contracts',
      value: totalContracts,
      sub:   `${published} published · ${totalContracts - published} expired`,
      icon:  'ti-file-text',
    },
    {
      label: 'Portfolio Value',
      value: fmt.currency(totalValue),
      sub:   'Vertragswerte gesamt',
      icon:  'ti-wallet',
    },
    {
      label:  'Compliance Rate',
      value:  compRate + '%',
      sub:    `${compliant} von ${totalContracts} compliant`,
      icon:   'ti-shield-check',
      accent: compRate >= 90 ? 'success' : compRate >= 70 ? 'warning' : 'danger',
    },
    {
      label:  'Expiring ≤ 30d',
      value:  expiring30,
      sub:    'Published · Dringende Renewals',
      icon:   'ti-alarm',
      accent: expiring30 > 0 ? 'danger' : '',
    },
  ];

  document.getElementById('kpis').innerHTML = kpis.map(k => `
    <div class="kpi">
      <div class="kpi-icon"><i class="ti ${k.icon}" aria-hidden="true"></i></div>
      <div class="kpi-body">
        <div class="kpi-lbl">${k.label}</div>
        <div class="kpi-val${k.accent ? ' accent-' + k.accent : ''}">${k.value}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>
    </div>
  `).join('');
}

// ── Spend Tab ──────────────────────────────────────────────────────
function renderSpend() {
  const panel = document.getElementById('panel-spend');

  if (!spendData.length) {
    panel.innerHTML = '<div class="no-data"><i class="ti ti-table" style="font-size:28px;display:block;margin-bottom:8px;"></i>Keine Spend-Daten geladen.<br>Lade den External Spend CSV-Export hoch.</div>';
    return;
  }

  // Aggregate by supplier and country
  const bySupplier = {};
  const byCountry  = {};
  spendData.forEach(r => {
    bySupplier[r.supplier] = (bySupplier[r.supplier] || 0) + r.spend;
    byCountry[r.country]   = (byCountry[r.country]   || 0) + r.spend;
  });

  const suppliers = Object.entries(bySupplier).sort((a, b) => b[1] - a[1]);
  const countries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]);
  const maxSpend  = suppliers[0]?.[1] || 1;

  // Supplier mini-bars
  const supList = document.getElementById('sup-list');
  if (supList) {
    supList.innerHTML = suppliers.map(([name, val]) => `
      <div class="sup-row">
        <span class="sup-name">${name}</span>
        <span class="sup-bar-wrap">
          <span class="sup-bar" style="width:${Math.round(val / maxSpend * 100)}%"></span>
        </span>
        <span class="sup-val">${fmt.currency(val)}</span>
      </div>
    `).join('');
  }

  const supTotal = document.getElementById('sup-total');
  if (supTotal) supTotal.textContent = `${suppliers.length} Lieferanten`;

  // Chart colours
  const isDark    = matchMedia('(prefers-color-scheme: dark)').matches;
  const colPrimary = isDark ? '#3b82f6' : '#1a56db';
  const colOther   = isDark ? '#1e3a5f' : '#bfdbfe';
  const gridColor  = isDark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)';
  const tickColor  = isDark ? '#64748b' : '#9ca3af';

  // Supplier bar chart (top 12, horizontal)
  destroyChart('ch-suppliers');
  const top = suppliers.slice(0, 12);
  const ctx1 = document.getElementById('ch-suppliers');
  if (ctx1) {
    charts['ch-suppliers'] = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels:   top.map(([n]) => n),
        datasets: [{
          label: 'Spend 2026',
          data:  top.map(([, v]) => Math.round(v)),
          backgroundColor: top.map((_, i) => i === 0 ? colPrimary : colOther),
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => '  ' + fmt.currency(c.raw) } }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: tickColor, font: { size: 10 }, callback: v => fmt.currency(v) }
          },
          y: {
            grid: { display: false },
            ticks: { color: tickColor, font: { size: 10 }, autoSkip: false }
          }
        }
      }
    });
  }

  // Country bar chart
  destroyChart('ch-country');
  const ctx2 = document.getElementById('ch-country');
  if (ctx2) {
    charts['ch-country'] = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels:   countries.map(([c]) => c),
        datasets: [{
          label: 'Spend',
          data:  countries.map(([, v]) => Math.round(v)),
          backgroundColor: countries.map((_, i) => i === 0 ? colPrimary : colOther),
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => '  ' + fmt.currency(c.raw) } }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: tickColor, font: { size: 11 }, autoSkip: false, maxRotation: 35 }
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: tickColor, font: { size: 10 }, callback: v => fmt.currency(v) }
          }
        }
      }
    });
  }
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ── Contracts Tab ──────────────────────────────────────────────────
function renderContracts() {
  if (!contractData.length) {
    document.getElementById('c-tbody').innerHTML =
      '<tr><td colspan="11" class="no-data">Keine Contract-Daten geladen.</td></tr>';
    return;
  }

  // Populate dynamic filter dropdowns once
  populateSelect('c-region',   'Alle Regionen',  [...new Set(contractData.map(c => c.regionL2).filter(Boolean))].sort());
  populateSelect('c-referent', 'Alle Referenten', [...new Set(contractData.map(c => c.referent).filter(Boolean))].sort());

  // Read filter values
  const q  = (document.getElementById('c-search')?.value    || '').toLowerCase();
  const st = document.getElementById('c-status')?.value     || '';
  const cp = document.getElementById('c-compliance')?.value || '';
  const hy = document.getElementById('c-hierarchy')?.value  || '';
  const rg = document.getElementById('c-region')?.value     || '';
  const rf = document.getElementById('c-referent')?.value   || '';

  const filtered = contractData.filter(c =>
    (!st || c.status    === st) &&
    (!cp || c.compliant === cp) &&
    (!hy || c.hierarchy === hy) &&
    (!rg || c.regionL2  === rg) &&
    (!rf || c.referent  === rf) &&
    (!q  || c.supplier.toLowerCase().includes(q)
         || c.id.toLowerCase().includes(q)
         || c.name.toLowerCase().includes(q))
  );

  const countEl = document.getElementById('c-count');
  if (countEl) countEl.textContent = `${filtered.length} / ${contractData.length} Verträge`;

  document.getElementById('c-tbody').innerHTML = filtered.map(c => {
    const days = fmt.daysLeft(c.expiryDate);
    let expiryClass = '';
    let daysPill    = '';
    if (days !== null) {
      if (days < 0)       expiryClass = 'exp-past';
      else if (days <= 30) { expiryClass = 'exp-red'; }
      else if (days <= 90) { expiryClass = 'exp-orange'; }
      else if (days <= 180){ expiryClass = 'exp-yellow'; }
      if (days >= 0 && days <= 90) {
        daysPill = `<span class="days-pill">+${days}d</span>`;
      }
    }

    const statusBadge = c.status === 'Published'
      ? '<span class="badge badge-success">Published</span>'
      : '<span class="badge badge-neutral">Expired</span>';

    const compBadge = c.compliant === 'Non-Compliant'
      ? '<span class="badge badge-danger">Non-Compliant</span>'
      : '<span class="badge badge-info">Compliant</span>';

    const hierShort = (c.hierarchy || '—').replace(' Agreement', '');

    return `<tr>
      <td class="col-id">${c.id}</td>
      <td class="txt-ellipsis" title="${c.supplier}">${c.supplier || '—'}</td>
      <td>${statusBadge}</td>
      <td>${compBadge}</td>
      <td class="txt-sm">${hierShort}</td>
      <td class="txt-sm txt-muted">${c.regionL2 || c.regionL1 || '—'}</td>
      <td class="txt-sm txt-ellipsis" title="${c.referent}">${c.referent || '—'}</td>
      <td class="txt-sm mono ${expiryClass}">${fmt.date(c.expiryDate)}${daysPill}</td>
      <td class="txt-sm">${c.termType || '—'}</td>
      <td class="txt-sm">${(c.scope || '—').replace(' Scope', '')}</td>
      <td class="col-val">${fmt.currency(c.value)}</td>
    </tr>`;
  }).join('');
}

// Helper: populate a <select> element once (skip if already populated)
function populateSelect(id, defaultLabel, options) {
  const el = document.getElementById(id);
  if (!el || el.options.length > 1) return;
  el.innerHTML = `<option value="">${defaultLabel}</option>` +
    options.map(o => `<option value="${o}">${o}</option>`).join('');
}

// ── Expiry Watch Tab ───────────────────────────────────────────────
function renderExpiryWatch() {
  const now = Date.now();

  // Published contracts with an expiry date that has already passed
  const overduePublished = contractData.filter(c =>
    c.status === 'Published' && c.expiryDate && c.expiryDate.getTime() < now
  );
  // Published contracts expiring in ≤ 30 days
  const soon30 = contractData.filter(c => {
    const d = fmt.daysLeft(c.expiryDate);
    return d !== null && d >= 0 && d <= 30 && c.status === 'Published';
  });
  const urgent = [...overduePublished, ...soon30];

  const soon31_90 = contractData.filter(c => {
    const d = fmt.daysLeft(c.expiryDate);
    return d !== null && d > 30 && d <= 90 && c.status === 'Published';
  });
  const soon91_180 = contractData.filter(c => {
    const d = fmt.daysLeft(c.expiryDate);
    return d !== null && d > 90 && d <= 180 && c.status === 'Published';
  });

  const atRiskValue30  = urgent.reduce((s, c) => s + c.value, 0);
  const atRiskValue90  = soon31_90.reduce((s, c) => s + c.value, 0);

  // Expiry KPIs
  document.getElementById('expiry-kpis').innerHTML = [
    {
      label: 'Überfällig / kritisch',
      value: urgent.length,
      sub:   `${fmt.currency(atRiskValue30)} gefährdet`,
      icon:  'ti-alert-circle',
      accent: urgent.length > 0 ? 'danger' : '',
    },
    {
      label: 'Expiring 31–90 Tage',
      value: soon31_90.length,
      sub:   `${fmt.currency(atRiskValue90)} · Renewal nötig`,
      icon:  'ti-clock',
      accent: soon31_90.length > 0 ? 'warning' : '',
    },
    {
      label: 'Expiring 91–180 Tage',
      value: soon91_180.length,
      sub:   'Renewal-Pipeline planen',
      icon:  'ti-calendar',
    },
    {
      label: 'Published gesamt',
      value: contractData.filter(c => c.status === 'Published').length,
      sub:   'Aktive Verträge IT Infra',
      icon:  'ti-file-check',
    },
  ].map(k => `
    <div class="kpi">
      <div class="kpi-icon"><i class="ti ${k.icon}" aria-hidden="true"></i></div>
      <div class="kpi-body">
        <div class="kpi-lbl">${k.label}</div>
        <div class="kpi-val${k.accent ? ' accent-' + k.accent : ''}">${k.value}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>
    </div>
  `).join('');

  // Card renderer for each column
  const makeCards = (list, colourClass) => {
    if (!list.length) return '<div class="expiry-empty">Keine Verträge in diesem Zeitraum.</div>';
    return list
      .sort((a, b) => (a.expiryDate?.getTime() || 0) - (b.expiryDate?.getTime() || 0))
      .map(c => {
        const days   = fmt.daysLeft(c.expiryDate);
        const dStr   = days === null ? ''
          : days < 0 ? `${Math.abs(days)}d überfällig`
          : `${days}d verbleibend`;
        const dClass = days !== null && days > 30 ? 'ok' : '';
        return `<div class="expiry-card">
          <div class="expiry-card-top">
            <span class="mono txt-sm txt-blue">${c.id}</span>
            <span class="expiry-days ${dClass}">${dStr}</span>
          </div>
          <div class="expiry-card-sup" title="${c.supplier}">${c.supplier}</div>
          <div class="expiry-card-meta">
            <span>${c.regionL2 || c.regionL1 || '—'}</span>
            <span>·</span>
            <span>${c.referent || '—'}</span>
            <span>·</span>
            <span class="mono">${fmt.currency(c.value)}</span>
          </div>
          <div class="expiry-card-date">${fmt.date(c.expiryDate)}</div>
        </div>`;
      }).join('');
  };

  document.getElementById('exp-red-list').innerHTML    = makeCards(urgent,     'danger');
  document.getElementById('exp-orange-list').innerHTML = makeCards(soon31_90,  'warning');
  document.getElementById('exp-yellow-list').innerHTML = makeCards(soon91_180, 'info');
}

function updateExpiryBadge() {
  const n = contractData.filter(c => {
    const d = fmt.daysLeft(c.expiryDate);
    return d !== null && d >= 0 && d <= 30 && c.status === 'Published';
  }).length;
  const badge = document.getElementById('expiry-badge');
  if (badge) {
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  }
}

// ── By Referent Tab ────────────────────────────────────────────────
function renderReferents() {
  if (!contractData.length) {
    document.getElementById('ref-grid').innerHTML = '<div class="no-data">Keine Daten geladen.</div>';
    return;
  }

  // Aggregate per referent
  const byRef = {};
  contractData.forEach(c => {
    const key = c.referent || 'Unbekannt';
    if (!byRef[key]) byRef[key] = {
      name: key, email: c.referentEmail,
      total: 0, value: 0,
      published: 0, compliant: 0, expiring90: 0,
    };
    const r = byRef[key];
    r.total++;
    r.value += c.value;
    if (c.status === 'Published') r.published++;
    if (c.compliant === 'Compliant') r.compliant++;
    const d = fmt.daysLeft(c.expiryDate);
    if (d !== null && d >= 0 && d <= 90 && c.status === 'Published') r.expiring90++;
  });

  const refs = Object.values(byRef).sort((a, b) => b.value - a.value);
  const topValue = refs[0]?.value || 1;

  // Summary KPIs
  document.getElementById('ref-kpis').innerHTML = `
    <div class="kpi">
      <div class="kpi-icon"><i class="ti ti-users" aria-hidden="true"></i></div>
      <div class="kpi-body">
        <div class="kpi-lbl">Referenten aktiv</div>
        <div class="kpi-val">${refs.length}</div>
        <div class="kpi-sub">IT Infrastructure</div>
      </div>
    </div>
    <div class="kpi">
      <div class="kpi-icon"><i class="ti ti-trophy" aria-hidden="true"></i></div>
      <div class="kpi-body">
        <div class="kpi-lbl">Größtes Portfolio</div>
        <div class="kpi-val" style="font-size:15px;">${refs[0]?.name.split(' ').slice(0,1).join(' ') || '—'}</div>
        <div class="kpi-sub">${fmt.currency(refs[0]?.value || 0)}</div>
      </div>
    </div>
  `;

  document.getElementById('ref-grid').innerHTML = refs.map(r => {
    const compRate    = r.total > 0 ? Math.round(r.compliant / r.total * 100) : 0;
    const valueShare  = Math.round(r.value / topValue * 100);
    const initials    = fmt.initials(r.name);
    return `<div class="ref-card">
      <div class="ref-card-top">
        <div class="ref-avatar">${initials}</div>
        <div>
          <div class="ref-name">${r.name}</div>
          ${r.email ? `<a class="ref-email" href="mailto:${r.email}">${r.email}</a>` : ''}
        </div>
      </div>

      <!-- Portfolio value bar -->
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-bottom:4px;">
          <span>Portfolio</span><span class="mono">${fmt.currency(r.value)}</span>
        </div>
        <div class="sup-bar-wrap" style="height:6px;">
          <div class="sup-bar" style="width:${valueShare}%;"></div>
        </div>
      </div>

      <div class="ref-stats">
        <div class="ref-stat">
          <div class="ref-stat-val">${r.total}</div>
          <div class="ref-stat-lbl">Contracts</div>
        </div>
        <div class="ref-stat">
          <div class="ref-stat-val">${r.published}</div>
          <div class="ref-stat-lbl">Published</div>
        </div>
        <div class="ref-stat">
          <div class="ref-stat-val${compRate < 80 ? ' accent-warning' : ''}">${compRate}%</div>
          <div class="ref-stat-lbl">Compliant</div>
        </div>
        <div class="ref-stat">
          <div class="ref-stat-val${r.expiring90 > 0 ? ' accent-warning' : ''}">${r.expiring90}</div>
          <div class="ref-stat-lbl">Exp. 90d</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Tab Switching ──────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('tab-disabled')) return;
      const tab = btn.dataset.tab;
      if (!tab) return;

      document.querySelectorAll('.tab').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');

      const panel = document.getElementById('panel-' + tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupFileInputs();
  setupTabs();
});
