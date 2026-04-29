export const PORT = Number(process.env.PORT) || 3001;
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

/** How many full passes over all prompts. */
export const SHOWDOWN_PASSES = 1;
export const ANSWER_TIME_OPTIONS_SEC = [60, 75, 90];
export const DEFAULT_ANSWER_TIME_SEC = 75;
export const ANSWER_TIMEUP_SUBMIT_GRACE_MS = 1200;

/** Time vote distribution stays on screen before advancing (after mog/chud when applicable). */
export const VOTE_DISTRIBUTION_REVIEW_MS = 7500;
/** Extra delay so overlays can finish before the distribution window counts in earnest. */
export const OVERLAY_BEFORE_REVIEW_MS = 3600;
/** Splash between vote distribution and the next prompt. */
export const NEXT_VOTE_SPLASH_MS = 3000;
export const BOTH_FOLD_OVERLAY_DELAY_MS = 1500;
export const BOTH_FOLD_OVERLAY_DURATION_MS = 9000;
export const SHOWDOWN_VOTING_DURATION_MS = 8000;
export const PHOTO_UPLOAD_TO_CAPTION_TRANSITION_MS = 2500;
export const PHOTO_CAPTION_TO_VOTE_LOADING_MS = 2500;
/** Max time photo-round rank voting stays open; early finish when all ballots are complete. */
export const PHOTO_VOTING_DURATION_MS = 30000;
export const PHOTO_DISTRIBUTION_REVIEW_MS = 7000;
/** How long each photo-caption pairing stays on projector during carousel reveal. */
export const PHOTO_DISTRIBUTION_CAROUSEL_PER_PAIRING_MS = 5000;
/** How long the all-pairings projector grid stays visible after carousel reveal. */
export const PHOTO_DISTRIBUTION_GRID_VISIBLE_MS = 5000;
/** Mid-game scoreboard duration (after text round 1 and after doubled text round 2). */
export const ROUND1_LEADERBOARD_MS = 10000;
/** Splash after round 1 leaderboard, before round 2 answering (double points). */
export const ROUND2_TEXT_SPLASH_MS = 3000;
/** Full-screen pause before photo uploads (after text rounds). */
export const PHOTO_ROUND_SPLASH_MS = 3000;
/** Splash before the end-game scoreboard (after photo round wrap-up). */
export const FINAL_RESULTS_TRANSITION_MS = 4000;
/** Pause on all clients after "Play again" before a new answering phase. */
export const PLAY_AGAIN_TRANSITION_MS = 3500;
export const PHOTO_VOTE_POINTS = {
  third: 60,
  second: 120,
  first: 180,
};
export const ROUND1_FORFEIT_WIN_POINTS = 50;
export const ROUND1_MOG_BONUS_POINTS = 50;
export const PHOTO_VOTE_STAGE_ORDER = ["third", "second", "first"];
export const MAX_PHOTO_DATA_URL_LEN = 6_000_000;
export const MAX_ACTIVE_SESSIONS = 500;
export const MAX_PLAYERS = 10;
export const HOST_ICON_KEY = "chess-queen";
export const PLAYER_ICON_KEYS = [
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

export const RATE_LIMITS = {
  createSession: { max: 5, windowMs: 60_000 },
  joinSession: { max: 20, windowMs: 60_000 },
  reportBadPrompt: { max: 6, windowMs: 60_000 },
};

export const DEFAULT_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
export const LARGER_EVENT_PAYLOAD_MAX_BYTES = 128 * 1024;
export const PHOTO_EVENT_PAYLOAD_MAX_BYTES = 7 * 1024 * 1024;
export const SOCKET_EVENT_PAYLOAD_LIMITS = {
  submit_photo: PHOTO_EVENT_PAYLOAD_MAX_BYTES,
  submit_answers: LARGER_EVENT_PAYLOAD_MAX_BYTES,
};

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

export function showdownPointMultiplier(sess) {
  return sess?.textRoundNumber === 2 ? 2 : 1;
}

export function pickChudTease() {
  return CHUD_TEASES[Math.floor(Math.random() * CHUD_TEASES.length)];
}
