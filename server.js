import express from 'express';
import pg from 'pg';

const { Client } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

async function getData() {
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
      LIMIT 500
    `);
    return res.rows;
  } finally {
    await client.end();
  }
}

app.get('/', async (req, res) => {
  try {
    const rows = await getData();
    
    const latest = {};
    for (const row of rows) {
      if (!latest[row.parameter]) latest[row.parameter] = row;
    }
    
    const byParam = { 'PM2.5': [], 'O3': [], 'PM10': [] };
    for (const row of rows) {
      if (byParam[row.parameter] && byParam[row.parameter].length < 48) {
        byParam[row.parameter].push(row);
      }
    }
    for (const key in byParam) byParam[key].reverse();
    
    const labels = byParam['PM2.5'].map(r => {
      const d = new Date(r.observation_time);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
    });
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timnath Air Quality</title>
<style>
  * { box-sizing: border-box; }
  body { 
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    margin: 0; padding: 2rem 1rem; background: #fafaf7; color: #1a1a1a;
    max-width: 900px; margin: 0 auto;
  }
  h1 { font-size: 28px; font-weight: 500; margin: 0 0 4px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 2rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.25rem; border: 1px solid #eee; }
  .label { font-size: 13px; color: #666; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .aqi { font-size: 36px; font-weight: 500; margin: 0; }
  .cat { font-size: 13px; margin: 6px 0 0; }
  .good { color: #0F6E56; }
  .mod { color: #854F0B; }
  .bad { color: #A32D2D; }
  .chart-wrap { background: #fff; border-radius: 12px; padding: 1.5rem; border: 1px solid #eee; position: relative; height: 360px; }
  .legend { display: flex; gap: 16px; font-size: 13px; color: #666; margin-bottom: 12px; flex-wrap: wrap; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  footer { text-align: center; margin-top: 2rem; font-size: 12px; color: #888; }
  a { color: #378ADD; text-decoration: none; }
</style>
</head>
<body>
  <h1>Timnath Air Quality</h1>
  <p class="sub">Live data from the Fort Collins AirNow station · updated hourly</p>
  
  <div class="cards">
    ${Object.entries(latest).map(([param, row]) => {
      const cat = row.category;
      const cls = cat === 'Good' ? 'good' : cat === 'Moderate' ? 'mod' : 'bad';
      return `
        <div class="card">
          <p class="label">${param}</p>
          <p class="aqi">${row.aqi}</p>
          <p class="cat ${cls}">${cat}</p>
        </div>
      `;
    }).join('')}
  </div>
  <div style="display: flex; gap: 8px; margin-bottom: 1rem;">
    <button id="btn-hour" onclick="setView('hour')" style="padding: 6px 14px; border: 1px solid #378ADD; background: #378ADD; color: white; border-radius: 6px; cursor: pointer; font-size: 13px;">Hour</button>
    <button id="btn-day" onclick="setView('day')" style="padding: 6px 14px; border: 1px solid #ccc; background: white; color: #333; border-radius: 6px; cursor: pointer; font-size: 13px;">Day</button>
  </div>
  <div class="legend">
    <span><span class="dot" style="background:#378ADD"></span>PM2.5</span>
    <span><span class="dot" style="background:#0F6E56"></span>Ozone (O3)</span>
    <span><span class="dot" style="background:#BA7517"></span>PM10</span>
  </div>
  
  <div class="chart-wrap">
    <canvas id="chart"></canvas>
  </div>
  
  <footer>
    Data via <a href="https://airnow.gov">AirNow</a> · Built on <a href="https://render.com">Render</a> · ${rows.length} observations logged
  </footer>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
  const labels = ${JSON.stringify(labels)};
  const pm25 = ${JSON.stringify(byParam['PM2.5'].map(r => r.aqi))};
  const o3 = ${JSON.stringify(byParam['O3'].map(r => r.aqi))};
  const pm10 = ${JSON.stringify(byParam['PM10'].map(r => r.aqi))};
  
  new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'PM2.5', data: pm25, borderColor: '#378ADD', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 },
        { label: 'Ozone', data: o3, borderColor: '#0F6E56', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 },
        { label: 'PM10', data: pm10, borderColor: '#BA7517', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3 }
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
