# Signal Trail

A mobile-friendly web app for tracking internet speed and location together, then drawing a color-coded speed map.

## Run locally

```bash
npm install
npm run dev -- --port 5173
```

Open `http://127.0.0.1:5173`.

## Hosting notes

- Geolocation requires HTTPS when hosted, except on `localhost`.
- The app stores samples in the browser's local storage on the device.
- Active tests download real data. Increase the interval or lower the test size when testing on limited mobile data.
- The default download endpoint is Cloudflare's public speed endpoint. You can replace it in the app with your own endpoint that returns the requested number of bytes.

## What it tracks

- Latitude and longitude from the browser geolocation API.
- GPS accuracy, when the phone provides it.
- Download speed from repeated timed downloads.
- A browser connection estimate as a fallback when the test endpoint is blocked.
