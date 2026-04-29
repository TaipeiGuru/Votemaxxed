import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { nanoid, customAlphabet } from "nanoid";
import {
  buildGamePrompts,
  buildAlternatePromptMap,
  MAX_PROMPT_TEXT_LEN,
  reportPrompt,
} from "./prompts.js";
import { buildAssignments, scoreShowdown, isUnanimous } from "./gameLogic.js";
import {
  ANSWER_TIMEUP_SUBMIT_GRACE_MS,
  ANSWER_TIME_OPTIONS_SEC,
  BOTH_FOLD_OVERLAY_DELAY_MS,
  BOTH_FOLD_OVERLAY_DURATION_MS,
  CLIENT_ORIGIN,
  DEFAULT_ANSWER_TIME_SEC,
  DEFAULT_EVENT_PAYLOAD_MAX_BYTES,
  FINAL_RESULTS_TRANSITION_MS,
  HOST_ICON_KEY,
  MAX_ACTIVE_SESSIONS,
  MAX_PHOTO_DATA_URL_LEN,
  MAX_PLAYERS,
  NEXT_VOTE_SPLASH_MS,
  OVERLAY_BEFORE_REVIEW_MS,
  PHOTO_CAPTION_TO_VOTE_LOADING_MS,
  PHOTO_DISTRIBUTION_CAROUSEL_PER_PAIRING_MS,
  PHOTO_DISTRIBUTION_GRID_VISIBLE_MS,
  PHOTO_DISTRIBUTION_REVIEW_MS,
  PHOTO_EVENT_PAYLOAD_MAX_BYTES,
  PHOTO_ROUND_SPLASH_MS,
  PHOTO_UPLOAD_TO_CAPTION_TRANSITION_MS,
  PHOTO_VOTE_POINTS,
  PHOTO_VOTE_STAGE_ORDER,
  PHOTO_VOTING_DURATION_MS,
  PLAY_AGAIN_TRANSITION_MS,
  PLAYER_ICON_KEYS,
  PORT,
  RATE_LIMITS,
  ROUND1_FORFEIT_WIN_POINTS,
  ROUND1_LEADERBOARD_MS,
  ROUND1_MOG_BONUS_POINTS,
  ROUND2_TEXT_SPLASH_MS,
  SHOWDOWN_VOTING_DURATION_MS,
  SHOWDOWN_PASSES,
  SOCKET_EVENT_PAYLOAD_LIMITS,
  VOTE_DISTRIBUTION_REVIEW_MS,
  showdownPointMultiplier,
  pickChudTease,
} from "./constants.js";
import { allowByRateLimit } from "./utils/rateLimit.js";
import { clampIntInput, clampStringInput, isPlainObject, payloadBytes } from "./utils/input.js";
import { shuffle } from "./utils/random.js";
import {
  isAllAnswersIn,
  getCurrentShowdown,
  getFoldedAuthorIds,
  tallyVotes,
  liveVoterRowsForShowdown,
  sessionSnapshot,
  sessionSnapshotForProjector,
} from "./sessionSnapshot.js";

const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "32kb", strict: true }));

