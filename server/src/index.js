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
const PHOTO_UPLOAD_TO_CAPTION_TRANSITION_MS = 2500;
const PHOTO_CAPTION_TO_VOTE_LOADING_MS = 2500;
/** Max time photo-round rank voting stays open; early finish when all ballots are complete. */
const PHOTO_VOTING_DURATION_MS = 30000;
const PHOTO_DISTRIBUTION_REVIEW_MS = 7000;
/** How long the projector shows each pairing in `photo_distribution`. */
const PHOTO_DISTRIBUTION_VISIBLE_PER_PAIRING_MS = 5000;
/** Mid-game scoreboard duration (after text round 1 and after doubled text round 2). */
const ROUND1_LEADERBOARD_MS = 15000;
/** Splash after round 1 leaderboard, before round 2 answering (double points). */
const ROUND2_TEXT_SPLASH_MS = 3000;
/** Full-screen pause before photo uploads (after text rounds). */
const PHOTO_ROUND_SPLASH_MS = 3000;
const PHOTO_END_TRANSITION_MS = 2500;
/** Splash before the end-game scoreboard (after photo round wrap-up). */
const FINAL_RESULTS_TRANSITION_MS = 4000;
/** Pause on all clients after "Play again" before a new answering phase. */
const PLAY_AGAIN_TRANSITION_MS = 3500;
const PHOTO_VOTE_POINTS = {
  third: 60,
  second: 120,
  first: 180,
};
const ROUND1_FORFEIT_WIN_POINTS = 50;
const ROUND1_MOG_BONUS_POINTS = 50;

/** Second text round doubles showdown-derived points (vote split, MOG, forfeit). */
function showdownPointMultiplier(sess) {
  return sess?.textRoundNumber === 2 ? 2 : 1;
}
const PHOTO_VOTE_STAGE_ORDER = ["third", "second", "first"];
const MAX_PHOTO_DATA_URL_LEN = 6_000_000;

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

/** Lucide icon keys; one unique assignment per player (max 10). */
const HOST_ICON_KEY = "chess-queen";
const PLAYER_ICON_KEYS = [
  "heart",
  "hourglass",
  HOST_ICON_KEY,
  "club",
  "chess-knight",
  "gem",
  "rocket",
  "skull",
  "flame",
  "dumbbell",
];

const MAX_PLAYERS = 10;

function ensureIconDeck(sess) {
  if (sess._iconDeck == null) {
    sess._iconDeck = shuffle([...PLAYER_ICON_KEYS.filter((k) => k !== HOST_ICON_KEY)]);
    sess._iconDeckCursor = 0;
  }
}

function takeNextIconKey(sess) {
  ensureIconDeck(sess);
  if (sess._iconDeckCursor >= sess._iconDeck.length) {
    throw new Error("Icon deck exhausted");
  }
  return sess._iconDeck[sess._iconDeckCursor++];
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, iconKey: p.iconKey };
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
    answerScores: r.answerScores ?? null,
  };
}

