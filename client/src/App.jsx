import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayerElement } from "./PlayerElement.jsx";
import { useSocket } from "./hooks/useSocket.js";
import { PhotoSquareCropModal } from "./components/modals/PhotoSquareCropModal.jsx";
import { ReportBadPromptModal } from "./components/modals/ReportBadPromptModal.jsx";
import {
  MogOverlay as MogOverlayMod,
  ChudOverlay as ChudOverlayMod,
  BothFoldOverlay as BothFoldOverlayMod,
  NextVoteSplash as NextVoteSplashMod,
} from "./components/overlays/Overlays.jsx";
import { ProjectorView as ProjectorViewMod } from "./components/projector/ProjectorView.jsx";
import { VoteDistribution as VoteDistributionMod } from "./components/vote/VoteDistribution.jsx";
import {
  disposeAudioEngine,
  playBgm,
  playSfx,
  preloadBgmTracks,
  preloadSfxTracks,
  setMasterEnabled,
  stopBgm,
} from "./audio/engine.js";
import { getBgmTrackForSession } from "./audio/bgmPolicy.js";

 

 
function ordinalRank(n) {
  const abs = Math.floor(Math.abs(Number(n)) || 0);
  const cent = abs % 100;
  if (cent >= 11 && cent <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

/** Competition-style rank: 1 + number of players with a strictly higher score (ties share a rank). */
function endgameStandingForPlayer(you, players, scores) {
  if (!you || !players?.length) return null;
  const myScore = Number(scores?.[you] ?? 0);
  const higher = players.filter((p) => Number(scores?.[p.id] ?? 0) > myScore).length;
  return { score: myScore, rank: higher + 1, total: players.length };
}

const BGM_FADE_MS = 1200;
const BGM_PRELOAD_TRACKS = [
  "lobby",
  "countdown_30_sec",
  "countdown_60_sec",
  "countdown_75_sec",
  "countdown_90_sec",
  "round_1_voting",
  "round_2_voting",
  "round_3_voting",
  "final_results",
];
const SFX_PRELOAD_TRACKS = ["mogged", "pop", "success", "drumroll", "kaching", "glitch", "thud"];

export default function App() {
  const socket = useSocket();
  const [name, setName] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [altPromptVisible, setAltPromptVisible] = useState({});
  const [altRejectWarning, setAltRejectWarning] = useState("");
  /** null | 'saving' | 'saved' */
  const [answersSaveStatus, setAnswersSaveStatus] = useState(null);
  const [mogPayload, setMogPayload] = useState(null);
  const [chudPayload, setChudPayload] = useState(null);
  const [bothFoldPayload, setBothFoldPayload] = useState(null);
  const [photoDataUrl, setPhotoDataUrl] = useState("");
  const [photoCropObjectUrl, setPhotoCropObjectUrl] = useState(null);
  const [photoSubmitPending, setPhotoSubmitPending] = useState(false);
  const [photoCaptionDraft, setPhotoCaptionDraft] = useState("");
  const [customPromptDraft, setCustomPromptDraft] = useState("");
  const [showCustomPromptInfo, setShowCustomPromptInfo] = useState(false);
  const [voteRevealVisible, setVoteRevealVisible] = useState(false);
  /** Prompt index key (`String(p.index)`) while report confirmation is open. */
  const [reportBadPromptKey, setReportBadPromptKey] = useState(null);
  const [endgameBusy, setEndgameBusy] = useState(false);
  const [answerTimeLeftMs, setAnswerTimeLeftMs] = useState(0);
  const pendingVoteRevealRef = useRef(null);
  const altRejectTimerRef = useRef(null);
  const latestSessionRef = useRef(null);
  const latestAnswersRef = useRef({});
  const answeringInitKeyRef = useRef(null);
  const bothFoldShownQueueRef = useRef(null);
  const bothFoldStartTimerRef = useRef(null);
  const prevLobbyPlayerCountRef = useRef(null);
  const prevReadyCountByPhaseRef = useRef({
    answering: null,
    photo_upload: null,
    photo_captioning: null,
  });
  const firedDrumrollKeyRef = useRef(null);
  const firedGlitchKeyRef = useRef(null);
  const prevShowdownVotesCastRef = useRef({ queueKey: null, votesCast: 0 });

  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!vv) return undefined;

    const syncViewportInsets = () => {
      const topOffset = Math.max(0, Number(vv.offsetTop) || 0);
      const rightInset = Math.max(
        0,
        (Number(window.innerWidth) || 0) - (Number(vv.width) || 0) - (Number(vv.offsetLeft) || 0)
      );
      root.style.setProperty("--vv-offset-top", `${topOffset}px`);
      root.style.setProperty("--vv-inset-right", `${rightInset}px`);
    };

    syncViewportInsets();
    vv.addEventListener("resize", syncViewportInsets);
    vv.addEventListener("scroll", syncViewportInsets);
    window.addEventListener("resize", syncViewportInsets);
    return () => {
      vv.removeEventListener("resize", syncViewportInsets);
      vv.removeEventListener("scroll", syncViewportInsets);
      window.removeEventListener("resize", syncViewportInsets);
      root.style.setProperty("--vv-offset-top", "0px");
      root.style.setProperty("--vv-inset-right", "0px");
    };
  }, []);

  useEffect(() => {
    function onState(s) {
      if (s.phase === "gone") {
        setSession(null);
        latestSessionRef.current = null;
        setError(s.message || "Session ended.");
        return;
      }
      setSession(s);
      latestSessionRef.current = s;
      if (s?.role !== "projector" && s?.code && s?.you) {
        const self = (s.players || []).find((p) => p.id === s.you);
        if (self?.name) setName((prev) => prev || self.name);
      }
      setError("");
    }
    function onMog(p) {
      setMogPayload(p);
    }
    function onChud(p) {
      setChudPayload(p);
    }
    function onAltRejected(payload) {
      const by = payload?.rejectedByName || "the other author";
      const key = String(payload?.promptIndex ?? "");
      if (key) {
        setAltPromptVisible((prev) => ({
          ...prev,
          [key]: false,
        }));
      }
      setAltRejectWarning(`Alternate prompt rejected by ${by}.`);
      if (altRejectTimerRef.current) clearTimeout(altRejectTimerRef.current);
      altRejectTimerRef.current = setTimeout(() => {
        setAltRejectWarning("");
        altRejectTimerRef.current = null;
      }, 3000);
    }
    function onAnswerTimeUp() {
      const s = latestSessionRef.current;
      if (!s || s.phase !== "answering") return;
      if (s.myAnswersSubmitted) return;
      setAnswersSaveStatus("saving");
      socket.emit("submit_answers", { answers: latestAnswersRef.current || {} }, (res) => {
        if (!res?.ok) {
          setAnswersSaveStatus(null);
          return;
        }
        setAnswersSaveStatus("saved");
      });
    }
    socket.on("session_state", onState);
    socket.on("unanimous_victory", onMog);
    socket.on("chud_overlay", onChud);
    socket.on("alternate_prompt_rejected", onAltRejected);
    socket.on("answer_time_up", onAnswerTimeUp);
    return () => {
      socket.off("session_state", onState);
      socket.off("unanimous_victory", onMog);
      socket.off("chud_overlay", onChud);
      socket.off("alternate_prompt_rejected", onAltRejected);
      socket.off("answer_time_up", onAnswerTimeUp);
      if (altRejectTimerRef.current) {
        clearTimeout(altRejectTimerRef.current);
        altRejectTimerRef.current = null;
      }
    };
  }, [socket]);

  useEffect(() => {
    preloadBgmTracks(BGM_PRELOAD_TRACKS);
    preloadSfxTracks(SFX_PRELOAD_TRACKS);
    return () => {
      disposeAudioEngine();
    };
  }, []);

  useEffect(() => {
    const projectorClient = session?.role === "projector";
    setMasterEnabled(projectorClient);
    if (!projectorClient) {
      stopBgm({ fadeMs: BGM_FADE_MS });
      return;
    }

    const track = getBgmTrackForSession(session);
    if (!track) {
      stopBgm({ fadeMs: BGM_FADE_MS });
      return;
    }
    playBgm(track, { fadeMs: BGM_FADE_MS, loop: true });
  }, [
    session?.role,
    session?.phase,
    session?.textRoundNumber,
    session?.answerTimeLimitSec,
    session?.showdown?.splashActive,
  ]);

  useEffect(() => {
    const projectorClient = session?.role === "projector";
    if (!projectorClient) {
      prevLobbyPlayerCountRef.current = null;
      return;
    }
    if (session?.phase !== "lobby") {
      prevLobbyPlayerCountRef.current = null;
      return;
    }
    const count = Number(session?.players?.length || 0);
    const prev = prevLobbyPlayerCountRef.current;
    prevLobbyPlayerCountRef.current = count;
    if (prev === null || !Number.isFinite(prev) || count <= prev) return;
    for (let i = 0; i < count - prev; i += 1) {
      setTimeout(() => playSfx("pop", { volume: 0.95 }), i * 120);
    }
  }, [session?.role, session?.phase, session?.players?.length]);

  useEffect(() => {
    const projectorClient = session?.role === "projector";
    const phase = session?.phase;
    if (!projectorClient || !phase) {
      prevReadyCountByPhaseRef.current = {
        answering: null,
        photo_upload: null,
        photo_captioning: null,
      };
      return;
    }

    if (phase === "answering") {
      const textRound = Number(session?.textRoundNumber ?? 1);
      if (textRound === 1 || textRound === 2) {
        const doneCount = Number(session?.answerProgress?.done?.length || 0);
        const prevCount = prevReadyCountByPhaseRef.current.answering;
        prevReadyCountByPhaseRef.current.answering = doneCount;
        if (prevCount !== null && doneCount > prevCount) {
          for (let i = 0; i < doneCount - prevCount; i += 1) {
            setTimeout(() => playSfx("success", { volume: 0.9 }), i * 90);
          }
        }
      } else {
        prevReadyCountByPhaseRef.current.answering = null;
      }
    } else {
      prevReadyCountByPhaseRef.current.answering = null;
    }

    if (phase === "photo_upload") {
      const doneCount = Number(session?.photoRound?.uploadProgress?.done?.length || 0);
      const prevCount = prevReadyCountByPhaseRef.current.photo_upload;
      prevReadyCountByPhaseRef.current.photo_upload = doneCount;
      if (prevCount !== null && doneCount > prevCount) {
        for (let i = 0; i < doneCount - prevCount; i += 1) {
          setTimeout(() => playSfx("success", { volume: 0.9 }), i * 90);
        }
      }
    } else {
      prevReadyCountByPhaseRef.current.photo_upload = null;
    }

    if (phase === "photo_captioning") {
      const doneCount = Number(session?.photoRound?.captionProgress?.done?.length || 0);
      const prevCount = prevReadyCountByPhaseRef.current.photo_captioning;
      prevReadyCountByPhaseRef.current.photo_captioning = doneCount;
      if (prevCount !== null && doneCount > prevCount) {
        for (let i = 0; i < doneCount - prevCount; i += 1) {
          setTimeout(() => playSfx("success", { volume: 0.9 }), i * 90);
        }
      }
    } else {
      prevReadyCountByPhaseRef.current.photo_captioning = null;
    }
  }, [
    session?.role,
    session?.phase,
    session?.textRoundNumber,
    session?.answerProgress?.done?.length,
    session?.photoRound?.uploadProgress?.done?.length,
    session?.photoRound?.captionProgress?.done?.length,
  ]);

  useEffect(() => {
    const projectorClient = session?.role === "projector";
    if (!projectorClient) {
      firedDrumrollKeyRef.current = null;
      return;
    }
    const phase = session?.phase;
    const splashActive = !!session?.showdown?.splashActive;
    let key = null;
    if (phase === "showdown" && splashActive) {
      key = `showdown:${String(session?.showdown?.queueIndex ?? "")}`;
    } else if (phase === "photo_vote_loading") {
      key = `photo_vote_loading:${String(session?.code ?? "")}`;
    }
    if (!key || firedDrumrollKeyRef.current === key) return;
    firedDrumrollKeyRef.current = key;
    playSfx("drumroll", { volume: 0.95 });
  }, [session?.role, session?.phase, session?.showdown?.splashActive, session?.showdown?.queueIndex, session?.code]);

  useEffect(() => {
    const projectorClient = session?.role === "projector";
    if (!projectorClient) {
      firedGlitchKeyRef.current = null;
      return;
    }
    const phase = session?.phase;
    if (phase !== "round2_text_splash" && phase !== "photo_round_splash") return;
    const key = `${phase}:${String(session?.code ?? "")}`;
    if (firedGlitchKeyRef.current === key) return;
    firedGlitchKeyRef.current = key;
    playSfx("glitch", { volume: 0.9 });
  }, [session?.role, session?.phase, session?.code]);

  useEffect(() => {
    const projectorClient = session?.role === "projector";
    const showdown = session?.showdown;
    if (!projectorClient || session?.phase !== "showdown" || !showdown) {
      prevShowdownVotesCastRef.current = { queueKey: null, votesCast: 0 };
      return;
    }

    const textRound = Number(showdown.textRoundNumber ?? 1);
    const validRound = textRound === 1 || textRound === 2;
    const activeVoting = !showdown.splashActive && !showdown.reviewActive;
    const queueKey = String(showdown.queueIndex ?? "");
    const votesCast = Math.max(0, Number(showdown.votesCast || 0));

    if (!validRound || !activeVoting || !queueKey) {
      prevShowdownVotesCastRef.current = { queueKey, votesCast };
      return;
    }

    const prev = prevShowdownVotesCastRef.current;
    const sameQueue = prev.queueKey === queueKey;
    const delta = sameQueue ? votesCast - prev.votesCast : 0;
    if (delta > 0) {
      for (let i = 0; i < delta; i += 1) {
        setTimeout(() => playSfx("pop", { volume: 0.95 }), i * 90);
      }
    }

    prevShowdownVotesCastRef.current = { queueKey, votesCast };
  }, [
    session?.role,
    session?.phase,
    session?.showdown?.queueIndex,
    session?.showdown?.votesCast,
    session?.showdown?.splashActive,
    session?.showdown?.reviewActive,
    session?.showdown?.textRoundNumber,
  ]);

  useEffect(() => {
    if (session?.phase !== "answering") setReportBadPromptKey(null);
  }, [session?.phase]);

  useEffect(() => {
    const lr = session?.lastResult;
    if (!lr?.voteBreakdown) {
      setVoteRevealVisible(false);
      pendingVoteRevealRef.current = null;
      return;
    }
    if (
      session?.phase === "ended" ||
      session?.phase === "round1_scores" ||
      session?.phase === "round2_text_splash" ||
      session?.phase === "round2_scores" ||
      session?.phase === "photo_round_splash" ||
      session?.phase === "final_results_transition" ||
      session?.phase === "play_again_transition"
    ) {
      setVoteRevealVisible(session?.phase === "ended");
      pendingVoteRevealRef.current = null;
      return;
    }
    if (lr.overlayPause) {
      setVoteRevealVisible(false);
      pendingVoteRevealRef.current = lr.queueIndex;
    } else {
      setVoteRevealVisible(true);
      pendingVoteRevealRef.current = null;
    }
  }, [
    session?.phase,
    session?.lastResult?.queueIndex,
    session?.lastResult?.overlayPause,
    session?.lastResult?.voteBreakdown,
  ]);

  useEffect(() => {
    if (mogPayload || chudPayload) return;
    const lr = session?.lastResult;
    if (
      session?.phase !== "showdown" ||
      !lr?.overlayPause ||
      pendingVoteRevealRef.current !== lr.queueIndex
    ) {
      return;
    }
    setVoteRevealVisible(true);
    pendingVoteRevealRef.current = null;
  }, [
    mogPayload,
    chudPayload,
    session?.phase,
    session?.lastResult?.queueIndex,
    session?.lastResult?.overlayPause,
  ]);

  useEffect(() => {
    if (session?.phase !== "showdown" || !session?.showdown) {
      if (bothFoldStartTimerRef.current) {
        clearTimeout(bothFoldStartTimerRef.current);
        bothFoldStartTimerRef.current = null;
      }
      setBothFoldPayload(null);
      bothFoldShownQueueRef.current = null;
      return;
    }

    const sd = session.showdown;
    const queueKey = String(sd.queueIndex ?? "");
    const foldedAuthorIds = sd.bothFoldAuthorIds ?? sd.foldedAuthorIds ?? [];

    if (!foldedAuthorIds.length || !queueKey || bothFoldShownQueueRef.current === queueKey) return;

    const players = session.players ?? [];
    const plA = players.find((p) => p.id === sd.authorA);
    const plB = players.find((p) => p.id === sd.authorB);
    const authorAName = plA?.name ?? "Player A";
    const authorBName = plB?.name ?? "Player B";

    bothFoldShownQueueRef.current = queueKey;
    bothFoldStartTimerRef.current = setTimeout(() => {
      setBothFoldPayload({
        queueIndex: queueKey,
        players: [
          { id: sd.authorA, name: authorAName, iconKey: plA?.iconKey },
          { id: sd.authorB, name: authorBName, iconKey: plB?.iconKey },
        ],
        foldedAuthorIds,
        startsAt: Number(sd.bothFoldStartsAt || Date.now() + 1500),
        endsAt: Number(sd.bothFoldEndsAt || Date.now() + 10500) - 2000,
      });
      bothFoldStartTimerRef.current = null;
    }, Math.max(0, Number(sd.bothFoldStartsAt || (Date.now() + 1500)) - Date.now()));

    return () => {
      if (bothFoldStartTimerRef.current) {
        clearTimeout(bothFoldStartTimerRef.current);
        bothFoldStartTimerRef.current = null;
      }
    };
  }, [
    session?.phase,
    session?.showdown,
    session?.showdown?.queueIndex,
    session?.showdown?.foldedAuthorIds,
    session?.showdown?.bothFoldAuthorIds,
    session?.showdown?.bothFoldStartsAt,
    session?.showdown?.bothFoldEndsAt,
    session?.showdown?.authorA,
    session?.showdown?.authorB,
    session?.players,
  ]);

  const createSession = useCallback(() => {
    setError("");
    socket.emit("create_session", { hostName: name || "Host" }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "Could not create session.");
        return;
      }
    });
  }, [socket, name]);

  const joinSession = useCallback(() => {
    setError("");
    socket.emit(
      "join_session",
      { code: codeInput.trim(), name: name || "Player" },
      (res) => {
        if (!res?.ok) {
          setError(res?.error || "Could not join.");
          return;
        }
      }
    );
  }, [socket, codeInput, name]);

  const joinAsProjector = useCallback(() => {
    setError("");
    socket.emit("join_projector", { code: codeInput.trim() }, (res) => {
      if (!res?.ok) setError(res?.error || "Could not open projector mode.");
    });
  }, [socket, codeInput]);

  const startGame = useCallback(() => {
    setError("");
    socket.emit("start_game", {}, (res) => {
      if (!res?.ok) setError(res?.error || "Could not start.");
    });
  }, [socket]);

  const playAgain = useCallback(() => {
    setError("");
    setEndgameBusy(true);
    socket.emit("play_again", {}, (res) => {
      setEndgameBusy(false);
      if (!res?.ok) setError(res?.error || "Could not play again.");
    });
  }, [socket]);

  const newGameFromEnd = useCallback(() => {
    setError("");
    setEndgameBusy(true);
    socket.emit("new_game", {}, (res) => {
      setEndgameBusy(false);
      if (!res?.ok) setError(res?.error || "Could not start a new game.");
    });
  }, [socket]);

  const setAnswerTimeLimit = useCallback(
    (seconds) => {
      setError("");
      socket.emit("set_answer_time_limit", { seconds }, (res) => {
        if (!res?.ok) setError(res?.error || "Could not update answer timer.");
      });
    },
    [socket]
  );

  const addCustomPrompt = useCallback(() => {
    setError("");
    socket.emit("add_custom_prompt", { text: customPromptDraft }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "Could not add prompt.");
        return;
      }
      setCustomPromptDraft("");
    });
  }, [socket, customPromptDraft]);

  const removeCustomPrompt = useCallback((index) => {
    setError("");
    socket.emit("remove_custom_prompt", { index }, (res) => {
      if (!res?.ok) setError(res?.error || "Could not remove prompt.");
    });
  }, [socket]);

  const submitAnswers = useCallback(() => {
    setAnswersSaveStatus("saving");
    socket.emit("submit_answers", { answers }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "Submit failed.");
        setAnswersSaveStatus(null);
        return;
      }
      setAnswersSaveStatus("saved");
    });
  }, [socket, answers]);

  const requestAlternatePrompt = useCallback(
    (promptIndex) => {
      setError("");
      socket.emit("request_alternate_prompt", { promptIndex }, (res) => {
        if (!res?.ok) setError(res?.error || "Could not request alternate prompt.");
      });
    },
    [socket]
  );

  const acceptAlternatePrompt = useCallback(
    (promptIndex) => {
      setError("");
      socket.emit("accept_alternate_prompt", { promptIndex }, (res) => {
        if (!res?.ok) setError(res?.error || "Could not accept alternate prompt.");
      });
    },
    [socket]
  );

  const rejectAlternatePrompt = useCallback(
    (promptIndex) => {
      setError("");
      socket.emit("reject_alternate_prompt", { promptIndex }, (res) => {
        if (!res?.ok) setError(res?.error || "Could not reject alternate prompt.");
      });
    },
    [socket]
  );

  const vote = useCallback(
    (choice) => {
      setError("");
      socket.emit("vote", { choice }, (res) => {
        if (!res?.ok) {
          setError(res?.error || "Vote failed.");
        }
      });
    },
    [socket]
  );

  const submitPhotoCaption = useCallback(() => {
    setError("");
    socket.emit("submit_photo_caption", { caption: photoCaptionDraft }, (res) => {
      if (!res?.ok) setError(res?.error || "Caption submit failed.");
    });
  }, [socket, photoCaptionDraft]);

  const submitPhotoRankVote = useCallback(
    (rank, number) => {
      setError("");
      socket.emit("submit_photo_rank_vote", { rank, number }, (res) => {
        if (!res?.ok) setError(res?.error || "Rank vote failed.");
      });
    },
    [socket]
  );

  const myPrompts = session?.myPrompts ?? [];
  const isHost = session?.you && session?.hostPlayerId === session?.you;

  useEffect(() => {
    if (session?.phase !== "answering") {
      answeringInitKeyRef.current = null;
      return;
    }
    const promptKey = myPrompts.map((p) => String(p.index)).join("|");
    const answeringKey = `${session?.code ?? ""}:${session?.answeringEndsAt ?? ""}:${promptKey}`;
    if (answeringInitKeyRef.current === answeringKey) return;
    answeringInitKeyRef.current = answeringKey;
    const emptyAnswers = {};
    for (const p of myPrompts) {
      emptyAnswers[String(p.index)] = "";
    }
    setAnswers(emptyAnswers);
  }, [session?.phase, session?.code, session?.answeringEndsAt, myPrompts]);

  useEffect(() => {
    latestAnswersRef.current = answers;
  }, [answers]);

  useEffect(() => {
    if (session?.phase !== "answering") setAnswersSaveStatus(null);
  }, [session?.phase]);

  useEffect(() => {
    const timedPhaseEndsAt =
      session?.phase === "answering"
        ? session?.answeringEndsAt
        : session?.phase === "photo_upload"
        ? session?.photoRound?.uploadEndsAt
        : session?.phase === "photo_captioning"
        ? session?.photoRound?.captionEndsAt
        : session?.phase === "photo_voting"
        ? session?.photoRound?.voteEndsAt
        : session?.phase === "play_again_transition"
        ? session?.playAgainEndsAt
        : null;
    if (!timedPhaseEndsAt) {
      setAnswerTimeLeftMs(0);
      return;
    }
    const tick = () => {
      setAnswerTimeLeftMs(Math.max(0, timedPhaseEndsAt - Date.now()));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [
    session?.phase,
    session?.answeringEndsAt,
    session?.photoRound?.uploadEndsAt,
    session?.photoRound?.captionEndsAt,
    session?.photoRound?.voteEndsAt,
    session?.playAgainEndsAt,
  ]);

  useEffect(() => {
    if (session?.phase === "lobby" && session?.code && session?.role !== "projector") {
      setCodeInput(session.code);
    }
  }, [session?.phase, session?.code, session?.role]);

  useEffect(() => {
    if (session?.phase !== "answering") {
      setAltPromptVisible({});
      setAltRejectWarning("");
      if (altRejectTimerRef.current) {
        clearTimeout(altRejectTimerRef.current);
        altRejectTimerRef.current = null;
      }
    }
  }, [session?.phase]);

  useEffect(() => {
    if (session?.phase !== "lobby") setCustomPromptDraft("");
  }, [session?.phase]);

  useEffect(() => {
    if (session?.phase === "photo_upload") {
      setPhotoDataUrl(session?.photoRound?.myPhotoDataUrl || "");
      return;
    }
    setPhotoDataUrl("");
  }, [session?.phase, session?.photoRound?.myPhotoDataUrl]);

  useEffect(() => {
    if (session?.phase === "photo_upload") return;
    setPhotoCropObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [session?.phase]);

  const closePhotoCropper = useCallback(() => {
    setPhotoSubmitPending(false);
    setPhotoCropObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    if (session?.phase === "photo_captioning") {
      setPhotoCaptionDraft(session?.photoRound?.myCaptionText || "");
      return;
    }
    setPhotoCaptionDraft("");
  }, [session?.phase, session?.photoRound?.myCaptionText]);

  const lobby = session?.phase === "lobby";
  const answering = session?.phase === "answering";
  const answerPhaseTextRound = Number(session?.textRoundNumber ?? 1);
  const showReportBadPromptButton =
    answering && (answerPhaseTextRound === 1 || answerPhaseTextRound === 2);
  const showdown = session?.phase === "showdown";
  const photoUpload = session?.phase === "photo_upload";
  const photoCaptionTransition = session?.phase === "photo_caption_transition";
  const photoCaptioning = session?.phase === "photo_captioning";
  const photoVoteLoading = session?.phase === "photo_vote_loading";
  const photoVoteCarousel = session?.phase === "photo_vote_carousel";
  const photoVotePreview = session?.phase === "photo_vote_preview";
  const photoVoting = session?.phase === "photo_voting";
  const photoDistributionLoading = session?.phase === "photo_distribution_loading";
  const photoDistribution = session?.phase === "photo_distribution";
  const finalResultsTransition = session?.phase === "final_results_transition";
  const playAgainTransition = session?.phase === "play_again_transition";
  const round1Scores = session?.phase === "round1_scores";
  const round2TextSplash = session?.phase === "round2_text_splash";
  const round2Scores = session?.phase === "round2_scores";
  const photoRoundSplash = session?.phase === "photo_round_splash";
  const ended = session?.phase === "ended";
  const knownPlayerPhase =
    lobby ||
    answering ||
    showdown ||
    photoUpload ||
    photoCaptionTransition ||
    photoCaptioning ||
    photoVoteLoading ||
    photoVoteCarousel ||
    photoVotePreview ||
    photoVoting ||
    photoDistributionLoading ||
    photoDistribution ||
    finalResultsTransition ||
    playAgainTransition ||
    round1Scores ||
    round2TextSplash ||
    round2Scores ||
    photoRoundSplash ||
    ended;

  const canVote = useMemo(() => {
    if (!showdown || !session?.showdown) return false;
    const d = session.showdown;
    const eligible = d.eligibleVoters || [];
    return (
      eligible.includes(session.you) &&
      !d.myVote &&
      !d.reviewActive &&
      !d.splashActive &&
      !(d.foldedAuthorIds?.length > 0)
    );
  }, [showdown, session]);

  const displayCode = session?.code;
  const isProjector = session?.role === "projector";
  const endgamePlayerStanding =
    session && !isProjector && ended
      ? endgameStandingForPlayer(session.you, session.players, session.scores)
      : null;
  const playerCount = session?.players?.length ?? 0;
  const canStartGame = playerCount >= 3 && playerCount <= 10;
  const projectorVoteFit =
    isProjector &&
    (photoVoteCarousel || photoVotePreview || photoVoting || photoDistribution);

  const showVoteDistribution =
    session?.lastResult?.voteBreakdown &&
    session?.phase !== "round1_scores" &&
    session?.phase !== "round2_text_splash" &&
    session?.phase !== "round2_scores" &&
    session?.phase !== "photo_round_splash" &&
    session?.phase !== "final_results_transition" &&
    session?.phase !== "play_again_transition" &&
    (session?.phase === "ended" || voteRevealVisible);

  /** Text vote breakdown on handsets: not during round 1 showdown, and not on the game-over screen. */
  const showPlayerTextVoteBreakdown =
    showVoteDistribution &&
    session?.phase !== "showdown" &&
    session?.phase !== "ended";
  const skipShowdownVotingScreen =
    session?.phase === "showdown" &&
    !!session?.showdown &&
    !session?.showdown?.splashActive &&
    (session?.showdown?.foldedAuthorIds?.length > 0 || session?.showdown?.bothFolded);

  const finalShowdownIndex = Number(session?.showdown?.totalShowdowns) - 1;
  const currentShowdownIndex = Number(session?.showdown?.queueIndex);
  const completedShowdownIndex = Number(session?.lastResult?.queueIndex);
  const isFinalShowdownSplash =
    session?.phase === "showdown" &&
    !!session?.showdown?.splashActive &&
    Number.isFinite(finalShowdownIndex) &&
    (currentShowdownIndex >= finalShowdownIndex ||
      completedShowdownIndex >= finalShowdownIndex);
  const nextVoteSplashText = isFinalShowdownSplash
    ? "Let's see the answermaxxer leaderboard..."
    : "Get ready to vote...";
  const answerTimeLimitSec = session?.answerTimeLimitSec ?? 75;
  const answerTimeRemainingSec = Math.ceil(answerTimeLeftMs / 1000);
  const photoRound = session?.photoRound ?? null;
  const showPlayerFloatingTimer =
    !isProjector &&
    ((answering && (answerPhaseTextRound === 1 || answerPhaseTextRound === 2)) ||
      photoUpload ||
      photoCaptioning);
  const onPhotoFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoCropObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    e.target.value = "";
  }, []);

  return (
    <div
      className={`layout${isProjector ? " layout--projector" : ""}${
        projectorVoteFit ? " layout--projector-vote-fit" : ""
      }`}
    >
      {!isProjector && (
        <header style={{ marginBottom: "1.75rem" }}>
          <div className="header-brand-row" style={{ marginBottom: "0.35rem" }}>
            <img
              src="/images/white_logo.png"
              alt=""
              className="header-brand-logo header-brand-logo--player"
              width={40}
              height={40}
            />
            <h1
              style={{
                margin: 0,
                fontSize: "2.35rem",
                letterSpacing: "-0.02em",
              }}
            >
              Votemaxxed
            </h1>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: "0.95rem" }}>
            Are you a true votemaxxer? Use your creativity to avoid getting answermogged.
          </p>
        </header>
      )}

      {mogPayload && (
        <MogOverlayMod
          payload={mogPayload}
          onDone={() => setMogPayload(null)}
          playSound={isProjector}
          players={session?.players ?? []}
        />
      )}
      {chudPayload && (
        <ChudOverlayMod
          payload={chudPayload}
          onDone={() => setChudPayload(null)}
        />
      )}
      {isProjector && bothFoldPayload && (
        <BothFoldOverlayMod
          payload={bothFoldPayload}
          onDone={() => setBothFoldPayload(null)}
        />
      )}
      <NextVoteSplashMod
        active={!!session?.showdown?.splashActive || skipShowdownVotingScreen}
        text={nextVoteSplashText}
      />
      <NextVoteSplashMod
        active={session?.phase === "photo_round_splash"}
        text="Round 3"
      />

      {photoCropObjectUrl && (
        <PhotoSquareCropModal
          imageSrc={photoCropObjectUrl}
          onCancel={closePhotoCropper}
          submitting={photoSubmitPending}
          onConfirm={(dataUrl) => {
            setError("");
            setPhotoDataUrl(dataUrl);
            setPhotoSubmitPending(true);
            socket.emit("submit_photo", { photoDataUrl: dataUrl }, (res) => {
              setPhotoSubmitPending(false);
              if (!res?.ok) {
                setError(res?.error || "Photo submit failed.");
                return;
              }
              closePhotoCropper();
            });
          }}
        />
      )}

      {reportBadPromptKey !== null && (
        <ReportBadPromptModal
          onClose={() => setReportBadPromptKey(null)}
          onConfirm={() => {
            const promptIndex = Number(reportBadPromptKey);
            if (!Number.isFinite(promptIndex)) return;
            setError("");
            socket.emit("report_bad_prompt", { promptIndex }, (res) => {
              if (!res?.ok) {
                setError(res?.error || "Could not report prompt.");
              }
            });
          }}
        />
      )}

      {error && (
        <div
          className="card"
          style={{
            borderColor: "var(--danger)",
            marginBottom: "1rem",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      {session && showPlayerFloatingTimer && (
        <div
          className={
            answerTimeRemainingSec <= 10
              ? "player-answering-timer player-answering-timer--danger"
              : "player-answering-timer"
          }
          role="status"
          aria-live="polite"
        >
          Time left: {answerTimeRemainingSec}s
        </div>
      )}

      {!session && (
        <div className="card">
          <label htmlFor="name">Display name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={24}
          />
          <div
            style={{
              display: "grid",
              gap: "1rem",
              marginTop: "1.25rem",
            }}
          >
            <div>
              <button
                type="button"
                onClick={createSession}
                disabled={!name.trim()}
                style={{
                  background: "linear-gradient(135deg, var(--accent), #c9a22e)",
                  color: "#1a1408",
                  width: "100%",
                }}
              >
                Create session
              </button>
            </div>
            <div>
              <label htmlFor="code">Join code</label>
              <input
                id="code"
                value={codeInput}
                onChange={(e) =>
                  setCodeInput(
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, "")
                      .slice(0, 6)
                  )
                }
                placeholder="ABCDEF"
                maxLength={6}
                style={{ textTransform: "uppercase", letterSpacing: "0.2em" }}
              />
              <button
                type="button"
                onClick={joinSession}
                disabled={
                  codeInput.trim().length !== 6 || !name.trim()
                }
                style={{
                  marginTop: "0.75rem",
                  width: "100%",
                  background: "var(--surface)",
                  color: "var(--text)",
                  border: "1px solid #DDD",
                }}
              >
                Join session
              </button>
              <div
                style={{
                  marginTop: "0.5rem",
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0.5rem",
                  alignItems: "center",
                }}
              >
                <button
                  type="button"
                  onClick={joinAsProjector}
                  style={{
                    width: "100%",
                    background: "transparent",
                    color: "var(--accent)",
                    border: "1px solid var(--accent-dim)",
                  }}
                >
                  Project
                </button>
                <button
                  type="button"
                  onClick={() => setShowProjectInfo((v) => !v)}
                  aria-label="Project mode info"
                  title="Project mode info"
                  style={{
                    width: "2.25rem",
                    height: "2.25rem",
                    padding: 0,
                    borderRadius: "999px",
                    fontSize: "1rem",
                    fontWeight: 700,
                    background: "transparent",
                    border: "1px solid var(--border)",
                    color: "var(--muted)",
                    lineHeight: 1,
                  }}
                >
                  ?
                </button>
              </div>
              {showProjectInfo && (
                <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}>
                  Provide a code to project an existing session, or leave it blank to project an empty session.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {isProjector && session && (
        <ProjectorViewMod
          session={session}
          showVoteDistribution={showVoteDistribution}
          answerTimeRemainingSec={answerTimeRemainingSec}
          answerTimeLimitSec={answerTimeLimitSec}
          onCarouselPairingIndexChange={(idx) => {
            if (session?.role !== "projector") return;
            if (!Number.isFinite(Number(idx))) return;
            playSfx("thud", { volume: 0.9 });
          }}
        />
      )}

      {session && !isProjector && lobby && (
        <div className="card">
          <p className="muted" style={{ margin: "0 0 0.5rem" }}>
            Game code
          </p>
          <p
            style={{
              fontSize: "2rem",
              letterSpacing: "0.25em",
              fontWeight: 700,
              margin: "0 0 1rem",
            }}
          >
            {displayCode}
          </p>
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Players ({session.players?.length ?? 0})
          </p>
          <ul style={{ margin: "0 0 1rem", paddingLeft: 0, listStyle: "none" }}>
            {session.players?.map((p) => (
              <li key={p.id} style={{ marginBottom: "0.5rem" }}>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.35rem" }}>
                  <PlayerElement
                    name={p.name}
                    iconKey={p.iconKey}
                    playerId={p.id}
                    hostPlayerId={session.hostPlayerId}
                    variant="compact"
                  />
                </div>
              </li>
            ))}
          </ul>

          {(session.customPrompts?.length > 0 || isHost) && (
            <div
              style={{
                marginBottom: "1.25rem",
                paddingTop: "1rem",
                borderTop: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.35rem",
                }}
              >
                <h2 style={{ fontSize: "1.15rem", margin: 0 }}>
                  Custom prompts
                </h2>
                <button
                  type="button"
                  onClick={() => setShowCustomPromptInfo((v) => !v)}
                  aria-label="Custom prompts info"
                  title="Custom prompts info"
                  style={{
                    width: "1.7rem",
                    height: "1.7rem",
                    padding: 0,
                    borderRadius: "999px",
                    fontSize: "0.9rem",
                    fontWeight: 700,
                    background: "transparent",
                    border: "1px solid var(--border)",
                    color: "var(--muted)",
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ?
                </button>
              </div>
              {showCustomPromptInfo && (
                <p className="muted" style={{ margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
                  These are guaranteed to appear (up to one per player).
                </p>
              )}
              {session.customPrompts?.length > 0 ? (
                <ul
                  style={{
                    margin: "0 0 0.75rem",
                    paddingLeft: "1.2rem",
                    listStyle: "disc",
                  }}
                >
                  {session.customPrompts.map((t, i) => (
                    <li
                      key={`${i}-${t.slice(0, 24)}`}
                      style={{
                        marginBottom: "0.35rem",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "0.5rem",
                      }}
                    >
                      <span style={{ flex: 1 }}>{t}</span>
                      {isHost && (
                        <button
                          type="button"
                          onClick={() => removeCustomPrompt(i)}
                          style={{
                            flexShrink: 0,
                            padding: "0.25rem 0.5rem",
                            fontSize: "0.8rem",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            color: "var(--muted)",
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                isHost && (
                  <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.75rem" }}>
                    None yet — add optional prompts below.
                  </p>
                )
              )}
              {isHost &&
                (session.customPrompts?.length ?? 0) <
                  (session.maxCustomPrompts ?? 0) && (
                  <div>
                    <textarea
                      id="custom-prompt"
                      value={customPromptDraft}
                      onChange={(e) => setCustomPromptDraft(e.target.value)}
                      placeholder="Type a prompt…"
                      maxLength={500}
                      rows={3}
                      style={{ marginBottom: "0.5rem" }}
                    />
                    <button
                      type="button"
                      onClick={addCustomPrompt}
                      disabled={!customPromptDraft.trim()}
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    >
                      Add prompt
                    </button>
                  </div>
                )}
              {isHost &&
                (session.customPrompts?.length ?? 0) >=
                  (session.maxCustomPrompts ?? 0) &&
                (session.maxCustomPrompts ?? 0) > 0 && (
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
                    Custom list full — remove one to add another, or wait for more
                    players.
                  </p>
                )}
            </div>
          )}

          {isHost && (
            <div style={{ marginBottom: "1rem" }}>
              <h2 style={{ fontSize: "1.15rem", marginBottom: "0.35rem" }}>
                Answer timer
              </h2>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {[60, 75, 90].map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    onClick={() => setAnswerTimeLimit(seconds)}
                    style={{
                      padding: "0.45rem 0.8rem",
                      background:
                        answerTimeLimitSec === seconds
                          ? "#fff"
                          : "var(--surface)",
                      color: answerTimeLimitSec === seconds ? "#1a1408" : "var(--text)",
                      border: "1px solid #fff"
                    }}
                  >
                    {seconds}s
                  </button>
             
                ))}
              </div>
            </div>
          )}

          {isHost ? (
            <button
              type="button"
              onClick={startGame}
              disabled={!canStartGame}
              style={{
                background: "linear-gradient(135deg, var(--accent), #c9a22e)",
                color: "#1a1408",
              }}
            >
              Start game
            </button>
          ) : (
            <p className="muted">Waiting for the host to start…</p>
          )}
          <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
            3-10 players required to play.
          </p>
        </div>
      )}

      {session && !isProjector && answering && (
        <div className="card">
          <h2>Write your answers</h2>
          {altRejectWarning && (
            <p
              role="status"
              aria-live="assertive"
              style={{
                marginTop: "1rem",
                color: "var(--danger)",
                fontWeight: 700,
              }}
            >
              {altRejectWarning}
            </p>
          )}
          {myPrompts.map((p) => {
            const key = String(p.index);
            const st = session?.promptAlt?.[key] || {};
            const requestedBy = st.requestedBy || [];
            const otherAuthor = (p.authorIds || []).find((id) => id !== session?.you) || null;
            const otherRequested = otherAuthor ? requestedBy.includes(otherAuthor) : false;
            const youRequested = requestedBy.includes(session?.you);
            const incomingRequest =
              otherRequested && !youRequested && !st.swapped && !st.locked;
            const showAlt = !!altPromptVisible[key] || incomingRequest;
            const canRequest = !st.swapped && !st.locked && !youRequested && !!st.altText;
            const rejectedByOther = !!(st.locked && st.rejectedBy && st.rejectedBy !== session?.you);
            return (
            <div
              key={p.index}
              style={{
                marginTop: "1.25rem",
                padding: incomingRequest ? "0.75rem" : 0,
                border: incomingRequest ? "1px solid var(--accent)" : "none",
                borderRadius: incomingRequest ? "var(--radius)" : 0,
                background: incomingRequest ? "rgba(232, 197, 71, 0.08)" : "transparent",
              }}
            >
              <p style={{ margin: "0 0 0.35rem" }}>{p.text}</p>
              {st.swapped && (
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.74em", fontStyle: "italic" }}>
                  Alternate prompt used.
                </p>
           
              )}
              {!st.swapped && st.locked && (
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.74em", fontStyle: "italic" }}>
                  {rejectedByOther
                    ? "Alternate request rejected."
                    : "Alternate prompt locked."}
                </p>
              )}
              {!st.swapped && !st.locked && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={() =>
                      setAltPromptVisible((prev) => ({
                        ...prev,
                        [key]: !prev[key],
                      }))
                    }
                    style={{
                      padding: "0.4rem 0.7rem",
                      fontSize: "0.85rem",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      color: "var(--muted)",
                    }}
                  >
                    {showAlt ? "Hide alternate prompt" : "Show alternate prompt"}
                  </button>
                  {showReportBadPromptButton ? (
                    <button
                      type="button"
                      className="report-bad-prompt-toolbar-btn"
                      onClick={() => setReportBadPromptKey(key)}
                    >
                      Report bad prompt
                    </button>
                  ) : null}
                  {incomingRequest ? (
                    <>
                      <button
                        type="button"
                        onClick={() => acceptAlternatePrompt(p.index)}
                        style={{
                          padding: "0.4rem 0.7rem",
                          fontSize: "0.85rem",
                          background: "var(--surface)",
                          border: "1px solid var(--ok)",
                          color: "var(--ok)",
                        }}
                      >
                        Accept swap
                      </button>
                      <button
                        type="button"
                        onClick={() => rejectAlternatePrompt(p.index)}
                        style={{
                          padding: "0.4rem 0.7rem",
                          fontSize: "0.85rem",
                          background: "var(--surface)",
                          border: "1px solid var(--danger)",
                          color: "var(--danger)",
                        }}
                      >
                        Reject swap
                      </button>
                    </>
                  ) : (
                    showAlt && (
                      <button
                        type="button"
                        onClick={() => requestAlternatePrompt(p.index)}
                        disabled={!canRequest}
                        style={{
                          padding: "0.4rem 0.7rem",
                          fontSize: "0.85rem",
                          background: "var(--surface)",
                          border: "1px solid var(--accent-dim)",
                          color: "var(--accent)",
                        }}
                      >
                        Request alternate prompt
                      </button>
                    )
                  )}
                </div>
              )}
              {showAlt && !st.swapped && (
                <div
                  style={{
                    marginTop: "0.75rem",
                    padding: "0.75rem",
                    borderRadius: "var(--radius)",
                    border: incomingRequest ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: incomingRequest
                      ? "rgba(232, 197, 71, 0.08)"
                      : "rgba(139, 149, 168, 0.06)",
                  }}
                >
                  {/*<p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.82rem" }}>
                    {incomingRequest
                      ? "The other author requested this swap. Accept or reject below."
                      : youRequested
                      ? "You requested this. Waiting on the other author."
                      : "You have not requested this yet."}
                  </p>*/}
                  <p style={{ margin: 0 }}>
                    {st.altText || "—"}
                  </p>
                  <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.82rem", fontStyle: "italic" }}>
                    Alternate prompt
                  </p>
             
                </div>
              )}
              <input
                id={`a-${p.index}`}
                type="text"
                value={answers[String(p.index)] ?? ""}
                style={{ marginTop: "0.9rem" }}
                onChange={(e) => {
                  const nextText = e.target.value;
                  setAnswersSaveStatus(null);
                  setAnswers((prev) => ({
                    ...prev,
                    [String(p.index)]: nextText,
                  }));
                }}
                maxLength={50}
                autoComplete="off"
              />
            </div>
          )})}
          <div
            style={{
              marginTop: "1.25rem",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <button
              type="button"
              onClick={submitAnswers}
              disabled={answersSaveStatus === "saving"}
              style={{
                background: "linear-gradient(135deg, var(--accent), #c9a22e)",
                color: "#1a1408",
              }}
            >
              {answersSaveStatus === "saving" ? "Saving…" : "Save answers"}
            </button>
            {answersSaveStatus === "saved" && (
              <span
                className="save-confirmation"
                role="status"
                aria-live="polite"
              >
                Saved
              </span>
            )}
          </div>
          {session.allAnswersIn && (
            <p className="muted" style={{ marginTop: "1rem" }}>
              All answers are in — moving to showdown…
            </p>
          )}
        </div>
      )}

      {session && !isProjector && round2TextSplash && (
        <div className="card">
          <h2>Round 2 - double points!</h2>
        </div>
      )}

      {session && !isProjector && photoRoundSplash && (
        <div className="card">
          <h2>Round 3</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Photo uploads are about to open…
          </p>
        </div>
      )}

      {session && !isProjector && photoUpload && (
        <div className="card">
          <h2>Choose a funny photo</h2>
          <input
            id="photo-upload"
            className="photo-upload-sr-only"
            type="file"
            accept="image/*"
            onChange={onPhotoFileChange}
          />
          <label htmlFor="photo-upload" className="photo-upload-file-label">
            Pick image
          </label>
          {photoDataUrl && (
            <img
              src={photoDataUrl}
              alt="Your selected upload"
              className="photo-upload-preview"
            />
          )}
          {photoRound?.myPhotoSubmitted && (
            <p className="muted" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
              Uploaded
            </p>
          )}
        </div>
      )}

      {session && !isProjector && photoCaptionTransition && (
        <div className="card">
          <h2>Get ready to caption…</h2>
        </div>
      )}

      {session && !isProjector && photoCaptioning && (
        <div className="card">
          <h2>Give a funny caption</h2>
          {photoRound?.myAssignedPhoto?.photoDataUrl ? (
            <img
              src={photoRound.myAssignedPhoto.photoDataUrl}
              alt="Assigned photo"
              style={{ width: "100%", marginTop: "0.5rem", borderRadius: "12px" }}
            />
          ) : (
            <p className="muted">Assigned photo unavailable.</p>
          )}
          <input
            type="text"
            value={photoCaptionDraft}
            onChange={(e) => setPhotoCaptionDraft(e.target.value)}
            maxLength={160}
            style={{ marginTop: "0.9rem" }}
          />
          <button
            type="button"
            onClick={submitPhotoCaption}
            disabled={!!photoRound?.myCaptionSubmitted}
            style={{ marginTop: "0.9rem" }}
          >
            {photoRound?.myCaptionSubmitted ? "Submitted" : "Submit caption"}
          </button>
        </div>
      )}

      {session && !isProjector && photoVoteLoading && (
        <div className="card">
          <h2>Get ready to vote...</h2>
        </div>
      )}

      {session && !isProjector && photoVoting && (
        <div className="card photo-rank-vote-card">
          <h2>Rank the submissions</h2>
          {[
            { rank: "first", label: "1st place" },
            { rank: "second", label: "2nd place" },
            { rank: "third", label: "3rd place" },
          ].map(({ rank, label }) => {
            const votes = photoRound?.myVotes || {};
            return (
              <div key={rank} className="photo-rank-vote-row">
                <h3 className="photo-rank-vote-heading">{label}</h3>
                <div className="photo-rank-vote-buttons">
                  {(photoRound?.voteChoices || []).map((num) => {
                    const takenElsewhere = ["third", "second", "first"].some(
                      (k) => k !== rank && votes[k] === num
                    );
                    const isSelected = votes[rank] === num;
                    return (
                      <button
                        key={`${rank}-${num}`}
                        type="button"
                        className={isSelected ? "photo-rank-vote-btn is-selected" : "photo-rank-vote-btn"}
                        onClick={() => submitPhotoRankVote(rank, num)}
                        disabled={takenElsewhere && !isSelected}
                      >
                        {num}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {session && !isProjector && photoDistributionLoading && (
        <div className="card">
          <h2>Let's see who mogged...</h2>
        </div>
      )}

      {session &&
        !isProjector &&
        !knownPlayerPhase &&
        session.phase !== "photo_distribution" && (
        <div className="card">
          <h2>Connected</h2>
          <p className="muted">Waiting for the game state to sync…</p>
        </div>
      )}

      {session &&
        !isProjector &&
        showdown &&
        session.showdown &&
        !session.showdown.splashActive &&
        !(session.showdown.foldedAuthorIds?.length > 0) &&
        !session.showdown.bothFolded && (
        <div className="card">
          <h2 style={{ marginBottom: "0.75rem" }}>
            {session.showdown.promptText}
          </h2>

          {canVote && (
            <div
              style={{
                marginTop: "1.25rem",
                display: "flex",
                gap: "0.75rem",
                alignItems: "stretch",
              }}
            >
              <button
                type="button"
                onClick={() => vote("A")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  textAlign: "center",
                }}
              >
                {session.showdown.answerA}
              </button>
              <button
                type="button"
                onClick={() => vote("B")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  textAlign: "center",
                }}
              >
                {session.showdown.answerB}
              </button>
            </div>
          )}

          {!canVote && session.showdown.eligibleVoters?.length > 0 && (
            <p className="muted" style={{ marginTop: "1rem" }}>
              {session.showdown.bothFolded
                ? "Both authors were too busy gooning to answer. No voting."
                : session.showdown.foldedAuthorIds?.length === 1
                ? "One author didn't have enough aura. No voting."
                : session.showdown.myVote
                ? `You've submitted your vote.`
                : "You wrote one of these answers — sit tight."}
            </p>
          )}

          {session.showdown.eligibleVoters?.length === 0 && (
            <p className="muted" style={{ marginTop: "1rem" }}>
              No eligible voters this round (edge case).
            </p>
          )}

          {showPlayerTextVoteBreakdown && session.lastResult?.voteBreakdown ? (
            <VoteDistributionMod
              breakdown={session.lastResult.voteBreakdown}
              mog={!!session.lastResult.mog}
              projector={false}
              players={session.players ?? []}
              hostPlayerId={session.hostPlayerId}
            />
          ) : null}
        </div>
      )}

      {session && !isProjector && finalResultsTransition && (
        <div className="card">
          <h2>Final results</h2>
          <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            Who will be the ultimate votemaxxer?
          </p>
        </div>
      )}

      {session && !isProjector && playAgainTransition && (
        <div className="card">
          <h2>Playing again</h2>
          <p
            className="muted"
            style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "1rem" }}
          >
            1st round in {Math.max(0, answerTimeRemainingSec)}s…
          </p>
        </div>
      )}

      {session && !isProjector && ended && (
        <div className="card">
          <h2>Game over</h2>
          {endgamePlayerStanding ? (
            <div style={{ marginTop: "1rem" }}>
              <p style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>
                Your score: {endgamePlayerStanding.score.toFixed(1)} pts
              </p>
              <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.95rem" }}>
                Your rank: {ordinalRank(endgamePlayerStanding.rank)} of{" "}
                {endgamePlayerStanding.total}{" "}
                {endgamePlayerStanding.total === 1 ? "player" : "players"}
              </p>
            </div>
          ) : null}
          {session.winner?.players?.length ? (
            <div style={{ marginTop: "1rem" }}>
              <p className="muted" style={{ marginBottom: "0.5rem", fontSize: "0.9rem" }}>
                Ultimate framemogger:
              </p>
              <div className="player-element-list">
                {session.winner.players.map((p) => (
                  <PlayerElement
                    key={p.id}
                    name={p.name}
                    iconKey={p.iconKey}
                    playerId={p.id}
                    hostPlayerId={session.hostPlayerId}
                    variant="compact"
                  />
                ))}
              </div>
              <p className="muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
                {Number(session.winner.score ?? 0).toFixed(1)} pts
              </p>
            </div>
          ) : session.winner?.names?.length ? (
            <p style={{ marginTop: "1rem" }}>{session.winner.names.join(", ")}</p>
          ) : null}
          {isHost ? (
            <div
              style={{
                marginTop: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.65rem",
              }}
            >
              <button
                type="button"
                onClick={playAgain}
                disabled={endgameBusy || !canStartGame}
                style={{
                  width: "100%",
                  background: "linear-gradient(135deg, var(--accent), #c9a22e)",
                  color: "#1a1408",
                }}
              >
                {endgameBusy ? "Please wait…" : "Play Again"}
              </button>
              <button
                type="button"
                onClick={newGameFromEnd}
                disabled={endgameBusy}
                style={{
                  width: "100%",
                  background: "var(--surface)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                }}
              >
                New Game
              </button>
            </div>
          ) : (
            <p className="muted" style={{ marginTop: "1.25rem", marginBottom: 0 }}>
              Waiting for the host to start another game…
            </p>
          )}
        </div>
      )}

      {/* Intentionally render nothing for players on score phases. */}
    </div>
  );
}
