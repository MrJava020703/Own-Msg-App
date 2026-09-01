# Realtime Chat

TypeScript chat application with Express, Socket.IO, React/Vite, Prisma and Neon PostgreSQL. Socket.IO is used only for real-time events; PostgreSQL remains the source of truth.

## Run locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL` to a Neon PostgreSQL connection string.
2. Install dependencies: `npm install`.
3. Generate and migrate the database: `npm run prisma:generate -w backend` then `npm run prisma:migrate -w backend`.
4. Run both applications: `npm run dev`.
5. Open `http://localhost:5173` in two browser windows and choose different names.

The API runs on port 5000. To run independently, use `npm run dev -w backend` and `npm run dev -w frontend`.

## Features

- Temporary display-name identities, multi-tab presence sessions, searchable live users and private conversations.
- Persisted private messages with cursor pagination, read receipts, typing events, delivery acknowledgements, reactions, editing and soft deletion.
- Emoji/sticker messages and backend-proxied GIPHY search endpoints (`/api/gifs/search?q=` and `/api/gifs/trending`). Set `GIPHY_API_KEY` to enable GIF results.
- Actual WebRTC offer/answer/ICE signaling over Socket.IO with microphone/camera media streams, mute, camera toggle, and track cleanup.

## WebRTC / TURN

Local browsers often work with the included Google STUN server. For real deployments behind restrictive NATs, configure a TURN service and set `TURN_SERVER_URL`, `TURN_USERNAME`, and `TURN_PASSWORD`; add those values to the `RTCPeerConnection` ICE server list in `frontend/src/components/call/CallOverlay.tsx`. HTTPS is required for camera/microphone access outside localhost.

## Docker

Copy `.env.example` to `.env`, provide a reachable Neon URL, then run `docker compose up`. This development compose file mounts the source and installs packages inside its Node container. Neon is external; no MongoDB service or dependency is used.

## Notes

The MVP stores uploaded files locally only after deployment storage is configured. Configure a reverse proxy/TLS and a TURN service for production. Socket session records are removed on disconnect, so a user becomes offline only after their last tab/device disconnects.
