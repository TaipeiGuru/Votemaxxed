# Votemaxxed

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

