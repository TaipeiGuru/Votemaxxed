import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { nanoid, customAlphabet } from "nanoid";
import {
  buildGamePrompts,
  HARDCODED_PROMPTS,
  MAX_PROMPT_TEXT_LEN,
} from "./prompts.js";
import { buildAssignments, scoreShowdown, isUnanimous } from "./gameLogic.js";

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

/** How many full passes over all prompts. */
const SHOWDOWN_PASSES = 1;
const ANSWER_TIME_OPTIONS_SEC = [60, 75, 90];
const DEFAULT_ANSWER_TIME_SEC = 75;
const ANSWER_TIMEUP_SUBMIT_GRACE_MS = 1200;

/** Time vote distribution stays on screen before advancing (after mog/chud when applicable). */
const VOTE_DISTRIBUTION_REVIEW_MS = 7500;
/** Extra delay so overlays can finish before the distribution window counts in earnest. */
const OVERLAY_BEFORE_REVIEW_MS = 3600;
/** Splash between vote distribution and the next prompt. */
const NEXT_VOTE_SPLASH_MS = 3000;
const BOTH_FOLD_OVERLAY_DELAY_MS = 1500;
const BOTH_FOLD_OVERLAY_DURATION_MS = 9000;

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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildUniqueAlternatePrompts(gamePrompts) {
  const primaryKeys = new Set(
    (gamePrompts || []).map((p) => String(p?.text ?? "").trim().toLowerCase())
  );
  // Alternates must be built-in only (never custom), and must not repeat.
  const pool = shuffle(
    HARDCODED_PROMPTS.filter((t) => !primaryKeys.has(String(t).trim().toLowerCase()))
  );

  const out = {};
  const n = gamePrompts?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const key = String(i);
    out[key] = pool.pop() || "";
  }
  return out;
}

