import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { nanoid, customAlphabet } from "nanoid";
import { buildGamePrompts, MAX_PROMPT_TEXT_LEN } from "./prompts.js";
import { buildAssignments, scoreShowdown, isUnanimous } from "./gameLogic.js";

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

/** How many full passes over all prompts (spec: "after 2 rounds"). */
const SHOWDOWN_PASSES = 2;

/** Time vote distribution stays on screen before advancing (after mog/chud when applicable). */
const VOTE_DISTRIBUTION_REVIEW_MS = 7500;
/** Extra delay so overlays can finish before the distribution window counts in earnest. */
const OVERLAY_BEFORE_REVIEW_MS = 3600;
/** Splash between vote distribution and the next prompt. */
const NEXT_VOTE_SPLASH_MS = 3000;

const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

/** Sentinel player id so `sessionSnapshot` can build an observer-style state for projectors. */
const PROJECTOR_SENTINEL_ID = "__projector__";

const CHUD_TEASES = [
  "The jury stayed home. Your answer sent the invites straight to spam.",
  "Zero votes — statistically indistinguishable from a haunted house: everyone fled.",
  "Not one soul clicked for you. The silence is louder than the prompt.",
  "You asked for love; the room answered with abstinence.",
  "That answer aged like milk in a sauna. No takers.",
  "Unanimous… against you. Even the UI feels awkward right now.",
  "Your opus landed with the grace of a dropped piano. Zero believers.",
  "They read it. They scrolled. They chose life.",
];

function pickChudTease() {
  return CHUD_TEASES[Math.floor(Math.random() * CHUD_TEASES.length)];
}

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

/** @type {Map<string, object>} */
const sessions = new Map();

function publicPlayer(p) {
  return { id: p.id, name: p.name };
}

function publicLastResult(r) {
  if (!r) return null;
  return {
    queueIndex: r.queueIndex,
    votesForA: r.votesForA,
    votesForB: r.votesForB,
    mog: r.mog,
    overlayPause: r.overlayPause,
    voteBreakdown: r.voteBreakdown,
  };
}

function sessionSnapshot(sess, forPlayerId) {
  const base = {
    code: sess.code,
    phase: sess.phase,
    hostPlayerId: sess.hostPlayerId,
    players: sess.players.map(publicPlayer),
    you: forPlayerId,
  };

  if (sess.phase === "lobby") {
    return {
      ...base,
      customPrompts: [...(sess.customPrompts || [])],
      maxCustomPrompts: sess.players.length,
    };
  }

  const n = sess.gamePrompts.length;
  const promptsMeta = sess.gamePrompts.map((p, i) => ({
    index: i,
    text: p.text,
    authorIds: sess.assignments[i].authorIds,
  }));

  const myPrompts = promptsMeta.filter((p) => p.authorIds.includes(forPlayerId));

  const answersMine = {};
  for (const mp of myPrompts) {
    const idx = String(mp.index);
    answersMine[idx] = sess.answers[idx]?.[forPlayerId] ?? "";
  }

  if (sess.phase === "answering") {
    return {
      ...base,
      promptsMeta,
      myPrompts,
      answersMine,
      allAnswersIn: isAllAnswersIn(sess),
    };
  }

  if (sess.phase === "ended") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: sess.winner ?? null,
      showdown: null,
    };
  }

  if (sess.phase === "showdown") {
    const sd = getCurrentShowdown(sess);
    const queueIndex = sess.currentQueueIndex;
    const promptIndex = sd.promptIndex;
    const authors = sd.authorIds;
    const answerA = sess.answers[String(promptIndex)]?.[authors[0]] ?? "";
    const answerB = sess.answers[String(promptIndex)]?.[authors[1]] ?? "";
    const eligibleVoters = sess.players
      .map((p) => p.id)
      .filter((id) => !authors.includes(id));

    const myVote =
      sess.showdownVotes[sess.currentQueueIndex]?.[forPlayerId] ?? null;

    const voteCounts = tallyVotes(sess, sd);
    const lastResult =
      sess.lastShowdownResult &&
      (sess.lastShowdownResult.queueIndex < sess.currentQueueIndex ||
        sess.showdownReviewActive)
        ? publicLastResult(sess.lastShowdownResult)
        : null;

    return {
      ...base,
      promptsMeta,
      showdown: {
        queueIndex,
        totalShowdowns: sess.showdownQueue.length,
        passNumber: Math.floor(queueIndex / n) + 1,
        passesTotal: SHOWDOWN_PASSES,
        promptIndex,
        promptText: sess.gamePrompts[promptIndex].text,
        answerA,
        answerB,
        authorA: authors[0],
        authorB: authors[1],
        eligibleVoters,
        votesCast: Object.keys(sess.showdownVotes[queueIndex] || {}).length,
        votesNeeded: eligibleVoters.length,
        voteCounts,
        myVote,
        reviewActive: !!sess.showdownReviewActive,
        splashActive: !!sess.showdownSplashActive,
        everyoneVoted:
          eligibleVoters.length === 0 ||
          Object.keys(sess.showdownVotes[queueIndex] || {}).length ===
            eligibleVoters.length,
      },
      scores: { ...sess.scores },
      lastResult,
      winner: null,
    };
  }

  return base;
}

