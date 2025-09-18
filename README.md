# Real-time Multi-Currency Trading Bot Simulator

This project is a real-time trading simulator using Node.js, Express, Socket.io and MongoDB.
It supports multi-currency wallets, simulated market prices, SMA trading bot, and real-time chat between users and admin.

## Quick start (development)

1. Install dependencies
```bash
npm install
```

2. Copy `.env.example` to `.env` and set `MONGODB_URI`, `JWT_SECRET`, `ADMIN_PASS`

3. Start server
```bash
npm run dev
# or
npm start
```

4. Open `http://localhost:3000` and use the web UI. Register new users. Admin login uses the `ADMIN_PASS` in your .env.

## Notes
- This is a demo. For production, add proper authentication hardening, HTTPS, rate-limiting, input validation, and monitoring.
- The in-memory market simulation runs in server process and broadcasts prices via Socket.io.