function isPhotoRoundPhase(phase) {
  return (
    phase === "photo_upload" ||
    phase === "photo_caption_transition" ||
    phase === "photo_captioning" ||
    phase === "photo_vote_loading" ||
    phase === "photo_distribution_loading" ||
    phase === "photo_voting" ||
    phase === "photo_distribution"
  );
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
    const tr = sess.textRoundNumber ?? 1;
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
      textRoundNumber: tr,
      showdownPointMultiplier: showdownPointMultiplier(sess),
    };
  }

  if (sess.phase === "round1_scores") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: null,
      showdown: null,
    };
  }

  if (sess.phase === "round2_text_splash") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: null,
      showdown: null,
    };
  }

  if (sess.phase === "round2_scores") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: null,
      showdown: null,
    };
  }

  if (sess.phase === "photo_round_splash") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: null,
      showdown: null,
    };
  }

  if (sess.phase === "final_results_transition") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: null,
      showdown: null,
    };
  }

  if (sess.phase === "play_again_transition") {
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: sess.winner ?? null,
      showdown: null,
      playAgainEndsAt: sess.playAgainEndsAt ?? null,
    };
  }

  if (isPhotoRoundPhase(sess.phase)) {
    const isProjectorViewer = forPlayerId === PROJECTOR_SENTINEL_ID;
    const pr = sess.photoRound || {};
    const myVoteState = pr.rankedVotes?.[forPlayerId] || {};
    const myAssignedUploaderId = pr.captionAssignments?.[forPlayerId] ?? null;
    const myCaptionText = pr.captions?.[forPlayerId] ?? "";
    const myPhotoDataUrl = pr.uploads?.[forPlayerId] ?? "";
    const pairingsPublic = (pr.pairings || []).map((p) => ({
      number: p.number,
      photoDataUrl: p.photoDataUrl || "",
      captionText: p.captionText || "",
      points: Number(p.points || 0),
    }));
    const distributionSorted = [...pairingsPublic].sort((a, b) => {
      if (a.points !== b.points) return b.points - a.points;
      return a.number - b.number;
    });
    return {
      ...base,
      promptsMeta,
      scores: { ...sess.scores },
      photoRound: {
        stage: sess.phase,
        answerTimeLimitSec: sess.answerTimeLimitSec ?? DEFAULT_ANSWER_TIME_SEC,
        uploadEndsAt: pr.uploadEndsAt ?? null,
        captionEndsAt: pr.captionEndsAt ?? null,
        voteEndsAt: pr.voteEndsAt ?? null,
        uploadProgress: isProjectorViewer ? computePhotoUploadProgress(sess) : undefined,
        captionProgress: isProjectorViewer ? computePhotoCaptionProgress(sess) : undefined,
        myPhotoSubmitted: (pr.uploadSubmittedBy || []).includes(forPlayerId),
        myPhotoDataUrl,
        myAssignedPhoto:
          sess.phase === "photo_captioning" ||
          sess.phase === "photo_vote_loading" ||
          sess.phase === "photo_distribution_loading" ||
          sess.phase === "photo_voting" ||
          sess.phase === "photo_distribution"
            ? {
                photoDataUrl: pr.uploads?.[myAssignedUploaderId] || "",
              }
            : null,
        myCaptionText,
        myCaptionSubmitted: (pr.captionSubmittedBy || []).includes(forPlayerId),
        voteChoices: (pr.pairings || []).map((p) => p.number),
        myVotes: {
          third: myVoteState.third ?? null,
          second: myVoteState.second ?? null,
          first: myVoteState.first ?? null,
        },
        pairings: isProjectorViewer && sess.phase !== "photo_upload" ? pairingsPublic : [],
        distribution:
          isProjectorViewer && sess.phase === "photo_distribution"
            ? { pairings: distributionSorted }
            : null,
      },
      lastResult: publicLastResult(sess.lastShowdownResult),
      winner: null,
      showdown: null,
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

    const tr = sess.textRoundNumber ?? 1;
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
        textRoundNumber: tr,
        showdownPointMultiplier: showdownPointMultiplier(sess),
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
    if (c === "A") votersForA.push({ id: p.id, name: p.name, iconKey: p.iconKey });
    else if (c === "B") votersForB.push({ id: p.id, name: p.name, iconKey: p.iconKey });
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
    const row = { id: p.id, name: p.name, iconKey: p.iconKey };
    if (playerHasBothAnswersSaved(sess, p.id)) done.push(row);
    else waiting.push(row);
  }
  return { done, waiting };
}

function computePhotoUploadProgress(sess) {
  const doneSet = new Set(sess.photoRound?.uploadSubmittedBy || []);
  const done = [];
  const waiting = [];
  for (const p of sess.players) {
    const row = { id: p.id, name: p.name, iconKey: p.iconKey };
    if (doneSet.has(p.id)) done.push(row);
    else waiting.push(row);
  }
  return { done, waiting };
}

