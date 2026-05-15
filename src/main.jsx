import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Activity,
  Download,
  Gauge,
  LocateFixed,
  MapPinned,
  Navigation,
  Pause,
  Play,
  RotateCcw,
  Timer,
  Trash2,
  Wifi
} from 'lucide-react';
import './styles.css';

const STORAGE_KEY = 'signal-trail-samples-v1';
const DEFAULT_ENDPOINT = 'https://speed.cloudflare.com/__down?bytes=';
const DEFAULT_SETTINGS = {
  intervalSeconds: 8,
  payloadMB: 1,
  endpoint: DEFAULT_ENDPOINT
};

const SPEED_STOPS = [
  { value: 2, color: '#d73648' },
  { value: 8, color: '#f08c2e' },
  { value: 20, color: '#f1cf4a' },
  { value: 50, color: '#45b56d' },
  { value: 100, color: '#2388d9' }
];

function loadSamples() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveSamples(samples) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(samples.slice(-1000)));
}

function speedColor(speed) {
  if (!Number.isFinite(speed)) return '#8793a2';
  if (speed <= SPEED_STOPS[0].value) return SPEED_STOPS[0].color;
  for (let i = 1; i < SPEED_STOPS.length; i += 1) {
    const previous = SPEED_STOPS[i - 1];
    const next = SPEED_STOPS[i];
    if (speed <= next.value) {
      const mix = (speed - previous.value) / (next.value - previous.value);
      return blend(previous.color, next.color, mix);
    }
  }
  return SPEED_STOPS[SPEED_STOPS.length - 1].color;
}

function blend(a, b, amount) {
  const ah = parseInt(a.replace('#', ''), 16);
  const bh = parseInt(b.replace('#', ''), 16);
  const ar = ah >> 16;
  const ag = (ah >> 8) & 0xff;
  const ab = ah & 0xff;
  const br = bh >> 16;
  const bg = (bh >> 8) & 0xff;
  const bb = bh & 0xff;
  const rr = ar + amount * (br - ar);
  const rg = ag + amount * (bg - ag);
  const rb = ab + amount * (bb - ab);
  return `rgb(${rr.toFixed(0)}, ${rg.toFixed(0)}, ${rb.toFixed(0)})`;
}

async function runDownloadTest(endpoint, payloadMB, signal) {
  const bytes = Math.max(128 * 1024, Math.round(payloadMB * 1024 * 1024));
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = endpoint.endsWith('=') || endpoint.endsWith('/')
    ? `${endpoint}${bytes}`
    : `${endpoint}${separator}bytes=${bytes}`;
  const cacheBuster = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}-${Math.random()}`;
  const started = performance.now();
  const response = await fetch(cacheBuster, { cache: 'no-store', signal });

  if (!response.ok) {
    throw new Error(`Speed endpoint returned ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    await response.blob();
  } else {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  const durationSeconds = Math.max((performance.now() - started) / 1000, 0.001);
  return (bytes * 8) / durationSeconds / 1_000_000;
}

function estimateFromNetworkInfo() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection?.downlink) return null;
  return {
    mbps: connection.downlink,
    source: 'network-info'
  };
}