function isAllAnswersIn(sess) {
  const n = sess.gamePrompts.length;
  for (let i = 0; i < n; i++) {
    const authors = sess.assignments[i].authorIds;
    for (const aid of authors) {
      const t = sess.answers[String(i)]?.[aid];
      if (!t || !String(t).trim()) return false;
    }
  }
  return true;
}

function getCurrentShowdown(sess) {
  const qi = sess.currentQueueIndex;
  const promptIndex = sess.showdownQueue[qi];
  return {
    promptIndex,
    authorIds: [...sess.assignments[promptIndex].authorIds],
  };
}

function tallyVotes(sess, sd) {
  const votes = sess.showdownVotes[sess.currentQueueIndex] || {};
  let a = 0;
  let b = 0;
  const authors = sd.authorIds;
  for (const v of Object.values(votes)) {
    if (v === "A") a++;
    else if (v === "B") b++;
  }
  return { A: a, B: b, authorA: authors[0], authorB: authors[1] };
}

function findPlayerBySocket(socketId) {
  for (const sess of sessions.values()) {
    const p = sess.players.find((x) => x.socketId === socketId);
    if (p) return { sess, player: p };
  }
  return null;
}

function findProjectorBySocket(socketId) {
  for (const sess of sessions.values()) {
    const pr = sess.projectors?.find((x) => x.socketId === socketId);
    if (pr) return { sess, projector: pr };
  }
  return null;
}

function playerHasBothAnswersSaved(sess, playerId) {
  const promptIndices = sess.assignments
    .filter((a) => a.authorIds.includes(playerId))
    .map((a) => a.promptIndex);
  return promptIndices.every((i) => {
    const t = sess.answers[String(i)]?.[playerId];
    return t && String(t).trim();
  });
}

function computeAnswerProgress(sess) {
  const done = [];
  const waiting = [];
  for (const p of sess.players) {
    const row = { id: p.id, name: p.name };
    if (playerHasBothAnswersSaved(sess, p.id)) done.push(row);
    else waiting.push(row);
  }
  return { done, waiting };
}

function sessionSnapshotForProjector(sess) {
  const snap = sessionSnapshot(sess, PROJECTOR_SENTINEL_ID);
  return {
    ...snap,
    role: "projector",
    you: null,
    ...(sess.phase === "answering" && { answerProgress: computeAnswerProgress(sess) }),
  };
}

function findSessionByCode(code) {
  return sessions.get(String(code).toUpperCase()) ?? null;
}

function broadcastSession(sess) {
  const io = globalThis.__io;
  if (!io) return;
  for (const p of sess.players) {
    io.to(p.socketId).emit("session_state", sessionSnapshot(sess, p.id));
  }
  if (sess.projectors?.length) {
    const projSnap = sessionSnapshotForProjector(sess);
    for (const pr of sess.projectors) {
      io.to(pr.socketId).emit("session_state", projSnap);
    }
  }
}