function computePhotoCaptionProgress(sess) {
  const doneSet = new Set(sess.photoRound?.captionSubmittedBy || []);
  const done = [];
  const waiting = [];
  for (const p of sess.players) {
    const row = { id: p.id, name: p.name, iconKey: p.iconKey };
    if (doneSet.has(p.id)) done.push(row);
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
  /** Projector first so phase transitions (e.g. round 1 → scoreboard) land on the big screen before player handsets. */
  if (sess.projectors?.length) {
    const projSnap = sessionSnapshotForProjector(sess);
    for (const pr of sess.projectors) {
      io.to(pr.socketId).emit("session_state", projSnap);
    }
  }
  for (const p of sess.players) {
    io.to(p.socketId).emit("session_state", sessionSnapshot(sess, p.id));
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

function clearRound1LeaderboardTimer(sess) {
  if (sess._round1LeaderboardTimer) {
    clearTimeout(sess._round1LeaderboardTimer);
    sess._round1LeaderboardTimer = null;
  }
}

function clearPhotoRoundSplashTimer(sess) {
  if (sess._photoRoundSplashTimer) {
    clearTimeout(sess._photoRoundSplashTimer);
    sess._photoRoundSplashTimer = null;
  }
}

function clearRound2ScoresLeaderboardTimer(sess) {
  if (sess._round2ScoresLeaderboardTimer) {
    clearTimeout(sess._round2ScoresLeaderboardTimer);
    sess._round2ScoresLeaderboardTimer = null;
  }
}

function clearRound2TextSplashTimer(sess) {
  if (sess._round2TextSplashTimer) {
    clearTimeout(sess._round2TextSplashTimer);
    sess._round2TextSplashTimer = null;
  }
}

function clearPhotoVoteTimer(sess) {
  if (sess._photoVoteTimer) {
    clearTimeout(sess._photoVoteTimer);
    sess._photoVoteTimer = null;
  }
  if (sess.photoRound) sess.photoRound.voteEndsAt = null;
}

function clearPhotoRoundTimers(sess) {
  if (sess._photoUploadTimer) {
    clearTimeout(sess._photoUploadTimer);
    sess._photoUploadTimer = null;
  }
  if (sess._photoUploadTransitionTimer) {
    clearTimeout(sess._photoUploadTransitionTimer);
    sess._photoUploadTransitionTimer = null;
  }
  if (sess._photoCaptionTimer) {
    clearTimeout(sess._photoCaptionTimer);
    sess._photoCaptionTimer = null;
  }
  clearPhotoVoteTimer(sess);
  if (sess._photoVoteLoadingTimer) {
    clearTimeout(sess._photoVoteLoadingTimer);
    sess._photoVoteLoadingTimer = null;
  }
  if (sess._photoDistributionTimer) {
    clearTimeout(sess._photoDistributionTimer);
    sess._photoDistributionTimer = null;
  }
  if (sess._photoEndTransitionTimer) {
    clearTimeout(sess._photoEndTransitionTimer);
    sess._photoEndTransitionTimer = null;
  }
  if (sess._photoFinalEndTimer) {
    clearTimeout(sess._photoFinalEndTimer);
    sess._photoFinalEndTimer = null;
  }
  if (sess._finalResultsTransitionTimer) {
    clearTimeout(sess._finalResultsTransitionTimer);
    sess._finalResultsTransitionTimer = null;
  }
}

function clearPlayAgainTimer(sess) {
  if (sess._playAgainTimer) {
    clearTimeout(sess._playAgainTimer);
    sess._playAgainTimer = null;
  }
  sess.playAgainEndsAt = null;
}

function clearAllGameTimers(sess) {
  clearAnsweringTimer(sess);
  clearShowdownTimers(sess);
  clearRound1LeaderboardTimer(sess);
  clearRound2TextSplashTimer(sess);
  clearPhotoRoundSplashTimer(sess);
  clearRound2ScoresLeaderboardTimer(sess);
  clearPhotoRoundTimers(sess);
  clearPlayAgainTimer(sess);
}

/**
 * Rebuild prompts, assignments, answering timers, and showdown queue.
 * @param {{ resetScores: boolean }} opts
 */
function setupTextRoundAnswering(sess, opts) {
  const { resetScores } = opts;
  const n = sess.players.length;
  const pool = buildGamePrompts(n, sess.customPrompts || []);
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
  if (resetScores) {
    sess.scores = Object.fromEntries(playerIds.map((id) => [id, 0]));
  }
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
    const indices = Array.from({ length: n }, (_, i) => i);
    showdownQueue.push(...shuffle(indices));
  }
  sess.showdownQueue = showdownQueue;
  sess.currentQueueIndex = 0;
  sess.showdownVotes = {};
  sess.lastShowdownResult = null;
  sess.winner = null;
  sess.showdownReviewActive = false;
  sess.showdownSplashActive = false;
  clearShowdownTimers(sess);
  clearRound1LeaderboardTimer(sess);
  clearRound2TextSplashTimer(sess);
  clearRound2ScoresLeaderboardTimer(sess);
  clearPhotoRoundSplashTimer(sess);
  clearPhotoRoundTimers(sess);
  sess.photoRound = null;
}

/** New game / play again: text round 1 from scratch. */
function commenceAnsweringPhase(sess) {
  clearPlayAgainTimer(sess);
  sess.textRoundNumber = 1;
  setupTextRoundAnswering(sess, { resetScores: true });
}

/** After round 1 leaderboard: same format as round 1 but doubled showdown points. */
function commenceSecondTextRound(sess) {
  sess.textRoundNumber = 2;
  setupTextRoundAnswering(sess, { resetScores: false });
}

function setWinnerFromScores(sess) {
  let best = -1;
  let winners = [];
  for (const p of sess.players) {
    const s = Number(sess.scores?.[p.id] || 0);
    if (s > best) {
      best = s;
      winners = [p];
    } else if (s === best) {
      winners.push(p);
    }
  }
  sess.winner = {
    names: winners.map((w) => w.name),
    players: winners.map(publicPlayer),
    score: best,
  };
}

function initPhotoRoundState(sess) {
  const ids = sess.players.map((p) => p.id);
  const captionAssignments = {};
  const captionerByUploader = {};
  for (let i = 0; i < ids.length; i++) {
    const captionerId = ids[i];
    const uploaderId = ids[(i + 1) % ids.length];
    captionAssignments[captionerId] = uploaderId;
    captionerByUploader[uploaderId] = captionerId;
  }
  const pairings = ids.map((uploaderId, idx) => ({
    number: idx + 1,
    uploaderId,
    captionerId: captionerByUploader[uploaderId],
    photoDataUrl: "",
    captionText: "",
    points: 0,
  }));
  sess.photoRound = {
    uploads: {},
    uploadSubmittedBy: [],
    uploadEndsAt: null,
    captionAssignments,
    captions: {},
    captionSubmittedBy: [],
    captionEndsAt: null,
    voteEndsAt: null,
    pairings,
    rankedVotes: {},
  };
}

function allPhotosSubmitted(sess) {
  return (sess.photoRound?.uploadSubmittedBy || []).length >= sess.players.length;
}

function allCaptionsSubmitted(sess) {
  return (sess.photoRound?.captionSubmittedBy || []).length >= sess.players.length;
}

function allPhotoBallotsComplete(sess) {
  const pr = sess.photoRound;
  if (!pr) return false;
  for (const p of sess.players) {
    const ballot = pr.rankedVotes?.[p.id] || {};
    if (!ballot.third || !ballot.second || !ballot.first) return false;
  }
  return true;
}

function startPhotoCaptioning(sess) {
  if (sess.phase !== "photo_caption_transition") return;
  sess.phase = "photo_captioning";
  const limitMs = (sess.answerTimeLimitSec ?? DEFAULT_ANSWER_TIME_SEC) * 1000;
  sess.photoRound.captionEndsAt = Date.now() + limitMs;
  const code = sess.code;
  sess._photoCaptionTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_captioning") return;
    s._photoCaptionTimer = null;
    finalizePhotoCaptioning(s);
  }, limitMs);
  broadcastSession(sess);
}

