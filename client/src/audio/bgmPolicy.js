const COUNTDOWN_TRACKS = [30, 60, 75, 90];

function nearestCountdown(seconds) {
  const target = Number(seconds);
  if (!Number.isFinite(target)) return 75;
  let nearest = COUNTDOWN_TRACKS[0];
  let minDistance = Math.abs(target - nearest);
  for (const option of COUNTDOWN_TRACKS.slice(1)) {
    const distance = Math.abs(target - option);
    if (distance < minDistance) {
      nearest = option;
      minDistance = distance;
    }
  }
  return nearest;
}

export function countdownTrackForSeconds(seconds) {
  return `countdown_${nearestCountdown(seconds)}_sec`;
}

export function getBgmTrackForSession(session) {
  const phase = session?.phase;
  if (!phase || phase === "gone") return null;

  if (phase === "lobby") return "lobby";

  if (phase === "answering") {
    const textRound = Number(session?.textRoundNumber ?? 1);
    if (textRound === 1 || textRound === 2) {
      return countdownTrackForSeconds(session?.answerTimeLimitSec);
    }
    return null;
  }

  if (phase === "showdown") {
    const textRound = Number(session?.showdown?.textRoundNumber ?? session?.textRoundNumber ?? 1);
    if (textRound === 1) return "round_1_voting";
    if (textRound === 2) return "round_2_voting";
  }

  if (phase === "round1_scores") {
    return "round_1_voting";
  }

  if (phase === "round2_text_splash") {
    return null;
  }

  if (phase === "round2_scores") {
    return "round_2_voting";
  }

  if (phase === "photo_round_splash") {
    return null;
  }

  if (phase === "photo_caption_transition") return "countdown_30_sec";

  if (phase === "photo_upload" || phase === "photo_captioning") {
    return countdownTrackForSeconds(session?.answerTimeLimitSec);
  }

  if (
    phase === "photo_vote_loading" ||
    phase === "photo_vote_carousel" ||
    phase === "photo_vote_preview" ||
    phase === "photo_voting"
  ) {
    return "round_3_voting";
  }

  if (
    phase === "photo_distribution_loading" ||
    phase === "photo_distribution" ||
    phase === "final_results_transition" ||
    phase === "play_again_transition" ||
    phase === "ended"
  ) {
    return "final_results";
  }

  return null;
}
