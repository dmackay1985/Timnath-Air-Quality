import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// USGS site IDs we care about
const SITES = ['06752260', '06752280', '06737500', '06742015'];

// USGS parameter codes:
// 00060 = Discharge (cfs) — river flow
// 00065 = Gauge height (ft) — river depth
// 00062 = Reservoir water surface elevation (ft)
// 00054 = Reservoir storage (acre-feet)
const PARAMS = ['00060', '00065', '00062', '00054'];

async function fetchWater() {
  const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${SITES.join(',')}&parameterCd=${PARAMS.join(',')}&format=json`;
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TimnathConditions (daniel.j.mackay@gmail.com)' }
  });
  
  if (!res.ok) throw new Error(`USGS API error: ${res.status}`);
  return res.json();
}

async function saveToDb(data) {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS water_levels (
        id SERIAL PRIMARY KEY,
        recorded_at TIMESTAMPTZ DEFAULT NOW(),
        observation_time TIMESTAMPTZ,
        site_id VARCHAR(20),
        site_name VARCHAR(200),
        parameter_code VARCHAR(20),
        parameter_name VARCHAR(100),
        value NUMERIC,
        unit VARCHAR(20)
      )
    `);
    
    const series = data?.value?.timeSeries || [];
    
    if (series.length === 0) {
      console.log('No time series returned from USGS');
      return;
    }
    
    let logged = 0;
    
    for (const ts of series) {
      const siteName = ts.sourceInfo?.siteName || 'Unknown';
      const siteId = ts.sourceInfo?.siteCode?.[0]?.value || 'Unknown';
      const paramCode = ts.variable?.variableCode?.[0]?.value || 'Unknown';
      const paramName = ts.variable?.variableName || 'Unknown';
      const unit = ts.variable?.unit?.unitCode || '';
      
      const values = ts.values?.[0]?.value || [];
      
      // Take the most recent value
      const latest = values[values.length - 1];
      if (!latest || latest.value === null || latest.value === '-999999') continue;
      
      const numValue = parseFloat(latest.value);
      if (isNaN(numValue)) continue;
      
      await client.query(
        `INSERT INTO water_levels 
         (observation_time, site_id, site_name, parameter_code, parameter_name, value, unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [latest.dateTime, siteId, siteName, paramCode, paramName, numValue, unit]
      );
      
      console.log(`Logged ${siteName} (${siteId}): ${paramName} = ${numValue} ${unit}`);
      logged++;
    }
    
    console.log(`Logged ${logged} measurements`);
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`Running water check at ${new Date().toISOString()}`);
  
  try {
    const data = await fetchWater();
    await saveToDb(data);
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