function publicPromptAltState(sess) {
  const out = {};
  const n = sess?.gamePrompts?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const key = String(i);
    out[key] = {
      altText: sess.alternatePrompts?.[key] ?? "",
      swapped: !!sess.promptAltSwapped?.[key],
      locked: !!sess.promptAltLocked?.[key],
      rejectedBy: sess.promptAltRejectedBy?.[key] ?? null,
      requestedBy: [...(sess.promptAltRequestedBy?.[key] || [])],
    };
  }
  return out;
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
    const isHostViewer = forPlayerId && forPlayerId === sess.hostPlayerId;
    return {
      ...base,
      customPrompts: isHostViewer ? [...(sess.customPrompts || [])] : [],
      maxCustomPrompts: sess.players.length,
      answerTimeLimitSec: sess.answerTimeLimitSec ?? DEFAULT_ANSWER_TIME_SEC,
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
    const submitted = new Set(sess.answerSubmittedBy || []);
    return {
      ...base,
      promptsMeta,
      myPrompts,
      answersMine,
      allAnswersIn: isAllAnswersIn(sess),
      promptAlt: publicPromptAltState(sess),
      answerTimeLimitSec: sess.answerTimeLimitSec ?? DEFAULT_ANSWER_TIME_SEC,
      answeringEndsAt: sess.answeringEndsAt ?? null,
      myAnswersSubmitted: submitted.has(forPlayerId),
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
    const foldedAuthorIds = getFoldedAuthorIds(sess, sd);
    const answerA = sess.answers[String(promptIndex)]?.[authors[0]] ?? "";
    const answerB = sess.answers[String(promptIndex)]?.[authors[1]] ?? "";
    const eligibleVoters = sess.players
      .map((p) => p.id)
      .filter((id) => !authors.includes(id));

    const myVote =
      sess.showdownVotes[sess.currentQueueIndex]?.[forPlayerId] ?? null;

    const voteCounts = tallyVotes(sess, sd);
    const { votersForA, votersForB } = liveVoterRowsForShowdown(sess, sd);
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
        votersForA,
        votersForB,
        myVote,
        reviewActive: !!sess.showdownReviewActive,
        splashActive: !!sess.showdownSplashActive,
        bothFolded: foldedAuthorIds.length === 2,
        foldedAuthorIds,
        bothFoldStartsAt:
          sess.bothFoldTimeline?.queueIndex === queueIndex
            ? sess.bothFoldTimeline.startsAt
            : null,
        bothFoldEndsAt:
          sess.bothFoldTimeline?.queueIndex === queueIndex
            ? sess.bothFoldTimeline.endsAt
            : null,
        bothFoldAuthorIds:
          sess.bothFoldTimeline?.queueIndex === queueIndex
            ? [...(sess.bothFoldTimeline.foldedAuthorIds || [])]
            : [],
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
  const submitted = new Set(sess.answerSubmittedBy || []);
  return submitted.size >= sess.players.length;
}

function getCurrentShowdown(sess) {
  const qi = sess.currentQueueIndex;
  const promptIndex = sess.showdownQueue[qi];
  return {
    promptIndex,
    authorIds: [...sess.assignments[promptIndex].authorIds],
  };
}

function getFoldedAuthorIds(sess, sd = getCurrentShowdown(sess)) {
  const promptIndex = sd.promptIndex;
  const authors = sd.authorIds;
  const answerA = String(sess.answers[String(promptIndex)]?.[authors[0]] ?? "").trim();
  const answerB = String(sess.answers[String(promptIndex)]?.[authors[1]] ?? "").trim();
  const folded = [];
  if (answerA.length === 0) folded.push(authors[0]);
  if (answerB.length === 0) folded.push(authors[1]);
  return folded;
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

/** Eligible voters who have cast A/B, in session roster order (for projector live lists). */
function liveVoterRowsForShowdown(sess, sd) {
  const votes = sess.showdownVotes[sess.currentQueueIndex] || {};
  const authors = sd.authorIds;
  const votersForA = [];
  const votersForB = [];
  for (const p of sess.players) {
    if (authors.includes(p.id)) continue;
    const c = votes[p.id];
    if (c === "A") votersForA.push({ id: p.id, name: p.name });
    else if (c === "B") votersForB.push({ id: p.id, name: p.name });
  }
  return { votersForA, votersForB };
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
  const submitted = new Set(sess.answerSubmittedBy || []);
  return submitted.has(playerId);
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
  if (sess._bothFoldToSplashTimer) {
    clearTimeout(sess._bothFoldToSplashTimer);
    sess._bothFoldToSplashTimer = null;
  }
  if (sess._nextVoteSplashTimer) {
    clearTimeout(sess._nextVoteSplashTimer);
    sess._nextVoteSplashTimer = null;
  }
}

function clearAnsweringTimer(sess) {
  if (sess._answeringTimer) {
    clearTimeout(sess._answeringTimer);
    sess._answeringTimer = null;
  }
  if (sess._answeringFinalizeTimer) {
    clearTimeout(sess._answeringFinalizeTimer);
    sess._answeringFinalizeTimer = null;
  }
}

function beginShowdownFromAnswering(sess) {
  clearAnsweringTimer(sess);
  clearShowdownTimers(sess);
  sess.bothFoldTimeline = null;
  sess.showdownReviewActive = false;
  sess.showdownSplashActive = true;
  sess.phase = "showdown";
  sess.currentQueueIndex = 0;
  sess.showdownVotes = {};
  sess.answeringEndsAt = null;
  skipShowdownsWithNoVoters(sess);
  if (sess.phase !== "showdown") return;
  const initialQueueIndex = sess.currentQueueIndex;
  const code = sess.code;
  sess._nextVoteSplashTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s) return;
    s._nextVoteSplashTimer = null;
    if (s.phase !== "showdown" || s.currentQueueIndex !== initialQueueIndex) {
      broadcastSession(s);
      return;
    }
    s.showdownSplashActive = false;
    if (!maybeStartBothFoldAutoAdvance(s)) {
      broadcastSession(s);
    }
  }, NEXT_VOTE_SPLASH_MS);
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

