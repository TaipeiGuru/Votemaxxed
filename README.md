# Votemaxxed (Prompt Mogger)

Realtime party game where players write answers, vote head-to-head, and finish with a photo/caption ranking round.

## Tech Stack

- **Client:** React + Vite + Socket.IO client (`client/`)
- **Server:** Node.js + Express + Socket.IO (`server/`)
- **Data:** Supabase (prompt pool + prompt reporting)

## Repo Structure

- `client/` - browser app and UI
- `server/` - game state, websocket events, prompt logic
- `server/scripts/` - utility scripts (for prompt seeding workflows)

## Prerequisites

- Node.js 18+ (recommended)
- npm
- Supabase project with prompt data and report RPC configured

## Environment Variables

### Client (`client/.env`)

Copy `client/.env.example` to `client/.env` and set:

```env
VITE_SERVER_URL=http://localhost:3001
```

### Server (`server/.env`)

Copy `server/.env.example` to `server/.env` and set:

```env
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Notes:

- `CLIENT_ORIGIN` must exactly match your frontend origin.
- Supabase values are required for prompt loading and bad-prompt reporting.

## Install

From the repo root:

```bash
npm run install:all
```

## Run Locally

### Start both client and server

```bash
npm run dev
```

Default local URLs:

- Client: `http://localhost:5173`
- Server: `http://localhost:3001`

### Build client

```bash
npm run build
```

This runs the Vite production build in `client/` and outputs to `client/dist/`.

## Gameplay Overview

1. **Lobby**
   - Host creates a session
   - Players join with a 6-character code
2. **Text Rounds**
   - Players answer prompts
   - Showdowns reveal paired answers
   - Eligible players vote
   - Round scoring includes mog/chud overlays and vote breakdowns
3. **Photo Round**
   - Upload a photo
   - Caption an assigned photo
   - Rank pairings (1st/2nd/3rd)
4. **Final Results**
   - Scoreboard reveal
   - Winner display
   - Play again / new game flow

## Deploy

Recommended setup: **split deploy**

- Deploy `server/` as a Node web service
- Deploy `client/` as a static site

Required deploy-time envs:

- Client: `VITE_SERVER_URL=https://your-server-domain`
- Server: `CLIENT_ORIGIN=https://your-client-domain`
- Server: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

If Socket.IO fails in production, verify:

- `VITE_SERVER_URL` points to the live backend
- `CLIENT_ORIGIN` exactly matches the frontend URL (protocol + domain)

## Scripts

### Root

- `npm run install:all` - install root, server, and client dependencies
- `npm run dev` - run server and client in parallel
- `npm run build` - build client

### Server

- `npm run dev --prefix server` - run server with watch mode
- `npm run start --prefix server` - run server in normal mode

### Client

- `npm run dev --prefix client` - Vite dev server
- `npm run build --prefix client` - production build
- `npm run preview --prefix client` - preview built client

## Troubleshooting

- **"Supabase not configured"**
  - Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `server/.env`.
- **Frontend loads but cannot join/create games**
  - Check `VITE_SERVER_URL` and server availability.
- **CORS or websocket errors**
  - Ensure `CLIENT_ORIGIN` matches the exact frontend origin.