function startPhotoVoting(sess) {
  if (sess.phase !== "photo_vote_loading") return;
  const pr = sess.photoRound;
  if (!pr) return;
  clearPhotoVoteTimer(sess);
  sess.phase = "photo_voting";
  const code = sess.code;
  const ms = PHOTO_VOTING_DURATION_MS;
  pr.voteEndsAt = Date.now() + ms;
  sess._photoVoteTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_voting") return;
    s._photoVoteTimer = null;
    finalizePhotoVotingAndScore(s);
  }, ms);
  broadcastSession(sess);
}

function finalizePhotoVotingAndScore(sess) {
  clearPhotoVoteTimer(sess);
  if (sess.phase !== "photo_voting") return;
  const pr = sess.photoRound;
  if (!pr) return;
  const pointsByNumber = new Map(pr.pairings.map((p) => [p.number, 0]));
  for (const ballot of Object.values(pr.rankedVotes || {})) {
    for (const stage of PHOTO_VOTE_STAGE_ORDER) {
      const number = Number(ballot?.[stage] || 0);
      if (!number || !pointsByNumber.has(number)) continue;
      pointsByNumber.set(number, pointsByNumber.get(number) + PHOTO_VOTE_POINTS[stage]);
    }
  }
  for (const pairing of pr.pairings) {
    const totalPoints = Number(pointsByNumber.get(pairing.number) || 0);
    pairing.points = totalPoints;
    const split = totalPoints / 2;
    sess.scores[pairing.uploaderId] = (sess.scores[pairing.uploaderId] || 0) + split;
    sess.scores[pairing.captionerId] = (sess.scores[pairing.captionerId] || 0) + split;
  }
  const code = sess.code;
  const photoDistributionVisibleMs =
    (pr.pairings?.length || 0) * PHOTO_DISTRIBUTION_VISIBLE_PER_PAIRING_MS;
  sess.phase = "photo_distribution_loading";
  broadcastSession(sess);
  sess._photoDistributionTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_distribution_loading") return;
    s._photoDistributionTimer = null;
    s.phase = "photo_distribution";
    broadcastSession(s);
    s._photoEndTransitionTimer = setTimeout(() => {
      const s2 = sessions.get(code);
      if (!s2 || s2.phase !== "photo_distribution") return;
      s2._photoEndTransitionTimer = null;
      s2.phase = "final_results_transition";
      broadcastSession(s2);
      s2._finalResultsTransitionTimer = setTimeout(() => {
        const s4 = sessions.get(code);
        if (!s4 || s4.phase !== "final_results_transition") return;
        s4._finalResultsTransitionTimer = null;
        s4.phase = "ended";
        setWinnerFromScores(s4);
        broadcastSession(s4);
      }, FINAL_RESULTS_TRANSITION_MS);
    }, photoDistributionVisibleMs);
  }, PHOTO_DISTRIBUTION_REVIEW_MS);
}

