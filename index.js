import pg from 'pg';

const { Client } = pg;

const AIRNOW_API_KEY = process.env.AIRNOW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// Timnath, CO
const LAT = 40.5311;
const LON = -104.9841;
const DISTANCE_MILES = 25; // search radius for nearest reporting station

async function fetchAirQuality() {
  const url = `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${LAT}&longitude=${LON}&distance=${DISTANCE_MILES}&API_KEY=${AIRNOW_API_KEY}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AirNow API error: ${res.status}`);
  return res.json();
}

async function saveToDb(observations) {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  try {
    // Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS air_quality (
        id SERIAL PRIMARY KEY,
        recorded_at TIMESTAMPTZ DEFAULT NOW(),
        observation_time TIMESTAMPTZ,
        parameter VARCHAR(20),
        aqi INTEGER,
        category VARCHAR(50),
        reporting_area VARCHAR(100),
        lat NUMERIC,
        lon NUMERIC
      )
    `);
    
    for (const obs of observations) {
      // AirNow returns date/hour separately in local time; combine them
      const obsTime = `${obs.DateObserved.trim()} ${obs.HourObserved}:00:00`;
      
      await client.query(
        `INSERT INTO air_quality 
         (observation_time, parameter, aqi, category, reporting_area, lat, lon)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          obsTime,
          obs.ParameterName,
          obs.AQI,
          obs.Category.Name,
          obs.ReportingArea,
          obs.Latitude,
          obs.Longitude
        ]
      );
      
      console.log(`Logged ${obs.ParameterName}: AQI ${obs.AQI} (${obs.Category.Name}) from ${obs.ReportingArea}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`Running air quality check at ${new Date().toISOString()}`);
  
  try {
    const observations = await fetchAirQuality();
    
    if (!observations || observations.length === 0) {
      console.log('No observations returned from AirNow');
      return;
    }
    
    console.log(`Got ${observations.length} observations`);
    await saveToDb(observations);
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