function clearShowdownTimers(sess) {
  if (sess._showdownAdvanceTimer) {
    clearTimeout(sess._showdownAdvanceTimer);
    sess._showdownAdvanceTimer = null;
  }
  if (sess._nextVoteSplashTimer) {
    clearTimeout(sess._nextVoteSplashTimer);
    sess._nextVoteSplashTimer = null;
  }
}

function bumpShowdownQueueAndMaybeEnd(sess) {
  sess.currentQueueIndex++;
  if (sess.currentQueueIndex >= sess.showdownQueue.length) {
    sess.phase = "ended";
    let best = -1;
    let winners = [];
    for (const p of sess.players) {
      const s = sess.scores[p.id] || 0;
      if (s > best) {
        best = s;
        winners = [p];
      } else if (s === best) {
        winners.push(p);
      }
    }
    sess.winner = {
      names: winners.map((w) => w.name),
      score: best,
    };
  }
}

/** Remove stale breakdown when advancing to a new voting round (keeps ended-phase result intact). */
function clearLastShowdownResultIfStillVoting(sess) {
  if (sess.phase === "showdown") {
    sess.lastShowdownResult = null;
  }
}

function scheduleShowdownQueueAdvance(sess, overlayPause) {
  clearShowdownTimers(sess);
  sess.showdownSplashActive = false;
  sess.showdownReviewActive = true;
  broadcastSession(sess);

  const delay =
    VOTE_DISTRIBUTION_REVIEW_MS + (overlayPause ? OVERLAY_BEFORE_REVIEW_MS : 0);
  const code = sess.code;
  sess._showdownAdvanceTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s) return;
    s._showdownAdvanceTimer = null;
    s.showdownReviewActive = false;
    if (s.phase !== "showdown") {
      broadcastSession(s);
      return;
    }
    s.showdownSplashActive = true;
    broadcastSession(s);
    s._nextVoteSplashTimer = setTimeout(() => {
      const s2 = sessions.get(code);
      if (!s2) return;
      s2._nextVoteSplashTimer = null;
      s2.showdownSplashActive = false;
      if (s2.phase !== "showdown") {
        broadcastSession(s2);
        return;
      }
      bumpShowdownQueueAndMaybeEnd(s2);
      skipShowdownsWithNoVoters(s2);
      clearLastShowdownResultIfStillVoting(s2);
      broadcastSession(s2);
    }, NEXT_VOTE_SPLASH_MS);
  }, delay);
}

function skipShowdownsWithNoVoters(sess) {
  while (sess.phase === "showdown" && sess.currentQueueIndex < sess.showdownQueue.length) {
    const sd = getCurrentShowdown(sess);
    const eligible = sess.players
      .map((p) => p.id)
      .filter((id) => !sd.authorIds.includes(id));
    if (eligible.length > 0) break;
    advanceShowdown(sess);
  }
}