function maybeStartBothFoldAutoAdvance(sess) {
  if (
    sess.phase !== "showdown" ||
    sess.showdownReviewActive ||
    sess.showdownSplashActive ||
    sess.currentQueueIndex >= sess.showdownQueue.length
  ) {
    return false;
  }

  const sd = getCurrentShowdown(sess);
  const foldedAuthorIds = getFoldedAuthorIds(sess, sd);
  if (foldedAuthorIds.length === 0) return false;

  clearShowdownTimers(sess);
  const queueIndex = sess.currentQueueIndex;
  const startsAt = Date.now() + BOTH_FOLD_OVERLAY_DELAY_MS;
  const endsAt = startsAt + BOTH_FOLD_OVERLAY_DURATION_MS;
  sess.bothFoldTimeline = { queueIndex, startsAt, endsAt, foldedAuthorIds };
  const code = sess.code;
  sess._bothFoldToSplashTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s) return;
    s._bothFoldToSplashTimer = null;
    if (s.phase !== "showdown" || s.currentQueueIndex !== queueIndex) return;
    s.showdownReviewActive = false;
    s.showdownSplashActive = true;
    broadcastSession(s);
    s._nextVoteSplashTimer = setTimeout(() => {
      const s2 = sessions.get(code);
      if (!s2) return;
      s2._nextVoteSplashTimer = null;
      s2.showdownSplashActive = false;
      if (s2.phase !== "showdown" || s2.currentQueueIndex !== queueIndex) {
        broadcastSession(s2);
        return;
      }
      bumpShowdownQueueAndMaybeEnd(s2);
      skipShowdownsWithNoVoters(s2);
      clearLastShowdownResultIfStillVoting(s2);
      if (!maybeStartBothFoldAutoAdvance(s2)) {
        broadcastSession(s2);
      }
    }, NEXT_VOTE_SPLASH_MS);
  }, BOTH_FOLD_OVERLAY_DELAY_MS + BOTH_FOLD_OVERLAY_DURATION_MS);
  // Ensure clients see the active showdown state (blank answers) before the fold overlay delay.
  broadcastSession(sess);
  return true;
}