function useSpeedTracker(settings) {
  const [isRunning, setIsRunning] = useState(false);
  const [samples, setSamples] = useState(loadSamples);
  const [status, setStatus] = useState('Ready');
  const [currentPosition, setCurrentPosition] = useState(null);
  const [currentSpeed, setCurrentSpeed] = useState(null);
  const [error, setError] = useState('');
  const positionRef = useRef(null);
  const watchIdRef = useRef(null);
  const abortRef = useRef(null);
  const runningRef = useRef(false);

  useEffect(() => {
    saveSamples(samples);
  }, [samples]);

  useEffect(() => {
    runningRef.current = isRunning;
  }, [isRunning]);

  const stop = () => {
    runningRef.current = false;
    setIsRunning(false);
    setStatus('Paused');
    abortRef.current?.abort();
    abortRef.current = null;
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  const start = async () => {
    if (!navigator.geolocation) {
      setError('This browser does not support location tracking.');
      return;
    }

    setError('');
    setStatus('Waiting for location permission');
    setIsRunning(true);
    runningRef.current = true;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const nextPosition = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading: position.coords.heading,
          timestamp: position.timestamp
        };
        positionRef.current = nextPosition;
        setCurrentPosition(nextPosition);
      },
      (geoError) => {
        setError(geoError.message);
        stop();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 15000
      }
    );

    speedLoop();
  };

  const speedLoop = async () => {
    while (runningRef.current) {
      const position = positionRef.current;
      if (!position) {
        setStatus('Waiting for GPS fix');
        await delay(1000);
        continue;
      }

      try {
        setStatus('Testing connection');
        abortRef.current = new AbortController();
        let mbps = await runDownloadTest(settings.endpoint, settings.payloadMB, abortRef.current.signal);
        let source = 'download';
        if (!Number.isFinite(mbps)) {
          const estimate = estimateFromNetworkInfo();
          if (!estimate) throw new Error('Speed test did not return a measurable result.');
          mbps = estimate.mbps;
          source = estimate.source;
        }
        const sample = {
          id: crypto.randomUUID(),
          ...position,
          mbps,
          source,
          createdAt: Date.now()
        };
        setCurrentSpeed(mbps);
        setSamples((previous) => [...previous, sample].slice(-1000));
        setStatus('Tracking');
      } catch (testError) {
        if (testError.name !== 'AbortError') {
          const estimate = estimateFromNetworkInfo();
          if (estimate && positionRef.current) {
            const sample = {
              id: crypto.randomUUID(),
              ...positionRef.current,
              mbps: estimate.mbps,
              source: estimate.source,
              createdAt: Date.now()
            };
            setCurrentSpeed(estimate.mbps);
            setSamples((previous) => [...previous, sample].slice(-1000));
            setStatus('Tracking with browser estimate');
            setError('The download endpoint is blocked, so this browser is using its connection estimate.');
          } else {
            setError(testError.message || 'Speed test failed.');
            setStatus('Test failed');
          }
        }
      }

      await delay(settings.intervalSeconds * 1000);
    }
  };

  const clearSamples = () => {
    setSamples([]);
    setCurrentSpeed(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return {
    isRunning,
    samples,
    status,
    currentPosition,
    currentSpeed,
    error,
    start,
    stop,
    clearSamples
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Metric({ icon, label, value, detail }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}

function MapView({ samples, currentPosition }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false
    }).setView([20.5937, 78.9629], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('&copy; OpenStreetMap contributors').addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    setTimeout(() => map.invalidateSize(), 100);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    samples.forEach((sample) => {
      const color = speedColor(sample.mbps);
      L.circle([sample.lat, sample.lng], {
        radius: Math.max(45, Math.min(230, sample.accuracy || 90)),
        color,
        fillColor: color,
        fillOpacity: 0.42,
        opacity: 0.85,
        weight: 2
      })
        .bindPopup(`${sample.mbps.toFixed(1)} Mbps<br>${new Date(sample.createdAt).toLocaleString()}`)
        .addTo(layer);
    });

    if (currentPosition) {
      L.circleMarker([currentPosition.lat, currentPosition.lng], {
        radius: 8,
        color: '#101820',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 3
      }).addTo(layer);
    }

    const points = samples.map((sample) => [sample.lat, sample.lng]);
    if (currentPosition) points.push([currentPosition.lat, currentPosition.lng]);
    if (points.length === 1) {
      map.setView(points[0], Math.max(map.getZoom(), 15));
    } else if (points.length > 1) {
      map.fitBounds(points, { padding: [32, 32], maxZoom: 16 });
    }
  }, [samples, currentPosition]);

  return <div className="map" ref={containerRef} aria-label="Internet speed map" />;
}