function advanceShowdown(sess) {
  const sd = getCurrentShowdown(sess);
  const votes = sess.showdownVotes[sess.currentQueueIndex] || {};
  const authors = sd.authorIds;
  const eligible = sess.players.map((p) => p.id).filter((id) => !authors.includes(id));

  let votesForA = 0;
  let votesForB = 0;
  for (const vid of eligible) {
    const c = votes[vid];
    if (c === "A") votesForA++;
    else if (c === "B") votesForB++;
  }

  const points = scoreShowdown(votesForA, votesForB, authors[0], authors[1]);
  for (const pid of Object.keys(points)) {
    sess.scores[pid] = (sess.scores[pid] || 0) + points[pid];
  }

  const promptText = sess.gamePrompts[sd.promptIndex].text;
  const answerAText = sess.answers[String(sd.promptIndex)]?.[authors[0]] ?? "";
  const answerBText = sess.answers[String(sd.promptIndex)]?.[authors[1]] ?? "";

  const votersForA = [];
  const votersForB = [];
  for (const vid of eligible) {
    const c = votes[vid];
    const pl = sess.players.find((p) => p.id === vid);
    const nm = pl?.name ?? "?";
    if (c === "A") votersForA.push(nm);
    else if (c === "B") votersForB.push(nm);
  }

  const authorAName = sess.players.find((p) => p.id === authors[0])?.name ?? "?";
  const authorBName = sess.players.find((p) => p.id === authors[1])?.name ?? "?";

  const uni = isUnanimous(votesForA, votesForB);
  let mogPayload = null;
  if (uni && eligible.length > 0) {
    const winningSide = uni.winner;
    const winningAuthor = winningSide === "A" ? authors[0] : authors[1];
    const winningAnswer = winningSide === "A" ? answerAText : answerBText;
    mogPayload = {
      promptText,
      winningAnswer,
      winningAuthorName: sess.players.find((p) => p.id === winningAuthor)?.name ?? "?",
    };
    console.log("[MOG] (no DB) saved pair:", {
      promptText,
      winningAnswerText: winningAnswer,
    });
  }

  let loserPlayerId = null;
  let chudAnswer = "";
  if (eligible.length > 0) {
    if (votesForA === 0 && votesForB > 0) {
      loserPlayerId = authors[0];
      chudAnswer = answerAText;
    } else if (votesForB === 0 && votesForA > 0) {
      loserPlayerId = authors[1];
      chudAnswer = answerBText;
    }
  }

  const loserSocketId = loserPlayerId
    ? sess.players.find((p) => p.id === loserPlayerId)?.socketId
    : null;

  const hadMog = !!mogPayload;
  const hadChud = !!(loserPlayerId && loserSocketId);
  const overlayPause = hadMog || hadChud;

  sess.lastShowdownResult = {
    queueIndex: sess.currentQueueIndex,
    votesForA,
    votesForB,
    points,
    mog: mogPayload,
    overlayPause,
    voteBreakdown: {
      promptText,
      answerAText,
      answerBText,
      authorAName,
      authorBName,
      votersForA,
      votersForB,
    },
  };

  const io = globalThis.__io;
  if (mogPayload && io) {
    if (loserSocketId) {
      io.to(sess.code).except(loserSocketId).emit("unanimous_victory", mogPayload);
    } else {
      io.to(sess.code).emit("unanimous_victory", mogPayload);
    }
  }

  if (io && loserPlayerId && loserSocketId) {
    io.to(loserSocketId).emit("chud_overlay", {
      tease: pickChudTease(),
      answerText:
        chudAnswer.length > 160 ? `${chudAnswer.slice(0, 160)}…` : chudAnswer,
    });
  }

  if (eligible.length === 0) {
    sess.showdownReviewActive = false;
    sess.showdownSplashActive = false;
    bumpShowdownQueueAndMaybeEnd(sess);
    clearLastShowdownResultIfStillVoting(sess);
    return;
  }

  scheduleShowdownQueueAdvance(sess, overlayPause);
}