/** @type {Map<string, object>} */
const sessions = new Map();

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
  if (sess._showdownVoteTimer) {
    clearTimeout(sess._showdownVoteTimer);
    sess._showdownVoteTimer = null;
  }
  sess.showdownVoteEndsAt = null;
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
  if (sess._photoVoteCarouselTimer) {
    clearTimeout(sess._photoVoteCarouselTimer);
    sess._photoVoteCarouselTimer = null;
  }
  if (sess._photoVotePreviewTimer) {
    clearTimeout(sess._photoVotePreviewTimer);
    sess._photoVotePreviewTimer = null;
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
async function setupTextRoundAnswering(sess, opts) {
  const { resetScores } = opts;
  const n = sess.players.length;
  const pool = await buildGamePrompts(n, sess.customPrompts || []);
  const playerIds = sess.players.map((p) => p.id);
  const assignments = buildAssignments(playerIds);
  sess.gamePrompts = pool.map((p) => ({ id: p.id, text: p.text }));
  sess.assignments = assignments;
  sess.answers = {};
  sess.alternatePrompts = await buildAlternatePromptMap(sess.gamePrompts);
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
  sess.showdownVoteEndsAt = null;
  clearShowdownTimers(sess);
  clearRound1LeaderboardTimer(sess);
  clearRound2TextSplashTimer(sess);
  clearRound2ScoresLeaderboardTimer(sess);
  clearPhotoRoundSplashTimer(sess);
  clearPhotoRoundTimers(sess);
  sess.photoRound = null;
}

/** New game / play again: text round 1 from scratch. */
async function commenceAnsweringPhase(sess) {
  clearPlayAgainTimer(sess);
  sess.textRoundNumber = 1;
  await setupTextRoundAnswering(sess, { resetScores: true });
}

/** After round 1 leaderboard: same format as round 1 but doubled showdown points. */
async function commenceSecondTextRound(sess) {
  sess.textRoundNumber = 2;
  await setupTextRoundAnswering(sess, { resetScores: false });
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
    players: winners.map((w) => ({ id: w.id, name: w.name, iconKey: w.iconKey })),
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
    voteCarouselStartedAt: null,
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
  const code = sess.code;
  const carouselVisibleMs =
    (pr.pairings?.length || 0) * PHOTO_DISTRIBUTION_CAROUSEL_PER_PAIRING_MS;
  sess.phase = "photo_vote_carousel";
  pr.voteCarouselStartedAt = Date.now();
  broadcastSession(sess);
  sess._photoVoteCarouselTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_vote_carousel") return;
    s._photoVoteCarouselTimer = null;
    if (s.photoRound) s.photoRound.voteCarouselStartedAt = null;
    s.phase = "photo_voting";
    const ms = PHOTO_VOTING_DURATION_MS;
    if (s.photoRound) s.photoRound.voteEndsAt = Date.now() + ms;
    broadcastSession(s);
    s._photoVoteTimer = setTimeout(() => {
      const s2 = sessions.get(code);
      if (!s2 || s2.phase !== "photo_voting") return;
      s2._photoVoteTimer = null;
      finalizePhotoVotingAndScore(s2);
    }, ms);
  }, carouselVisibleMs);
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
  sess.phase = "photo_distribution_loading";
  pr.voteCarouselStartedAt = null;
  broadcastSession(sess);
  sess._photoDistributionTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s || s.phase !== "photo_distribution_loading") return;
    s._photoDistributionTimer = null;
    s.phase = "photo_distribution";
    broadcastSession(s);
    s._photoFinalEndTimer = setTimeout(() => {
      const s2 = sessions.get(code);
      if (!s2 || s2.phase !== "photo_distribution") return;
      s2._photoFinalEndTimer = null;
      s2.phase = "final_results_transition";
      broadcastSession(s2);
      s2._finalResultsTransitionTimer = setTimeout(() => {
        const s3 = sessions.get(code);
        if (!s3 || s3.phase !== "final_results_transition") return;
        s3._finalResultsTransitionTimer = null;
        s3.phase = "ended";
        setWinnerFromScores(s3);
        broadcastSession(s3);
      }, FINAL_RESULTS_TRANSITION_MS);
    }, PHOTO_DISTRIBUTION_GRID_VISIBLE_MS);
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
  sess._round2TextSplashTimer = setTimeout(async () => {
    const s = sessions.get(code);
    if (!s || s.phase !== "round2_text_splash") return;
    s._round2TextSplashTimer = null;
    try {
      await commenceSecondTextRound(s);
      broadcastSession(s);
    } catch (e) {
      console.error("[round2_text_splash]", e);
      s.phase = "ended";
      setWinnerFromScores(s);
      broadcastSession(s);
    }
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
  sess.showdownVoteEndsAt = null;
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
      scheduleShowdownVoteTimeout(s);
      broadcastSession(s);
    }
  }, NEXT_VOTE_SPLASH_MS);
}