function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const tracker = useSpeedTracker(settings);

  const stats = useMemo(() => {
    if (!tracker.samples.length) return { average: 0, fastest: 0, slowest: 0 };
    const speeds = tracker.samples.map((sample) => sample.mbps);
    return {
      average: speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length,
      fastest: Math.max(...speeds),
      slowest: Math.min(...speeds)
    };
  }, [tracker.samples]);

  const updateSetting = (key, value) => {
    setSettings((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow"><Wifi size={16} /> Signal Trail</p>
          <h1>Live internet speed map</h1>
        </div>
        <button
          className={tracker.isRunning ? 'primary danger' : 'primary'}
          onClick={tracker.isRunning ? tracker.stop : tracker.start}
        >
          {tracker.isRunning ? <Pause size={19} /> : <Play size={19} />}
          {tracker.isRunning ? 'Pause' : 'Start'}
        </button>
      </section>

      <section className="map-panel">
        <MapView samples={tracker.samples} currentPosition={tracker.currentPosition} />
        <div className="map-overlay">
          <div className="status-pill">
            <Activity size={16} />
            {tracker.status}
          </div>
          <div className="legend">
            <span>Slow</span>
            <div className="legend-bar" />
            <span>Fast</span>
          </div>
        </div>
      </section>

      {tracker.error && (
        <section className="notice" role="alert">
          {tracker.error}
        </section>
      )}

      <section className="metrics-grid">
        <Metric
          icon={<Gauge size={20} />}
          label="Now"
          value={tracker.currentSpeed ? `${tracker.currentSpeed.toFixed(1)} Mbps` : '--'}
          detail={tracker.samples.at(-1)?.source === 'network-info' ? 'estimated' : 'download'}
        />
        <Metric
          icon={<Download size={20} />}
          label="Average"
          value={tracker.samples.length ? `${stats.average.toFixed(1)} Mbps` : '--'}
          detail={`${tracker.samples.length} samples`}
        />
        <Metric
          icon={<Navigation size={20} />}
          label="GPS"
          value={tracker.currentPosition ? `${Math.round(tracker.currentPosition.accuracy)} m` : '--'}
          detail="accuracy"
        />
        <Metric
          icon={<MapPinned size={20} />}
          label="Range"
          value={tracker.samples.length ? `${stats.slowest.toFixed(1)}-${stats.fastest.toFixed(1)}` : '--'}
          detail="Mbps"
        />
      </section>

      <section className="controls">
        <label>
          <span><Timer size={16} /> Test every</span>
          <select
            value={settings.intervalSeconds}
            disabled={tracker.isRunning}
            onChange={(event) => updateSetting('intervalSeconds', Number(event.target.value))}
          >
            <option value="5">5 seconds</option>
            <option value="8">8 seconds</option>
            <option value="15">15 seconds</option>
            <option value="30">30 seconds</option>
          </select>
        </label>

        <label>
          <span><Download size={16} /> Test size</span>
          <select
            value={settings.payloadMB}
            disabled={tracker.isRunning}
            onChange={(event) => updateSetting('payloadMB', Number(event.target.value))}
          >
            <option value="0.5">0.5 MB</option>
            <option value="1">1 MB</option>
            <option value="3">3 MB</option>
            <option value="8">8 MB</option>
          </select>
        </label>

        <label className="wide">
          <span><LocateFixed size={16} /> Download endpoint</span>
          <input
            value={settings.endpoint}
            disabled={tracker.isRunning}
            onChange={(event) => updateSetting('endpoint', event.target.value)}
          />
        </label>

        <button className="secondary" onClick={() => setSettings(DEFAULT_SETTINGS)} disabled={tracker.isRunning}>
          <RotateCcw size={17} />
          Defaults
        </button>
        <button className="secondary" onClick={tracker.clearSamples}>
          <Trash2 size={17} />
          Clear
        </button>
      </section>

      <section className="sample-list">
        <h2>Recent samples</h2>
        <div>
          {tracker.samples.slice(-8).reverse().map((sample) => (
            <article key={sample.id}>
              <span className="dot" style={{ background: speedColor(sample.mbps) }} />
              <strong>{sample.mbps.toFixed(1)} Mbps</strong>
              <small>{sample.lat.toFixed(5)}, {sample.lng.toFixed(5)} · {sample.source === 'network-info' ? 'estimate' : 'download'}</small>
              <time>{new Date(sample.createdAt).toLocaleTimeString()}</time>
            </article>
          ))}
          {!tracker.samples.length && <p className="empty">Start tracking to collect speed points.</p>}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