function finalizePhotoCaptioning(sess) {
  if (sess.phase !== "photo_captioning") return;
  const pr = sess.photoRound;
  if (!pr) return;
  for (const p of sess.players) {
    if (!pr.captionSubmittedBy.includes(p.id)) pr.captionSubmittedBy.push(p.id);
    if (typeof pr.captions[p.id] !== "string") pr.captions[p.id] = "";
  }
  for (const pairing of pr.pairings) {
    pairing.photoDataUrl = String(pr.uploads[pairing.uploaderId] || "");
    pairing.captionText = String(pr.captions[pairing.captionerId] || "");
  }
  pr.captionEndsAt = null;
  sess.phase = "photo_vote_loading";
  broadcastSession(sess);
  const code = sess.code;
  sess._photoVoteLoadingTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_vote_loading") return;
    s._photoVoteLoadingTimer = null;
    startPhotoVoting(s);
  }, PHOTO_CAPTION_TO_VOTE_LOADING_MS);
}

function finalizePhotoUpload(sess) {
  if (sess.phase !== "photo_upload") return;
  const pr = sess.photoRound;
  if (!pr) return;
  for (const p of sess.players) {
    if (!pr.uploadSubmittedBy.includes(p.id)) pr.uploadSubmittedBy.push(p.id);
    if (typeof pr.uploads[p.id] !== "string") pr.uploads[p.id] = "";
  }
  pr.uploadEndsAt = null;
  sess.phase = "photo_caption_transition";
  broadcastSession(sess);
  const code = sess.code;
  sess._photoUploadTransitionTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_caption_transition") return;
    s._photoUploadTransitionTimer = null;
    startPhotoCaptioning(s);
  }, PHOTO_UPLOAD_TO_CAPTION_TRANSITION_MS);
}

function beginRound1Leaderboard(sess) {
  clearRound1LeaderboardTimer(sess);
  clearRound2TextSplashTimer(sess);
  clearShowdownTimers(sess);
  sess.bothFoldTimeline = null;
  sess.showdownReviewActive = false;
  sess.showdownSplashActive = false;
  sess.phase = "round1_scores";
  const code = sess.code;
  broadcastSession(sess);
  sess._round1LeaderboardTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "round1_scores") return;
    s._round1LeaderboardTimer = null;
    startRound2TextSplash(s);
    broadcastSession(s);
  }, ROUND1_LEADERBOARD_MS);
}