function scheduleShowdownVoteTimeout(sess) {
  if (
    sess.phase !== "showdown" ||
    sess.showdownReviewActive ||
    sess.showdownSplashActive ||
    sess.currentQueueIndex >= sess.showdownQueue.length
  ) {
    return;
  }
  if (sess._showdownVoteTimer) {
    clearTimeout(sess._showdownVoteTimer);
    sess._showdownVoteTimer = null;
  }
  const sd = getCurrentShowdown(sess);
  if (getFoldedAuthorIds(sess, sd).length > 0) {
    sess.showdownVoteEndsAt = null;
    return;
  }
  const eligible = sess.players.map((p) => p.id).filter((id) => !sd.authorIds.includes(id));
  if (eligible.length === 0) {
    sess.showdownVoteEndsAt = null;
    return;
  }
  const queueIndex = sess.currentQueueIndex;
  const code = sess.code;
  sess.showdownVoteEndsAt = Date.now() + SHOWDOWN_VOTING_DURATION_MS;
  sess._showdownVoteTimer = setTimeout(() => {
    const s = sessions.get(code);
    if (!s) return;
    s._showdownVoteTimer = null;
    if (
      s.phase !== "showdown" ||
      s.showdownReviewActive ||
      s.showdownSplashActive ||
      s.currentQueueIndex !== queueIndex
    ) {
      return;
    }
    s.showdownVoteEndsAt = null;
    advanceShowdown(s);
    skipShowdownsWithNoVoters(s);
    if (!maybeStartBothFoldAutoAdvance(s)) {
      broadcastSession(s);
    }
  }, SHOWDOWN_VOTING_DURATION_MS);
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
        scheduleShowdownVoteTimeout(s2);
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
        scheduleShowdownVoteTimeout(s2);
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
  if (sess._showdownVoteTimer) {
    clearTimeout(sess._showdownVoteTimer);
    sess._showdownVoteTimer = null;
  }
  sess.showdownVoteEndsAt = null;
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
  const votesCast = Object.keys(votes).filter((pid) => eligible.includes(pid)).length;
  const allEligibleVoted = eligible.length > 0 && votesCast === eligible.length;
  const uni = allEligibleVoted ? isUnanimous(votesForA, votesForB) : null;
  const mogBonusAmount =
    uni ? ROUND1_MOG_BONUS_POINTS * mult : 0;
  if (uni) {
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
  if (uni) {
    const winningSide = uni.winner;
    const winningAuthor = winningSide === "A" ? authors[0] : authors[1];
    const winningAnswer = winningSide === "A" ? answerAText : answerBText;
    mogPayload = {
      promptText,
      winningAnswer,
      winningAuthorName: sess.players.find((p) => p.id === winningAuthor)?.name ?? "?",
      winningAuthorId: winningAuthor,
    };
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
          uni && uni.winner === "A" ? mogBonusAmount : 0,
      },
      sideB: {
        base: basePoints[authors[1]] ?? 0,
        mogBonus:
          uni && uni.winner === "B" ? mogBonusAmount : 0,
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
    const winnerSocketId =
      sess.players.find((p) => p.id === mogPayload.winningAuthorId)?.socketId ?? null;
    if (winnerSocketId) {
      io.to(winnerSocketId).emit("unanimous_victory", mogPayload);
    }
    for (const pr of sess.projectors || []) {
      io.to(pr.socketId).emit("unanimous_victory", mogPayload);
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
    maxHttpBufferSize: PHOTO_EVENT_PAYLOAD_MAX_BYTES,
    cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
  });
  globalThis.__io = io;

  io.on("connection", (socket) => {
    socket.use((packet, next) => {
      const [eventName, payload] = packet;
      if (typeof eventName !== "string") {
        return next(new Error("Invalid event."));
      }
      if (payload !== undefined && !isPlainObject(payload)) {
        return next(new Error("Payload must be an object."));
      }
      const maxBytes =
        SOCKET_EVENT_PAYLOAD_LIMITS[eventName] ?? DEFAULT_EVENT_PAYLOAD_MAX_BYTES;
      if (payloadBytes(payload) > maxBytes) {
        return next(new Error("Payload too large."));
      }
      return next();
    });

    socket.on("create_session", (payload = {}, cb) => {
      if (!allowByRateLimit(socket, "create_session", RATE_LIMITS.createSession)) {
        if (typeof cb === "function") cb({ ok: false, error: "Too many requests. Try again soon." });
        return;
      }
      if (sessions.size >= MAX_ACTIVE_SESSIONS) {
        if (typeof cb === "function") cb({ ok: false, error: "Server is full. Try again later." });
        return;
      }
      const name = clampStringInput(payload.hostName, { maxLen: 24 }) || "Host";
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

    socket.on("join_session", (payload = {}, cb) => {
      if (!allowByRateLimit(socket, "join_session", RATE_LIMITS.joinSession)) {
        if (typeof cb === "function") cb({ ok: false, error: "Too many requests. Try again soon." });
        return;
      }
      if (findProjectorBySocket(socket.id)) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Disconnect the projector tab before joining as a player." });
        }
        return;
      }
      const c = clampStringInput(payload.code, {
        minLen: 6,
        maxLen: 6,
        trim: true,
        uppercase: true,
        pattern: /^[A-Z2-9]{6}$/,
      });
      if (!c) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid session code format." });
        return;
      }
      const sess = findSessionByCode(c);
      if (!sess) {
        if (typeof cb === "function") cb({ ok: false, error: "Session not found." });
        return;
      }
      if (sess.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Game already started." });
        return;
      }
      const playerName = clampStringInput(payload.name, { maxLen: 24 }) || "Player";
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

    socket.on("join_projector", (payload = {}, cb) => {
      if (findPlayerBySocket(socket.id)) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Leave the player session before opening projector mode." });
        }
        return;
      }
      const cRaw = payload.code;
      const c =
        cRaw == null || cRaw === ""
          ? ""
          : clampStringInput(cRaw, {
              minLen: 6,
              maxLen: 6,
              trim: true,
              uppercase: true,
              pattern: /^[A-Z2-9]{6}$/,
            });
      if (cRaw && !c) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid session code format." });
        return;
      }
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

    socket.on("set_answer_time_limit", (payload = {}, cb) => {
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
      const s = clampIntInput(payload.seconds, { min: 1, max: 600 });
      if (!ANSWER_TIME_OPTIONS_SEC.includes(s)) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid timer option." });
        return;
      }
      sess.answerTimeLimitSec = s;
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("add_custom_prompt", (payload = {}, cb) => {
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
      const t = clampStringInput(payload.text, { maxLen: MAX_PROMPT_TEXT_LEN });
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

    socket.on("remove_custom_prompt", (payload = {}, cb) => {
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
      const i = clampIntInput(payload.index, { min: 0, max: 10_000 });
      if (!Number.isInteger(i) || i < 0 || i >= sess.customPrompts.length) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid prompt index." });
        return;
      }
      sess.customPrompts.splice(i, 1);
      if (typeof cb === "function") cb({ ok: true });
      broadcastSession(sess);
    });

    socket.on("start_game", async (_, cb) => {
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
        await commenceAnsweringPhase(sess);
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
      sess._playAgainTimer = setTimeout(async () => {
        const s = sessions.get(code);
        if (!s || s.phase !== "play_again_transition") return;
        s._playAgainTimer = null;
        try {
          await commenceAnsweringPhase(s);
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

    socket.on("submit_answers", (payload = {}, cb) => {
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
      const rawAnswers = payload.answers;
      if (!isPlainObject(rawAnswers)) {
        if (typeof cb === "function") cb({ ok: false, error: "Malformed answers payload." });
        return;
      }
      const mine = new Set(
        sess.assignments
          .filter((a) => a.authorIds.includes(player.id))
          .map((a) => String(a.promptIndex))
      );
      for (const key of mine) {
        const raw = rawAnswers?.[key];
        const text = typeof raw === "string" ? raw.slice(0, 50) : "";
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

    socket.on("report_bad_prompt", async (payload = {}, cb) => {
      if (!allowByRateLimit(socket, "report_bad_prompt", RATE_LIMITS.reportBadPrompt)) {
        if (typeof cb === "function") cb({ ok: false, error: "Too many reports. Try again soon." });
        return;
      }
      const found = findPlayerBySocket(socket.id);
      if (!found) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in a session." });
        return;
      }
      const { sess, player } = found;

      let idToReport = clampStringInput(payload.promptId, {
        minLen: 1,
        maxLen: 32,
        trim: true,
        pattern: /^[a-zA-Z0-9_-]+$/,
      }) || "";
      if (!idToReport) {
        const i = clampIntInput(payload.promptIndex, { min: 0, max: 10_000 });
        if (
          Number.isInteger(i) &&
          i >= 0 &&
          i < (sess.gamePrompts?.length || 0) &&
          sess.gamePrompts[i]?.id != null
        ) {
          idToReport = String(sess.gamePrompts[i].id);
        }
      }
      if (!idToReport) {
        if (typeof cb === "function") cb({ ok: false, error: "No prompt id to report." });
        return;
      }
      if (idToReport.startsWith("custom-")) {
        if (typeof cb === "function") {
          cb({ ok: false, error: "Custom prompts are not stored in the prompt database." });
        }
        return;
      }

      try {
        const result = await reportPrompt(idToReport, player.id);
        if (!result.ok) {
          if (typeof cb === "function") {
            const err =
              result.reason === "already_reported"
                ? "You already reported this prompt."
                : "Prompt not found.";
            cb({ ok: false, error: err });
          }
          return;
        }
        if (typeof cb === "function") {
          cb({
            ok: true,
            promptId: result.id,
            reportCount: result.reportCount,
            isDeleted: result.isDeleted,
          });
        }
      } catch (e) {
        if (typeof cb === "function") {
          cb({ ok: false, error: e.message || "Could not report prompt." });
        }
      }
    });

    socket.on("request_alternate_prompt", (payload = {}, cb) => {
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
      const i = clampIntInput(payload.promptIndex, { min: 0, max: 10_000 });
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

    socket.on("accept_alternate_prompt", (payload = {}, cb) => {
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
      const i = clampIntInput(payload.promptIndex, { min: 0, max: 10_000 });
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

    socket.on("reject_alternate_prompt", (payload = {}, cb) => {
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
      const i = clampIntInput(payload.promptIndex, { min: 0, max: 10_000 });
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

    socket.on("submit_photo", (payload = {}, cb) => {
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
      if (typeof payload.photoDataUrl !== "string") {
        if (typeof cb === "function") cb({ ok: false, error: "Malformed photo payload." });
        return;
      }
      const encoded = payload.photoDataUrl.trim();
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

    socket.on("submit_photo_caption", (payload = {}, cb) => {
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
      const text = typeof payload.caption === "string" ? payload.caption.slice(0, 160) : "";
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

    socket.on("submit_photo_rank_vote", (payload = {}, cb) => {
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
      const rank = payload.rank;
      const rankKey = rank === "first" || rank === "second" || rank === "third" ? rank : null;
      if (!rankKey) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid rank (use third, second, or first)." });
        return;
      }
      const choice = clampIntInput(payload.number, { min: 1, max: 10_000 });
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

    socket.on("vote", (payload = {}, cb) => {
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
      if (Number(sess.showdownVoteEndsAt || 0) > 0 && Date.now() > Number(sess.showdownVoteEndsAt)) {
        if (typeof cb === "function") cb({ ok: false, error: "Voting window has closed." });
        return;
      }
      const c = payload.choice === "B" ? "B" : "A";
      const qi = sess.currentQueueIndex;
      if (!sess.showdownVotes[qi]) sess.showdownVotes[qi] = {};
      sess.showdownVotes[qi][player.id] = c;
      if (typeof cb === "function") cb({ ok: true });

      const eligible = sess.players.map((p) => p.id).filter((id) => !authors.includes(id));
      const cast = Object.keys(sess.showdownVotes[qi] || {}).length;
      broadcastSession(sess);

      if (cast >= eligible.length) {
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
