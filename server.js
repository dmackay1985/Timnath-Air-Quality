import express from 'express';
import pg from 'pg';

const { Client } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

async function getAirData() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    const res = await client.query(`
      SELECT observation_time, parameter, aqi, category, reporting_area
      FROM air_quality
      ORDER BY observation_time DESC
      LIMIT 5000
    `);
    return res.rows;
  } finally {
    await client.end();
  }
}

async function getWaterData() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    const res = await client.query(`
      SELECT observation_time, site_id, site_name, parameter_code, parameter_name, value, unit
      FROM water_levels
      ORDER BY observation_time DESC
      LIMIT 5000
    `);
    return res.rows;
  } catch (err) {
    // Table might not exist yet if water cron hasn't run
    console.error('Water query error:', err.message);
    return [];
  } finally {
    await client.end();
  }
}

// JSON API
app.get('/api/data', async (req, res) => {
  try {
    const rows = await getAirData();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/water', async (req, res) => {
  try {
    const rows = await getWaterData();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', async (req, res) => {
  try {
    const airRows = await getAirData();
    const waterRows = await getWaterData();
    
    // ===== AIR DATA PROCESSING =====
    const latestAir = {};
    for (const row of airRows) {
      if (!latestAir[row.parameter]) latestAir[row.parameter] = row;
    }
    
    const airByParam = { 'PM2.5': [], 'O3': [], 'PM10': [] };
    for (const row of airRows) {
      if (airByParam[row.parameter]) {
        airByParam[row.parameter].push(row);
      }
    }
    for (const key in airByParam) airByParam[key].reverse();
    
    // ===== WATER DATA PROCESSING =====
    // Map site IDs to friendly labels
    const SITE_LABELS = {
      '06752260': 'Poudre @ Fort Collins',
      '06752280': 'Poudre @ Timnath',
      '06737500': 'Horsetooth Reservoir',
      '06742015': 'Carter Lake'
    };
    
    // Get latest reading per (site, parameter) combo
    const latestWater = {};
    for (const row of waterRows) {
      const key = `${row.site_id}|${row.parameter_code}`;
      if (!latestWater[key]) latestWater[key] = row;
    }
    
    // Build chart series for flow (parameter 00060) at the two river sites
    const flowSeries = {};
    for (const row of waterRows) {
      if (row.parameter_code !== '00060') continue;
      const label = SITE_LABELS[row.site_id] || row.site_name;
      if (!flowSeries[label]) flowSeries[label] = [];
      flowSeries[label].push(row);
    }
    for (const key in flowSeries) flowSeries[key].reverse();
    
    // Build chart series for Horsetooth elevation (parameter 00062 at site 06737500)
    const horsetoothElev = waterRows
      .filter(r => r.site_id === '06737500' && r.parameter_code === '00062')
      .reverse();
    
    // Helper to get a specific water reading
    const getLatest = (siteId, paramCode) => {
      const row = latestWater[`${siteId}|${paramCode}`];
      return row ? row : null;
    };
    
    const poudreFC = getLatest('06752260', '00060');
    const poudreTim = getLatest('06752280', '00060');
    const horsetoothEl = getLatest('06737500', '00062');
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timnath Conditions</title>
<style>
  * { box-sizing: border-box; }
  body { 
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    margin: 0; padding: 2rem 1rem; background: #fafaf7; color: #1a1a1a;
    max-width: 900px; margin: 0 auto;
  }
  h1 { font-size: 28px; font-weight: 500; margin: 0 0 4px; }
  h2 { font-size: 18px; font-weight: 500; margin: 2rem 0 1rem; }
  .sub { color: #666; font-size: 14px; margin-bottom: 1.5rem; }
  
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #e5e5e0; margin-bottom: 1.5rem; }
  .tab { padding: 10px 18px; background: none; border: none; cursor: pointer; font-size: 14px; color: #666; border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit; }
  .tab.active { color: #1a1a1a; border-bottom-color: #378ADD; font-weight: 500; }
  .tab:hover:not(.active) { color: #333; }
  
  .panel { display: none; }
  .panel.active { display: block; }
  
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 1.5rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.25rem; border: 1px solid #eee; }
  .label { font-size: 13px; color: #666; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .value { font-size: 32px; font-weight: 500; margin: 0; }
  .unit { font-size: 14px; color: #666; font-weight: 400; }
  .cat { font-size: 13px; margin: 6px 0 0; }
  .good { color: #0F6E56; }
  .mod { color: #854F0B; }
  .bad { color: #A32D2D; }
  .info { color: #378ADD; }
  
  .ranges { display: flex; gap: 8px; margin-bottom: 1rem; flex-wrap: wrap; }
  .range-btn { padding: 6px 14px; border: 1px solid #ccc; background: white; color: #333; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; }
  .range-btn.active { background: #378ADD; color: white; border-color: #378ADD; }
  
  .chart-wrap { background: #fff; border-radius: 12px; padding: 1.5rem; border: 1px solid #eee; position: relative; height: 360px; margin-bottom: 1.5rem; }
  .legend { display: flex; gap: 16px; font-size: 13px; color: #666; margin-bottom: 12px; flex-wrap: wrap; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  
  footer { text-align: center; margin-top: 2rem; font-size: 12px; color: #888; }
  a { color: #378ADD; text-decoration: none; }
</style>
</head>
<body>
  <h1>Timnath Conditions</h1>
  <p class="sub">Live air and water data · updated hourly</p>
  
  <div class="tabs">
    <button class="tab active" data-tab="air" onclick="showTab('air')">Air</button>
    <button class="tab" data-tab="water" onclick="showTab('water')">Water</button>
    <button class="tab" data-tab="combined" onclick="showTab('combined')">Combined</button>
  </div>
  
  <!-- AIR TAB -->
  <div class="panel active" id="panel-air">
    <div class="cards">
      ${Object.entries(latestAir).map(([param, row]) => {
        const cat = row.category;
        const cls = cat === 'Good' ? 'good' : cat === 'Moderate' ? 'mod' : 'bad';
        return `
          <div class="card">
            <p class="label">${param}</p>
            <p class="value">${row.aqi}</p>
            <p class="cat ${cls}">${cat}</p>
          </div>
        `;
      }).join('')}
    </div>
    
    <div class="ranges">
      <button class="range-btn active" id="air-btn-hour" onclick="setAirView('hour')">24 hours</button>
      <button class="range-btn" id="air-btn-week" onclick="setAirView('week')">7 days</button>
      <button class="range-btn" id="air-btn-day" onclick="setAirView('day')">All days</button>
    </div>
    
    <div class="legend">
      <span><span class="dot" style="background:#378ADD"></span>PM2.5</span>
      <span><span class="dot" style="background:#0F6E56"></span>Ozone (O3)</span>
      <span><span class="dot" style="background:#BA7517"></span>PM10</span>
    </div>
    
    <div class="chart-wrap">
      <canvas id="air-chart"></canvas>
    </div>
  </div>
  
  <!-- WATER TAB -->
  <div class="panel" id="panel-water">
    <div class="cards">
      <div class="card">
        <p class="label">Poudre @ Fort Collins</p>
        <p class="value">${poudreFC ? Math.round(poudreFC.value) : '—'} <span class="unit">cfs</span></p>
        <p class="cat info">River flow</p>
      </div>
      <div class="card">
        <p class="label">Poudre @ Timnath</p>
        <p class="value">${poudreTim ? Math.round(poudreTim.value) : '—'} <span class="unit">cfs</span></p>
        <p class="cat info">River flow</p>
      </div>
     <div class="card" style="background: #f5f3ec; border-style: dashed;">
        <p class="label">Horsetooth</p>
        <p class="value" style="font-size: 18px; color: #666; font-weight: 400; margin-top: 8px;">Coming soon</p>
        <p class="cat" style="color: #888;">USBR integration</p>
      </div>
    </div>
    
    <div class="ranges">
      <button class="range-btn active" id="water-btn-hour" onclick="setWaterView('hour')">24 hours</button>
      <button class="range-btn" id="water-btn-week" onclick="setWaterView('week')">7 days</button>
      <button class="range-btn" id="water-btn-day" onclick="setWaterView('day')">All days</button>
    </div>
    
    <h2>Poudre river flow</h2>
    <div class="legend">
      <span><span class="dot" style="background:#378ADD"></span>Fort Collins</span>
      <span><span class="dot" style="background:#0F6E56"></span>Timnath</span>
    </div>
    <div class="chart-wrap">
      <canvas id="flow-chart"></canvas>
    </div>
    
    <h2>Horsetooth reservoir elevation</h2>
    <div class="legend">
      <span><span class="dot" style="background:#BA7517"></span>Elevation (ft)</span>
    </div>
    <div class="chart-wrap">
      <canvas id="reservoir-chart"></canvas>
    </div>
  </div>
  
  <!-- COMBINED TAB -->
  <div class="panel" id="panel-combined">
    <h2 style="margin-top: 0;">Air</h2>
    <div class="cards">
      ${Object.entries(latestAir).map(([param, row]) => {
        const cat = row.category;
        const cls = cat === 'Good' ? 'good' : cat === 'Moderate' ? 'mod' : 'bad';
        return `
          <div class="card">
            <p class="label">${param}</p>
            <p class="value">${row.aqi}</p>
            <p class="cat ${cls}">${cat}</p>
          </div>
        `;
      }).join('')}
    </div>
    
    <h2>Water</h2>
    <div class="cards">
      <div class="card">
        <p class="label">Poudre @ Fort Collins</p>
        <p class="value">${poudreFC ? Math.round(poudreFC.value) : '—'} <span class="unit">cfs</span></p>
        <p class="cat info">River flow</p>
      </div>
      <div class="card">
        <p class="label">Poudre @ Timnath</p>
        <p class="value">${poudreTim ? Math.round(poudreTim.value) : '—'} <span class="unit">cfs</span></p>
        <p class="cat info">River flow</p>
      </div>
      <div class="card">
        <p class="label">Horsetooth</p>
        <p class="value">${horsetoothEl ? Math.round(horsetoothEl.value * 10) / 10 : '—'} <span class="unit">ft</span></p>
        <p class="cat info">Reservoir elevation</p>
      </div>
    </div>
  </div>
  
  <footer>
    Air via <a href="https://airnow.gov">AirNow</a> · Water via <a href="https://waterservices.usgs.gov">USGS</a> · Built on <a href="https://render.com">Render</a>
  </footer>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
  // ===== AIR DATA =====
  const airRawData = {
    'PM2.5': ${JSON.stringify(airByParam['PM2.5'].map(r => ({ t: r.observation_time, v: r.aqi })))},
    'O3': ${JSON.stringify(airByParam['O3'].map(r => ({ t: r.observation_time, v: r.aqi })))},
    'PM10': ${JSON.stringify(airByParam['PM10'].map(r => ({ t: r.observation_time, v: r.aqi })))}
  };
  
  // ===== WATER DATA =====
  const flowRawData = {
    'Fort Collins': ${JSON.stringify((flowSeries['Poudre @ Fort Collins'] || []).map(r => ({ t: r.observation_time, v: parseFloat(r.value) })))},
    'Timnath': ${JSON.stringify((flowSeries['Poudre @ Timnath'] || []).map(r => ({ t: r.observation_time, v: parseFloat(r.value) })))}
  };
  
  const reservoirRawData = ${JSON.stringify(horsetoothElev.map(r => ({ t: r.observation_time, v: parseFloat(r.value) })))};
  
  // ===== BUCKETING HELPERS =====
  function bucketByDay(rows) {
    const buckets = {};
    for (const row of rows) {
      const d = new Date(row.t);
      const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(row.v);
    }
    return Object.entries(buckets).map(([label, values]) => ({
      label,
      avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    }));
  }
  
  function bucketByHour(rows) {
    return rows.map(row => ({
      label: new Date(row.t).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
      avg: Math.round(row.v * 10) / 10
    }));
  }
  
  // ===== AIR CHART =====
  let airChart;
  
  function renderAirChart(view) {
    let bucket;
    if (view === 'day') {
      bucket = bucketByDay;
    } else if (view === 'week') {
      bucket = (rows) => bucketByDay(rows).slice(-7);
    } else {
      bucket = (rows) => bucketByHour(rows).slice(-24);
    }
    
    const pm25 = bucket(airRawData['PM2.5']);
    const o3 = bucket(airRawData['O3']);
    const pm10 = bucket(airRawData['PM10']);
    
    if (airChart) airChart.destroy();
    
    airChart = new Chart(document.getElementById('air-chart'), {
      type: 'line',
      data: {
        labels: pm25.map(d => d.label),
        datasets: [
          { label: 'PM2.5', data: pm25.map(d => d.avg), borderColor: '#378ADD', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 },
          { label: 'Ozone', data: o3.map(d => d.avg), borderColor: '#0F6E56', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 },
          { label: 'PM10', data: pm10.map(d => d.avg), borderColor: '#BA7517', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, suggestedMax: 60, grid: { color: '#eee' } },
          x: { grid: { display: false } }
        }
      }
    });
  }
  
  function setAirView(view) {
    const buttons = {
      hour: document.getElementById('air-btn-hour'),
      week: document.getElementById('air-btn-week'),
      day: document.getElementById('air-btn-day')
    };
    for (const key in buttons) {
      if (key === view) buttons[key].classList.add('active');
      else buttons[key].classList.remove('active');
    }
    renderAirChart(view);
  }
  
  // ===== WATER CHARTS =====
  let flowChart, reservoirChart;
  
  function renderWaterCharts(view) {
    let bucket;
    if (view === 'day') {
      bucket = bucketByDay;
    } else if (view === 'week') {
      bucket = (rows) => bucketByDay(rows).slice(-7);
    } else {
      bucket = (rows) => bucketByHour(rows).slice(-24);
    }
    
    // Flow chart
    const fc = bucket(flowRawData['Fort Collins']);
    const tim = bucket(flowRawData['Timnath']);
    
    if (flowChart) flowChart.destroy();
    
    flowChart = new Chart(document.getElementById('flow-chart'), {
      type: 'line',
      data: {
        labels: fc.map(d => d.label),
        datasets: [
          { label: 'Fort Collins', data: fc.map(d => d.avg), borderColor: '#378ADD', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 },
          { label: 'Timnath', data: tim.map(d => d.avg), borderColor: '#0F6E56', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: '#eee' }, title: { display: true, text: 'cfs' } },
          x: { grid: { display: false } }
        }
      }
    });
    
    // Reservoir chart
    const res = bucket(reservoirRawData);
    
    if (reservoirChart) reservoirChart.destroy();
    
    reservoirChart = new Chart(document.getElementById('reservoir-chart'), {
      type: 'line',
      data: {
        labels: res.map(d => d.label),
        datasets: [
          { label: 'Elevation', data: res.map(d => d.avg), borderColor: '#BA7517', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#eee' }, title: { display: true, text: 'feet' } },
          x: { grid: { display: false } }
        }
      }
    });
  }
  
  function setWaterView(view) {
    const buttons = {
      hour: document.getElementById('water-btn-hour'),
      week: document.getElementById('water-btn-week'),
      day: document.getElementById('water-btn-day')
    };
    for (const key in buttons) {
      if (key === view) buttons[key].classList.add('active');
      else buttons[key].classList.remove('active');
    }
    renderWaterCharts(view);
  }
  
  // ===== TAB SWITCHING =====
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.tab[data-tab="' + name + '"]').classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
    
    // Re-render charts when their tab becomes visible (Chart.js sizes wrong on hidden canvases)
    if (name === 'water') {
      renderWaterCharts(getCurrentWaterView());
    } else if (name === 'air') {
      renderAirChart(getCurrentAirView());
    }
  }
  
  function getCurrentAirView() {
    if (document.getElementById('air-btn-week').classList.contains('active')) return 'week';
    if (document.getElementById('air-btn-day').classList.contains('active')) return 'day';
    return 'hour';
  }
  
  function getCurrentWaterView() {
    if (document.getElementById('water-btn-week').classList.contains('active')) return 'week';
    if (document.getElementById('water-btn-day').classList.contains('active')) return 'day';
    return 'hour';
  }
  
  // Initial render
  renderAirChart('hour');
  renderWaterCharts('hour');
</script>
</body>
</html>`;
    
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading data: ' + err.message);
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