function startRound2TextSplash(sess) {
  clearRound2TextSplashTimer(sess);
  sess.phase = "round2_text_splash";
  const code = sess.code;
  sess._round2TextSplashTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "round2_text_splash") return;
    s._round2TextSplashTimer = null;
    commenceSecondTextRound(s);
    broadcastSession(s);
  }, ROUND2_TEXT_SPLASH_MS);
}

function beginRound2ScoresLeaderboard(sess) {
  clearRound2ScoresLeaderboardTimer(sess);
  clearShowdownTimers(sess);
  sess.bothFoldTimeline = null;
  sess.showdownReviewActive = false;
  sess.showdownSplashActive = false;
  sess.phase = "round2_scores";
  const code = sess.code;
  broadcastSession(sess);
  sess._round2ScoresLeaderboardTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "round2_scores") return;
    s._round2ScoresLeaderboardTimer = null;
    startPhotoRoundSplash(s);
    broadcastSession(s);
  }, ROUND1_LEADERBOARD_MS);
}

function startPhotoRoundSplash(sess) {
  clearPhotoRoundSplashTimer(sess);
  sess.phase = "photo_round_splash";
  broadcastSession(sess);
  const code = sess.code;
  sess._photoRoundSplashTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_round_splash") return;
    s._photoRoundSplashTimer = null;
    startPhotoRound(s);
    broadcastSession(s);
  }, PHOTO_ROUND_SPLASH_MS);
}

