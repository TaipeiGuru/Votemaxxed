import {
  DEFAULT_ANSWER_TIME_SEC,
  SHOWDOWN_PASSES,
  showdownPointMultiplier,
} from "./constants.js";

const PROJECTOR_SENTINEL_ID = "__projector__";

export {
  PROJECTOR_SENTINEL_ID,
  isAllAnswersIn,
  getCurrentShowdown,
  getFoldedAuthorIds,
  tallyVotes,
  liveVoterRowsForShowdown,
};

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

export function sessionSnapshot(sess, forPlayerId) {
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
    id: p.id,
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

  if (
    sess.phase === "round1_scores" ||
    sess.phase === "round2_text_splash" ||
    sess.phase === "round2_scores" ||
    sess.phase === "photo_round_splash" ||
    sess.phase === "final_results_transition"
  ) {
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
            ? { photoDataUrl: pr.uploads?.[myAssignedUploaderId] || "" }
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
    const myVote = sess.showdownVotes[sess.currentQueueIndex]?.[forPlayerId] ?? null;
    const voteCounts = tallyVotes(sess, sd);
    const { votersForA, votersForB } = liveVoterRowsForShowdown(sess, sd);
    const lastResult =
      sess.lastShowdownResult &&
      (sess.lastShowdownResult.queueIndex < sess.currentQueueIndex || sess.showdownReviewActive)
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
          sess.bothFoldTimeline?.queueIndex === queueIndex ? sess.bothFoldTimeline.startsAt : null,
        bothFoldEndsAt:
          sess.bothFoldTimeline?.queueIndex === queueIndex ? sess.bothFoldTimeline.endsAt : null,
        bothFoldAuthorIds:
          sess.bothFoldTimeline?.queueIndex === queueIndex
            ? [...(sess.bothFoldTimeline.foldedAuthorIds || [])]
            : [],
        everyoneVoted:
          eligibleVoters.length === 0 ||
          Object.keys(sess.showdownVotes[queueIndex] || {}).length === eligibleVoters.length,
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

export function sessionSnapshotForProjector(sess) {
  const snap = sessionSnapshot(sess, PROJECTOR_SENTINEL_ID);
  return {
    ...snap,
    role: "projector",
    you: null,
    ...(sess.phase === "answering" && { answerProgress: computeAnswerProgress(sess) }),
  };
}