function startServer() {
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
  });
  globalThis.__io = io;

  io.on("connection", (socket) => {
    socket.on("create_session", ({ hostName } = {}, cb) => {
      const name = String(hostName || "Host").slice(0, 24) || "Host";
      let code = genCode();
      while (sessions.has(code)) code = genCode();
      const hostPlayerId = nanoid(12);
      const sess = {
        code,
        hostPlayerId,
        players: [
          {
            id: hostPlayerId,
            name,
            socketId: socket.id,
          },
        ],
        projectors: [],
        phase: "lobby",
        customPrompts: [],
      };
      sessions.set(code, sess);
      socket.join(code);
      if (typeof cb === "function") {
        cb({ ok: true, code, playerId: hostPlayerId });
      }
      socket.emit("session_state", sessionSnapshot(sess, hostPlayerId));
    });

    socket.on("join_session", ({ code, name } = {}, cb) => {
      if (findProjectorBySocket(socket.id)) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Disconnect the projector tab before joining as a player." });
        }
        return;
      }
      const c = String(code || "")
        .toUpperCase()
        .trim();
      const sess = findSessionByCode(c);
      if (!sess) {
        if (typeof cb === "function") cb({ ok: false, error: "Session not found." });
        return;
      }
      if (sess.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Game already started." });
        return;
      }
      const playerName = String(name || "Player").slice(0, 24) || "Player";
      if (sess.players.some((p) => p.name.toLowerCase() === playerName.toLowerCase())) {
        if (typeof cb === "function") cb({ ok: false, error: "Name already taken." });
        return;
      }
      const playerId = nanoid(12);
      sess.players.push({ id: playerId, name: playerName, socketId: socket.id });
      socket.join(sess.code);
      if (typeof cb === "function") cb({ ok: true, code: sess.code, playerId });
      broadcastSession(sess);
    });

    socket.on("join_projector", ({ code } = {}, cb) => {
      if (findPlayerBySocket(socket.id)) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Leave the player session before opening projector mode." });
        }
        return;
      }
      const c = String(code || "")
        .toUpperCase()
        .trim();
      const sess = findSessionByCode(c);
      if (!sess) {
        if (typeof cb === "function") cb({ ok: false, error: "Session not found." });
        return;
      }
      if (!sess.projectors) sess.projectors = [];
      sess.projectors = sess.projectors.filter((x) => x.socketId !== socket.id);
      sess.projectors.push({ id: nanoid(8), socketId: socket.id });
      socket.join(sess.code);
      if (typeof cb === "function") cb({ ok: true, code: sess.code });
      socket.emit("session_state", sessionSnapshotForProjector(sess));
    });

    socket.on("add_custom_prompt", ({ text } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (player.id !== sess.hostPlayerId) {
        if (typeof cb === "function") cb({ ok: false, error: "Only the host can add prompts." });
        return;
      }
      if (sess.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Game already started." });
        return;
      }
      if (!sess.customPrompts) sess.customPrompts = [];
      const t = String(text || "")
        .trim()
        .slice(0, MAX_PROMPT_TEXT_LEN);
      if (!t) {
        if (typeof cb === "function") cb({ ok: false, error: "Prompt cannot be empty." });
        return;
      }
      if (sess.customPrompts.length >= sess.players.length) {
        if (typeof cb === "function") {
          cb({
            ok: false,
            error: `At most ${sess.players.length} custom prompt(s) (one per player).`,
          });
        }
        return;
      }
      if (sess.customPrompts.some((x) => x.toLowerCase() === t.toLowerCase())) {
        if (typeof cb === "function") cb({ ok: false, error: "That prompt is already in the list." });
        return;
      }
      sess.customPrompts.push(t);
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("remove_custom_prompt", ({ index } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (player.id !== sess.hostPlayerId) {
        if (typeof cb === "function") cb({ ok: false, error: "Only the host can remove prompts." });
        return;
      }
      if (sess.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Game already started." });
        return;
      }
      if (!sess.customPrompts) sess.customPrompts = [];
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= sess.customPrompts.length) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid prompt index." });
        return;
      }
      sess.customPrompts.splice(i, 1);
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("start_game", (_, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (player.id !== sess.hostPlayerId) {
        if (typeof cb === "function") cb({ ok: false, error: "Only the host can start." });
        return;
      }
      if (sess.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Already started." });
        return;
      }
      if (sess.players.length < 3) {
        if (typeof cb === "function") {
          cb({
            ok: false,
            error: "Need at least 3 players so there are voters for each prompt.",
          });
        }
        return;
      }

      const n = sess.players.length;
      let pool;
      try {
        pool = buildGamePrompts(n, sess.customPrompts || []);
      } catch (e) {
        if (typeof cb === "function") {
          cb({ ok: false, error: e.message || "Could not pick prompts." });
        }
        return;
      }

      const playerIds = sess.players.map((p) => p.id);
      const assignments = buildAssignments(playerIds);
      sess.gamePrompts = pool.map((p) => ({ id: p.id, text: p.text }));
      sess.assignments = assignments;
      sess.answers = {};
      sess.scores = Object.fromEntries(playerIds.map((id) => [id, 0]));
      sess.phase = "answering";

      const showdownQueue = [];
      for (let pass = 0; pass < SHOWDOWN_PASSES; pass++) {
        for (let i = 0; i < n; i++) showdownQueue.push(i);
      }
      sess.showdownQueue = showdownQueue;
      sess.currentQueueIndex = 0;
      sess.showdownVotes = {};
      sess.lastShowdownResult = null;
      sess.winner = null;
      sess.showdownReviewActive = false;
      sess.showdownSplashActive = false;
      clearShowdownTimers(sess);

      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("submit_answers", ({ answers } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (sess.phase !== "answering") {
        if (typeof cb === "function") cb({ ok: false, error: "Not in answer phase." });
        return;
      }
      const mine = new Set(
        sess.assignments
          .filter((a) => a.authorIds.includes(player.id))
          .map((a) => String(a.promptIndex))
      );
      for (const key of mine) {
        const text = String(answers?.[key] ?? "").slice(0, 50);
        if (!sess.answers[key]) sess.answers[key] = {};
        sess.answers[key][player.id] = text;
      }
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);

      if (isAllAnswersIn(sess)) {
        clearShowdownTimers(sess);
        sess.showdownReviewActive = false;
        sess.showdownSplashActive = false;
        sess.phase = "showdown";
        sess.currentQueueIndex = 0;
        sess.showdownVotes = {};
        skipShowdownsWithNoVoters(sess);
        broadcastSession(sess);
      }
    });

    socket.on("vote", ({ choice } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (sess.phase !== "showdown") {
        if (typeof cb === "function") cb({ ok: false, error: "No active showdown." });
        return;
      }
      if (sess.showdownReviewActive) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Vote breakdown in progress — next round soon." });
        }
        return;
      }
      if (sess.showdownSplashActive) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Get ready — voting opens in a moment." });
        }
        return;
      }
      const sd = getCurrentShowdown(sess);
      const authors = sd.authorIds;
      if (authors.includes(player.id)) {
        if (typeof cb === "function") cb({ ok: false, error: "Authors cannot vote." });
        return;
      }
      const c = choice === "B" ? "B" : "A";
      const qi = sess.currentQueueIndex;
      if (!sess.showdownVotes[qi]) sess.showdownVotes[qi] = {};
      sess.showdownVotes[qi][player.id] = c;
      if (typeof cb === "function") cb({ ok: true });

      const eligible = sess.players.map((p) => p.id).filter((id) => !authors.includes(id));
      const cast = Object.keys(sess.showdownVotes[qi] || {}).length;
      broadcastSession(sess);

      if (eligible.length > 0 && cast >= eligible.length) {
        advanceShowdown(sess);
        skipShowdownsWithNoVoters(sess);
        broadcastSession(sess);
      } else if (eligible.length === 0) {
        advanceShowdown(sess);
        skipShowdownsWithNoVoters(sess);
        broadcastSession(sess);
      }
    });

    socket.on("disconnect", () => {
      const proj = findProjectorBySocket(socket.id);
      if (proj) {
        proj.sess.projectors = (proj.sess.projectors || []).filter(
          (x) => x.socketId !== socket.id
        );
        return;
      }
      const found = findPlayerBySocket(socket.id);
      if (!found) return;
      const { sess, player } = found;
      if (sess.phase === "lobby") {
        sess.players = sess.players.filter((p) => p.id !== player.id);
        if (sess.players.length === 0) {
          sessions.delete(sess.code);
        } else {
          if (sess.hostPlayerId === player.id) {
            sess.hostPlayerId = sess.players[0].id;
          }
          broadcastSession(sess);
        }
      } else {
        clearShowdownTimers(sess);
        sessions.delete(sess.code);
        io.to(sess.code).emit("session_state", {
          phase: "gone",
          message: "A player left — session ended.",
        });
      }
    });
  });

  app.get("/health", (_, res) => res.json({ ok: true }));

  server.listen(PORT, () => {
    console.log(`Votemaxxed server on http://localhost:${PORT}`);
  });
}

try {
  startServer();
} catch (e) {
  console.error(e);
  process.exit(1);
}