function startPhotoRound(sess) {
  clearRound1LeaderboardTimer(sess);
  clearRound2TextSplashTimer(sess);
  clearRound2ScoresLeaderboardTimer(sess);
  clearPhotoRoundSplashTimer(sess);
  clearPhotoRoundTimers(sess);
  initPhotoRoundState(sess);
  sess.phase = "photo_upload";
  const limitMs = (sess.answerTimeLimitSec ?? DEFAULT_ANSWER_TIME_SEC) * 1000;
  sess.photoRound.uploadEndsAt = Date.now() + limitMs;
  const code = sess.code;
  sess._photoUploadTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_upload") return;
    s._photoUploadTimer = null;
    finalizePhotoUpload(s);
  }, limitMs);
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
    if (sess.textRoundNumber === 2) {
      beginRound2ScoresLeaderboard(sess);
    } else {
      beginRound1Leaderboard(sess);
    }
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
  if (sess.bothFoldTimeline?.queueIndex === sess.currentQueueIndex) return true;

  // For exactly one blank answer, treat it as a forfeit:
  // non-blank author gets the full round-1 win value.
  if (foldedAuthorIds.length === 1) {
    const forfeiterId = foldedAuthorIds[0];
    const winnerId = sd.authorIds.find((id) => id !== forfeiterId) ?? null;
    if (winnerId) {
      const mult = showdownPointMultiplier(sess);
      sess.scores[winnerId] =
        (sess.scores[winnerId] || 0) + ROUND1_FORFEIT_WIN_POINTS * mult;
    }
  }

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

  const mult = showdownPointMultiplier(sess);
  const basePoints = scoreShowdown(votesForA, votesForB, authors[0], authors[1]);
  for (const pid of Object.keys(basePoints)) {
    basePoints[pid] = Number(basePoints[pid] || 0) * mult;
  }
  const points = { ...basePoints };
  const uni = isUnanimous(votesForA, votesForB);
  const mogBonusAmount =
    uni && eligible.length > 0 ? ROUND1_MOG_BONUS_POINTS * mult : 0;
  if (uni && eligible.length > 0) {
    const winningAuthor = uni.winner === "A" ? authors[0] : authors[1];
    points[winningAuthor] = Number(points[winningAuthor] || 0) + mogBonusAmount;
  }
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
    const iconKey = pl?.iconKey;
    if (c === "A") votersForA.push({ id: vid, name: nm, iconKey });
    else if (c === "B") votersForB.push({ id: vid, name: nm, iconKey });
  }

  const authorAName = sess.players.find((p) => p.id === authors[0])?.name ?? "?";
  const authorBName = sess.players.find((p) => p.id === authors[1])?.name ?? "?";

  let mogPayload = null;
  if (uni && eligible.length > 0) {
    const winningSide = uni.winner;
    const winningAuthor = winningSide === "A" ? authors[0] : authors[1];
    const winningAnswer = winningSide === "A" ? answerAText : answerBText;
    mogPayload = {
      promptText,
      winningAnswer,
      winningAuthorName: sess.players.find((p) => p.id === winningAuthor)?.name ?? "?",
      winningAuthorId: winningAuthor,
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
    answerScores: {
      sideA: {
        base: basePoints[authors[0]] ?? 0,
        mogBonus:
          uni && eligible.length > 0 && uni.winner === "A" ? mogBonusAmount : 0,
      },
      sideB: {
        base: basePoints[authors[1]] ?? 0,
        mogBonus:
          uni && eligible.length > 0 && uni.winner === "B" ? mogBonusAmount : 0,
      },
    },
    mog: mogPayload,
    overlayPause,
    voteBreakdown: {
      promptText,
      answerAText,
      answerBText,
      authorAName,
      authorBName,
      authorAId: authors[0],
      authorBId: authors[1],
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
        players: [],
        projectors: [],
        phase: "lobby",
        customPrompts: [],
        answerTimeLimitSec: DEFAULT_ANSWER_TIME_SEC,
      };
      ensureIconDeck(sess);
      sess.players.push({
        id: hostPlayerId,
        name,
        socketId: socket.id,
        iconKey: HOST_ICON_KEY,
      });
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
      if (sess.players.length >= MAX_PLAYERS) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Session is full (10 players max)." });
        }
        return;
      }
      const playerId = nanoid(12);
      ensureIconDeck(sess);
      const isBecomingHost = !sess.hostPlayerId;
      sess.players.push({
        id: playerId,
        name: playerName,
        socketId: socket.id,
        iconKey: isBecomingHost ? HOST_ICON_KEY : takeNextIconKey(sess),
      });
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
        ensureIconDeck(sess);
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

      try {
        commenceAnsweringPhase(sess);
      } catch (e) {
        if (typeof cb === "function") {
          cb({ ok: false, error: e.message || "Could not pick prompts." });
        }
        return;
      }

      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("play_again", (_, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (player.id !== sess.hostPlayerId) {
        if (typeof cb === "function") cb({ ok: false, error: "Only the host can start another game." });
        return;
      }
      if (sess.phase !== "ended") {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Play again is only available after the game ends." });
        }
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

      clearAllGameTimers(sess);
      const code = sess.code;
      sess.phase = "play_again_transition";
      sess.playAgainEndsAt = Date.now() + PLAY_AGAIN_TRANSITION_MS;
      sess._playAgainTimer = setTimeout(() => {
        const s = sessions.get(code);
        if (!s || s.phase !== "play_again_transition") return;
        s._playAgainTimer = null;
        try {
          commenceAnsweringPhase(s);
        } catch (e) {
          console.error("[play_again]", e);
          s.phase = "ended";
          broadcastSession(s);
          return;
        }
        broadcastSession(s);
      }, PLAY_AGAIN_TRANSITION_MS);

      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("new_game", (_, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (player.id !== sess.hostPlayerId) {
        if (typeof cb === "function") cb({ ok: false, error: "Only the host can start a new game." });
        return;
      }
      if (sess.phase !== "ended") {
        if (typeof cb === "function") {
          cb({ ok: false, error: "New game is only available after the game ends." });
        }
        return;
      }

      clearAllGameTimers(sess);

      const oldCode = sess.code;
      let newCode = genCode();
      while (sessions.has(newCode)) newCode = genCode();
      sessions.delete(oldCode);
      sess.code = newCode;
      sessions.set(newCode, sess);

      for (const p of sess.players) {
        const sock = io.sockets.sockets.get(p.socketId);
        if (sock) {
          sock.leave(oldCode);
          sock.join(newCode);
        }
      }
      for (const pr of sess.projectors || []) {
        const sock = io.sockets.sockets.get(pr.socketId);
        if (sock) {
          sock.leave(oldCode);
          sock.join(newCode);
        }
      }

      sess.phase = "lobby";
      sess.customPrompts = [];
      sess.winner = null;
      sess.photoRound = null;
      sess.lastShowdownResult = null;
      sess.scores = {};
      delete sess.gamePrompts;
      delete sess.assignments;
      delete sess.answers;
      delete sess.alternatePrompts;
      delete sess.promptAltRequestedBy;
      delete sess.promptAltSwapped;
      delete sess.promptAltLocked;
      delete sess.promptAltRejectedBy;
      delete sess.showdownQueue;
      delete sess.currentQueueIndex;
      delete sess.showdownVotes;
      delete sess.showdownReviewActive;
      delete sess.showdownSplashActive;
      delete sess.answerSubmittedBy;
      delete sess.answeringEndsAt;
      delete sess.bothFoldTimeline;
      delete sess.textRoundNumber;

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

    socket.on("submit_photo", ({ photoDataUrl } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (sess.phase !== "photo_upload") {
        if (typeof cb === "function") cb({ ok: false, error: "Not in photo upload phase." });
        return;
      }
      if (!sess.photoRound) {
        if (typeof cb === "function") cb({ ok: false, error: "Photo round is not initialized." });
        return;
      }
      const encoded = String(photoDataUrl || "").trim();
      if (!encoded.startsWith("data:image/")) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid photo format." });
        return;
      }
      if (encoded.length > MAX_PHOTO_DATA_URL_LEN) {
        if (typeof cb === "function") cb({ ok: false, error: "Photo is too large." });
        return;
      }
      sess.photoRound.uploads[player.id] = encoded;
      if (!sess.photoRound.uploadSubmittedBy.includes(player.id)) {
        sess.photoRound.uploadSubmittedBy.push(player.id);
      }
      if (typeof cb === "function") cb({ ok: true });
      if (allPhotosSubmitted(sess)) {
        finalizePhotoUpload(sess);
      } else {
        broadcastSession(sess);
      }
    });

    socket.on("submit_photo_caption", ({ caption } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (sess.phase !== "photo_captioning") {
        if (typeof cb === "function") cb({ ok: false, error: "Not in caption phase." });
        return;
      }
      if (!sess.photoRound) {
        if (typeof cb === "function") cb({ ok: false, error: "Photo round is not initialized." });
        return;
      }
      const text = String(caption || "").slice(0, 160);
      sess.photoRound.captions[player.id] = text;
      if (!sess.photoRound.captionSubmittedBy.includes(player.id)) {
        sess.photoRound.captionSubmittedBy.push(player.id);
      }
      if (typeof cb === "function") cb({ ok: true });
      if (allCaptionsSubmitted(sess)) {
        finalizePhotoCaptioning(sess);
      } else {
        broadcastSession(sess);
      }
    });

    socket.on("submit_photo_rank_vote", ({ rank, number } = {}, cb) => {
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;
      if (sess.phase !== "photo_voting") {
        if (typeof cb === "function") cb({ ok: false, error: "Not in photo voting phase." });
        return;
      }
      const pr = sess.photoRound;
      if (!pr) {
        if (typeof cb === "function") cb({ ok: false, error: "Photo round is not initialized." });
        return;
      }
      const rankKey = rank === "first" || rank === "second" || rank === "third" ? rank : null;
      if (!rankKey) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid rank (use third, second, or first)." });
        return;
      }
      const choice = Number(number);
      const validChoices = new Set((pr.pairings || []).map((p) => p.number));
      if (!validChoices.has(choice)) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid choice." });
        return;
      }
      const ballot = { ...(pr.rankedVotes[player.id] || {}) };
      for (const k of PHOTO_VOTE_STAGE_ORDER) {
        if (k === rankKey) continue;
        if (ballot[k] === choice) {
          if (typeof cb === "function") {
            cb({ ok: false, error: "You cannot use the same pairing for two ranks." });
          }
          return;
        }
      }
      ballot[rankKey] = choice;
      pr.rankedVotes[player.id] = ballot;
      if (typeof cb === "function") cb({ ok: true });
      if (allPhotoBallotsComplete(sess)) {
        finalizePhotoVotingAndScore(sess);
      } else {
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
            sess.players[0].iconKey = HOST_ICON_KEY;
          }
          broadcastSession(sess);
        }
      } else if (sess.phase === "play_again_transition") {
        clearPlayAgainTimer(sess);
        sess.players = sess.players.filter((p) => p.id !== player.id);
        if (sess.players.length === 0) {
          sessions.delete(sess.code);
          return;
        }
        if (sess.hostPlayerId === player.id) {
          sess.hostPlayerId = sess.players[0].id;
          sess.players[0].iconKey = HOST_ICON_KEY;
        }
        sess.phase = "ended";
        broadcastSession(sess);
      } else {
        clearAllGameTimers(sess);
        const goneCode = sess.code;
        sessions.delete(sess.code);
        io.to(goneCode).emit("session_state", {
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