function scheduleShowdownQueueAdvance(sess, overlayPause) {
  clearShowdownTimers(sess);
  sess.bothFoldTimeline = null;
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
      if (!maybeStartBothFoldAutoAdvance(s2)) {
        broadcastSession(s2);
      }
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
        answerTimeLimitSec: DEFAULT_ANSWER_TIME_SEC,
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
      if (!sess.hostPlayerId) {
        sess.hostPlayerId = playerId;
      }
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
      if (!c) {
        let newCode = genCode();
        while (sessions.has(newCode)) newCode = genCode();
        const sess = {
          code: newCode,
          hostPlayerId: null,
          players: [],
          projectors: [{ id: nanoid(8), socketId: socket.id }],
          phase: "lobby",
          customPrompts: [],
          answerTimeLimitSec: DEFAULT_ANSWER_TIME_SEC,
        };
        sessions.set(newCode, sess);
        socket.join(sess.code);
        if (typeof cb === "function") cb({ ok: true, code: sess.code, created: true });
        socket.emit("session_state", sessionSnapshotForProjector(sess));
        return;
      }
      const sess = findSessionByCode(c);
      if (!sess) {
        if (typeof cb === "function") cb({ ok: false, error: "Session not found." });
        return;
      }
      if (!sess.projectors) sess.projectors = [];
      sess.projectors = sess.projectors.filter((x) => x.socketId !== socket.id);
      sess.projectors.push({ id: nanoid(8), socketId: socket.id });
      socket.join(sess.code);
      if (typeof cb === "function") cb({ ok: true, code: sess.code, created: false });
      socket.emit("session_state", sessionSnapshotForProjector(sess));
    });

    socket.on("set_answer_time_limit", ({ seconds } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (player.id !== sess.hostPlayerId) {
        if (typeof cb === "function") cb({ ok: false, error: "Only the host can set timer." });
        return;
      }
      if (sess.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Timer can only be changed in lobby." });
        return;
      }
      const s = Number(seconds);
      if (!ANSWER_TIME_OPTIONS_SEC.includes(s)) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid timer option." });
        return;
      }
      sess.answerTimeLimitSec = s;
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
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
      sess.alternatePrompts = buildUniqueAlternatePrompts(sess.gamePrompts);
      sess.promptAltRequestedBy = {};
      sess.promptAltSwapped = {};
      sess.promptAltLocked = {};
      sess.promptAltRejectedBy = {};
      for (let i = 0; i < sess.gamePrompts.length; i++) {
        const key = String(i);
        sess.promptAltRequestedBy[key] = [];
        sess.promptAltSwapped[key] = false;
        sess.promptAltLocked[key] = false;
        sess.promptAltRejectedBy[key] = null;
      }
      sess.scores = Object.fromEntries(playerIds.map((id) => [id, 0]));
      sess.phase = "answering";
      sess.answerSubmittedBy = [];
      const answerLimitSec = sess.answerTimeLimitSec ?? DEFAULT_ANSWER_TIME_SEC;
      sess.answeringEndsAt = Date.now() + answerLimitSec * 1000;
      clearAnsweringTimer(sess);
      const code = sess.code;
      sess._answeringTimer = setTimeout(() => {
        const s = sessions.get(code);
        if (!s || s.phase !== "answering") return;
        s._answeringTimer = null;
        const io2 = globalThis.__io;
        if (io2) io2.to(s.code).emit("answer_time_up");
        s._answeringFinalizeTimer = setTimeout(() => {
          const s2 = sessions.get(code);
          if (!s2 || s2.phase !== "answering") return;
          s2._answeringFinalizeTimer = null;
          for (const p of s2.players) {
            if ((s2.answerSubmittedBy || []).includes(p.id)) continue;
            const mine = s2.assignments
              .filter((a) => a.authorIds.includes(p.id))
              .map((a) => String(a.promptIndex));
            for (const key of mine) {
              const text = String(s2.answers?.[key]?.[p.id] ?? "").slice(0, 50);
              if (!s2.answers[key]) s2.answers[key] = {};
              s2.answers[key][p.id] = text;
            }
            s2.answerSubmittedBy.push(p.id);
          }
          beginShowdownFromAnswering(s2);
          broadcastSession(s2);
        }, ANSWER_TIMEUP_SUBMIT_GRACE_MS);
      }, answerLimitSec * 1000);

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
      if (!Array.isArray(sess.answerSubmittedBy)) sess.answerSubmittedBy = [];
      if (!sess.answerSubmittedBy.includes(player.id)) {
        sess.answerSubmittedBy.push(player.id);
      }
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);

      if (isAllAnswersIn(sess)) {
        beginShowdownFromAnswering(sess);
        broadcastSession(sess);
      }
    });

    socket.on("request_alternate_prompt", ({ promptIndex } = {}, cb) => {
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
      const i = Number(promptIndex);
      if (!Number.isInteger(i) || i < 0 || i >= sess.gamePrompts.length) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid prompt index." });
        return;
      }
      const key = String(i);
      if (sess.promptAltSwapped?.[key]) {
        if (typeof cb === "function") cb({ ok: false, error: "Prompt already switched." });
        return;
      }
      if (sess.promptAltLocked?.[key]) {
        if (typeof cb === "function") cb({ ok: false, error: "Alternate request is locked." });
        return;
      }
      const alt = sess.alternatePrompts?.[key];
      if (!alt || !String(alt).trim()) {
        if (typeof cb === "function") cb({ ok: false, error: "No alternate prompt available." });
        return;
      }
      const authors = sess.assignments[i]?.authorIds || [];
      if (!authors.includes(player.id)) {
        if (typeof cb === "function") cb({ ok: false, error: "Only authors can request a swap." });
        return;
      }
      if (!sess.promptAltRequestedBy) sess.promptAltRequestedBy = {};
      if (!sess.promptAltRequestedBy[key]) sess.promptAltRequestedBy[key] = [];
      const req = sess.promptAltRequestedBy[key];
      if (req.includes(player.id)) {
        if (typeof cb === "function") cb({ ok: true, pending: true });
        broadcastSession(sess);
        return;
      }
      if (req.length > 0 && !req.includes(player.id)) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Other author already requested. Accept or reject the request." });
        }
        broadcastSession(sess);
        return;
      }
      sess.promptAltRequestedBy[key] = [player.id];
      sess.promptAltRejectedBy[key] = null;

      if (typeof cb === "function") cb({ ok: true, pending: true });
      broadcastSession(sess);
    });

    socket.on("accept_alternate_prompt", ({ promptIndex } = {}, cb) => {
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
      const i = Number(promptIndex);
      if (!Number.isInteger(i) || i < 0 || i >= sess.gamePrompts.length) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid prompt index." });
        return;
      }
      const key = String(i);
      if (sess.promptAltSwapped?.[key]) {
        if (typeof cb === "function") cb({ ok: false, error: "Prompt already switched." });
        return;
      }
      if (sess.promptAltLocked?.[key]) {
        if (typeof cb === "function") cb({ ok: false, error: "Alternate request is locked." });
        return;
      }
      const authors = sess.assignments[i]?.authorIds || [];
      if (!authors.includes(player.id)) {
        if (typeof cb === "function") cb({ ok: false, error: "Only authors can accept a swap." });
        return;
      }
      const req = sess.promptAltRequestedBy?.[key] || [];
      const requester = req[0] || null;
      if (!requester || requester === player.id || !authors.includes(requester)) {
        if (typeof cb === "function") cb({ ok: false, error: "No pending request to accept." });
        return;
      }
      const alt = sess.alternatePrompts?.[key];
      if (!alt || !String(alt).trim()) {
        if (typeof cb === "function") cb({ ok: false, error: "No alternate prompt available." });
        return;
      }
      sess.gamePrompts[i].text = alt;
      sess.promptAltSwapped[key] = true;
      sess.promptAltLocked[key] = true;
      sess.promptAltRequestedBy[key] = [requester, player.id];

      if (typeof cb === "function") cb({ ok: true, swapped: true });
      broadcastSession(sess);
    });

    socket.on("reject_alternate_prompt", ({ promptIndex } = {}, cb) => {
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
      const i = Number(promptIndex);
      if (!Number.isInteger(i) || i < 0 || i >= sess.gamePrompts.length) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid prompt index." });
        return;
      }
      const key = String(i);
      if (sess.promptAltSwapped?.[key]) {
        if (typeof cb === "function") cb({ ok: false, error: "Prompt already switched." });
        return;
      }
      if (sess.promptAltLocked?.[key]) {
        if (typeof cb === "function") cb({ ok: false, error: "Alternate request is locked." });
        return;
      }
      const authors = sess.assignments[i]?.authorIds || [];
      if (!authors.includes(player.id)) {
        if (typeof cb === "function") cb({ ok: false, error: "Only authors can reject a swap." });
        return;
      }
      const req = sess.promptAltRequestedBy?.[key] || [];
      const requester = req[0] || null;
      if (!requester || requester === player.id || !authors.includes(requester)) {
        if (typeof cb === "function") cb({ ok: false, error: "No pending request to reject." });
        return;
      }

      sess.promptAltLocked[key] = true;
      sess.promptAltRejectedBy[key] = player.id;
      sess.promptAltRequestedBy[key] = [requester];

      const requesterSocketId = sess.players.find((p) => p.id === requester)?.socketId;
      const rejectorName = sess.players.find((p) => p.id === player.id)?.name || "The other player";
      const io = globalThis.__io;
      if (io && requesterSocketId) {
        io.to(requesterSocketId).emit("alternate_prompt_rejected", {
          promptIndex: i,
          rejectedByName: rejectorName,
        });
      }

      if (typeof cb === "function") cb({ ok: true, rejected: true });
      broadcastSession(sess);
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
      if (getFoldedAuthorIds(sess, sd).length > 0) {
        if (typeof cb === "function") cb({ ok: false, error: "A player failed to answer this round." });
        return;
      }
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
        if (!maybeStartBothFoldAutoAdvance(sess)) {
          broadcastSession(sess);
        }
      } else if (eligible.length === 0) {
        advanceShowdown(sess);
        skipShowdownsWithNoVoters(sess);
        if (!maybeStartBothFoldAutoAdvance(sess)) {
          broadcastSession(sess);
        }
      }
    });

    socket.on("disconnect", () => {
      const proj = findProjectorBySocket(socket.id);
      if (proj) {
        proj.sess.projectors = (proj.sess.projectors || []).filter(
          (x) => x.socketId !== socket.id
        );
        if ((proj.sess.players?.length || 0) === 0 && (proj.sess.projectors?.length || 0) === 0) {
          sessions.delete(proj.sess.code);
        }
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
        clearAnsweringTimer(sess);
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
