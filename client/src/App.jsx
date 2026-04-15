import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const MOGGED_SOUND_URL = `${import.meta.env.BASE_URL}audio/mogged.mp3`;

function useSocket() {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = io(SERVER, { transports: ["websocket", "polling"] });
  }
  return ref.current;
}

function MogOverlay({ payload, onDone, playSound = false }) {
  const [pieces] = useState(() =>
    Array.from({ length: 48 }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 0.4}s`,
      duration: `${2.2 + Math.random() * 1.8}s`,
      hue: Math.floor(Math.random() * 360), 
    }))
  );

  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [onDone]);

  useEffect(() => {
    if (!payload || !playSound) return;
    const audio = new Audio(MOGGED_SOUND_URL);
    audio.volume = 0.9;
    void audio.play().catch(() => {});
  }, [payload, playSound]);

  if (!payload) return null;

  return (
    <div className="mog-overlay" aria-live="polite">
      <div className="mog-backdrop" />
      {pieces.map((p) => (
        <div
          key={p.id}
          className="confetti-piece"
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            background: `hsl(${p.hue} 85% 55%)`,
          }}
        />
      ))}
      <div className="mog-card">
        <p className="mog-title">MOGGED</p>
        <p className="muted mog-sub">
          Unanimous vote — saved to the hall of fame.
        </p>
        <p className="mog-sub">
          <strong>{payload.winningAuthorName}</strong>: “{payload.winningAnswer}”
        </p>
      </div>
    </div>
  );
}

function projectorVoterChipEntries(voters) {
  if (!voters?.length) return [];
  if (typeof voters[0] === "string") {
    return voters.map((name, i) => ({ key: `${name}-${i}`, name }));
  }
  return voters.map((v) => ({ key: v.id, name: v.name }));
}

/** Shared projector layout: two answer panels + voter chips below (voting and breakdown). */
function ProjectorDualAnswerColumns({
  showAuthors,
  authorAName,
  authorBName,
  answerA,
  answerB,
  votersForA,
  votersForB,
  rowClassName = "",
}) {
  const left = projectorVoterChipEntries(votersForA);
  const right = projectorVoterChipEntries(votersForB);
  return (
    <div className={`projector-answers-row${rowClassName ? ` ${rowClassName}` : ""}`}>
      <div className="projector-answer-stack">
        <div
          className="projector-answer-panel"
          aria-label={showAuthors ? `Answer by ${authorAName}` : "Choice A"}
        >
          {showAuthors ? (
            <p className="muted vote-distribution-author">{authorAName}</p>
          ) : null}
          <p className="projector-answer-text">{answerA}</p>
        </div>
        <div
          className="projector-voters projector-voters--a"
          aria-label="Voters for this answer"
        >
          {left.map((v) => (
            <span key={v.key} className="projector-voter-chip">
              {v.name}
            </span>
          ))}
        </div>
      </div>
      <div className="projector-answer-stack">
        <div
          className="projector-answer-panel"
          aria-label={showAuthors ? `Answer by ${authorBName}` : "Choice B"}
        >
          {showAuthors ? (
            <p className="muted vote-distribution-author">{authorBName}</p>
          ) : null}
          <p className="projector-answer-text">{answerB}</p>
        </div>
        <div
          className="projector-voters projector-voters--b"
          aria-label="Voters for this answer"
        >
          {right.map((v) => (
            <span key={v.key} className="projector-voter-chip">
              {v.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function VoteDistribution({ breakdown, mog, projector }) {
  if (!breakdown) return null;
  const { promptText, answerAText, answerBText, authorAName, authorBName, votersForA, votersForB } =
    breakdown;
  const list = (names) =>
    names.length > 0 ? names.join(", ") : "—";

  const answerDisplayStyle = {
    width: "100%",
    margin: "0 0 0.5rem",
    fontSize: "0.92rem",
    minWidth: 0,
    resize: "none",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    textAlign: "left",
    cursor: "default",
    minHeight: "2.75rem",
  };

  return (
    <div
      className={`vote-distribution${projector ? " vote-distribution--projector" : ""}`}
      style={{
        marginTop: "1.25rem",
        padding: "1rem",
        borderRadius: "var(--radius)",
        background: "rgba(139, 149, 168, 0.08)",
        border: "1px solid var(--border)",
      }}
    >
      <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Vote breakdown</p>
      <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
        {promptText}
      </p>
      {mog && (
        <p
          style={{
            margin: "0 0 0.75rem",
            fontSize: "0.88rem",
            color: "var(--accent-dim)",
          }}
        >
          MOGGED — unanimous win for this round.
        </p>
      )}
      {projector ? (
        <ProjectorDualAnswerColumns
          showAuthors
          authorAName={authorAName}
          authorBName={authorBName}
          answerA={String(answerAText ?? "")}
          answerB={String(answerBText ?? "")}
          votersForA={votersForA ?? []}
          votersForB={votersForB ?? []}
          rowClassName="vote-distribution-projector-row"
        />
      ) : (
        <div
          style={{
            display: "grid",
            gap: "0.85rem",
            gridTemplateColumns: "1fr 1fr",
          }}
        >
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "0.75rem",
              minWidth: 0,
            }}
          >
            <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.82rem" }}>
              {authorAName}
            </p>
            <textarea
              readOnly
              aria-label={`Answer by ${authorAName}`}
              value={String(answerAText ?? "").slice(0, 50)}
              rows={3}
              maxLength={50}
              style={answerDisplayStyle}
            />
            <p style={{ margin: 0, fontSize: "0.88rem" }}>
              <strong>{votersForA.length}</strong> vote{votersForA.length === 1 ? "" : "s"}
              {votersForA.length > 0 ? ": " : ""}
              <span className="muted">{list(votersForA)}</span>
            </p>
          </div>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "0.75rem",
              minWidth: 0,
            }}
          >
            <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.82rem" }}>
              {authorBName}
            </p>
            <textarea
              readOnly
              aria-label={`Answer by ${authorBName}`}
              value={String(answerBText ?? "").slice(0, 50)}
              rows={3}
              maxLength={50}
              style={answerDisplayStyle}
            />
            <p style={{ margin: 0, fontSize: "0.88rem" }}>
              <strong>{votersForB.length}</strong> vote{votersForB.length === 1 ? "" : "s"}
              {votersForB.length > 0 ? ": " : ""}
              <span className="muted">{list(votersForB)}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectorScoreDropBoard({ players, scores, phaseKey }) {
  const rows = useMemo(() => {
    const scoreRows = (players ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      score: Number(scores?.[p.id] ?? 0),
    }));
    scoreRows.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.name.localeCompare(b.name);
    });
    const uniqueScores = Array.from(new Set(scoreRows.map((r) => r.score)));
    const groupByScore = new Map(uniqueScores.map((s, i) => [s, i]));
    return scoreRows.map((r) => ({
      ...r,
      group: groupByScore.get(r.score) ?? 0,
    }));
  }, [players, scores]);

  const [revealedGroup, setRevealedGroup] = useState(-1);
  const [droppingIds, setDroppingIds] = useState([]);
  const dropClearTimerRef = useRef(null);

  useEffect(() => {
    setRevealedGroup(-1);
    setDroppingIds([]);
  }, [phaseKey, rows.length]);

  useEffect(() => {
    if (!rows.length) return undefined;
    const maxGroup = rows.reduce((max, r) => Math.max(max, r.group), -1);
    if (revealedGroup >= maxGroup) return undefined;
    const t = setTimeout(() => {
      const nextGroup = revealedGroup + 1;
      const nextDropIds = rows
        .filter((r) => r.group === nextGroup)
        .map((r) => r.id);
      setDroppingIds(nextDropIds);
      setRevealedGroup(nextGroup);
    }, 1300);
    return () => clearTimeout(t);
  }, [revealedGroup, rows]);

  useEffect(() => {
    if (!droppingIds.length) return undefined;
    if (dropClearTimerRef.current) clearTimeout(dropClearTimerRef.current);
    dropClearTimerRef.current = setTimeout(() => {
      setDroppingIds([]);
      dropClearTimerRef.current = null;
    }, 520);
    return () => {
      if (dropClearTimerRef.current) {
        clearTimeout(dropClearTimerRef.current);
        dropClearTimerRef.current = null;
      }
    };
  }, [droppingIds]);

  const visibleRows = rows.filter((r) => r.group <= revealedGroup);
  const orderedVisible = [...visibleRows].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  const topById = new Map(orderedVisible.map((r, i) => [r.id, i * 88]));

  return (
    <div className="projector-score-drop" aria-live="polite">
      <div
        className="projector-score-drop-stage"
        style={{ height: `${Math.max(rows.length, 1) * 88}px` }}
      >
        {orderedVisible.map((row) => (
          <div
            key={row.id}
            className={`projector-score-drop-row${
              droppingIds.includes(row.id) ? " is-dropping" : ""
            }`}
            style={{ top: `${topById.get(row.id) ?? 0}px` }}
          >
            <span>{row.name}</span>
            <span className="projector-score-drop-value">{row.score.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectorView({ session, showVoteDistribution, answerTimeRemainingSec, answerTimeLimitSec }) {
  const code = session?.code ?? "";
  const lobby = session?.phase === "lobby";
  const answering = session?.phase === "answering";
  const showdown = session?.phase === "showdown";
  const photoUpload = session?.phase === "photo_upload";
  const photoCaptionTransition = session?.phase === "photo_caption_transition";
  const photoCaptioning = session?.phase === "photo_captioning";
  const photoVoteLoading = session?.phase === "photo_vote_loading";
  const photoVoting = session?.phase === "photo_voting";
  const photoDistributionLoading = session?.phase === "photo_distribution_loading";
  const photoDistribution = session?.phase === "photo_distribution";
  const photoEndTransition = session?.phase === "photo_end_transition";
  const ended = session?.phase === "ended";
  const sd = session?.showdown;
  const progress = session?.answerProgress ?? { done: [], waiting: [] };
  const photoRound = session?.photoRound ?? null;

  const breakdownVisible =
    !!session?.lastResult?.voteBreakdown && showVoteDistribution;

  return (
    <div className="projector-root">
      <header className="projector-top">
        <div className="projector-brand">
          <p className="projector-kicker">Votemaxxed</p>
          {(lobby ||
            answering ||
            (showdown && sd?.splashActive) ||
            photoUpload ||
            photoCaptionTransition ||
            photoCaptioning ||
            photoVoteLoading ||
            photoVoting ||
            photoDistributionLoading ||
            photoDistribution ||
            photoEndTransition ||
            ended) && (
            <p className="projector-phase-label muted">
              {lobby && "Waiting for the host"}
              {answering && "Players are writing answers"}
              {showdown && sd?.splashActive && "Next round"}
              {photoUpload && "Photo upload"}
              {photoCaptionTransition && "Get ready to caption"}
              {photoCaptioning && "Caption submission"}
              {photoVoteLoading && "Preparing voting grid"}
              {photoVoting && "Rank your favorites"}
              {photoDistributionLoading && "Tallying votes"}
              {photoDistribution && "Vote distribution"}
              {photoEndTransition && "Final transition"}
              {ended && "Game over"}
            </p>
          )}
        </div>
        {code ? (
          <p className="projector-code" aria-label="Session code">
            {code}
          </p>
        ) : null}
      </header>

      {lobby && (
        <div className="projector-card">
          <h2 className="projector-card-title">Lobby</h2>
          <p className="muted projector-lead">
            {session.players?.length ?? 0} player
            {(session.players?.length ?? 0) === 1 ? "" : "s"} connected. The host will start
            when ready.
          </p>
          <ul className="projector-player-list">
            {session.players?.map((p) => (
              <li key={p.id}>
                <span className="projector-player-name">{p.name}</span>
                {p.id === session.hostPlayerId ? (
                  <span className="muted"> · host</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {answering && (
        <div className="projector-card projector-answering">
          <p
            style={{
              margin: "0 0 0.6rem",
              fontWeight: 700,
              color: answerTimeRemainingSec <= 10 ? "var(--danger)" : "var(--accent)",
            }}
          >
            Time left: {answerTimeRemainingSec}s
          </p>
          <div className="projector-answering-grid">
            <section className="projector-status-col">
              <h3 className="projector-status-heading ready">Ready</h3>
              <ul className="projector-name-list">
                {progress.done?.length ? (
                  progress.done.map((p) => (
                    <li key={p.id}>{p.name}</li>
                  ))
                ) : (
                  <li className="muted">No one yet</li>
                )}
              </ul>
            </section>
            <section className="projector-status-col">
              <h3 className="projector-status-heading waiting">Still writing</h3>
              <ul className="projector-name-list">
                {progress.waiting?.length ? (
                  progress.waiting.map((p) => (
                    <li key={p.id}>{p.name}</li>
                  ))
                ) : (
                  <li className="muted">Everyone is ready</li>
                )}
              </ul>
            </section>
          </div>
          {session.allAnswersIn && (
            <p className="projector-all-in">All answers in — showdown starting…</p>
          )}
        </div>
      )}

      {showdown && sd && !sd.splashActive && (
        <div className="projector-card projector-showdown">
          <h2 className="projector-prompt">{sd.promptText}</h2>
          {breakdownVisible && session.lastResult?.mog ? (
            <p
              style={{
                margin: "0 auto 1rem",
                maxWidth: "56rem",
                textAlign: "center",
                fontSize: "clamp(0.88rem, 1.6vw, 1rem)",
                color: "var(--accent-dim)",
              }}
            >
              MOGGED — unanimous win for this round.
            </p>
          ) : null}
          <ProjectorDualAnswerColumns
            showAuthors={breakdownVisible}
            authorAName={session.lastResult?.voteBreakdown?.authorAName}
            authorBName={session.lastResult?.voteBreakdown?.authorBName}
            answerA={sd.answerA}
            answerB={sd.answerB}
            votersForA={sd.votersForA ?? []}
            votersForB={sd.votersForB ?? []}
          />
        </div>
      )}

      {photoUpload && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Upload a photo</h2>
          <p className="projector-photo-timer">Time left: {answerTimeRemainingSec}s</p>
          <div className="projector-answering-grid">
            <section className="projector-status-col">
              <h3 className="projector-status-heading ready">Uploaded</h3>
              <ul className="projector-name-list">
                {photoRound?.uploadProgress?.done?.length ? (
                  photoRound.uploadProgress.done.map((p) => <li key={p.id}>{p.name}</li>)
                ) : (
                  <li className="muted">No uploads yet</li>
                )}
              </ul>
            </section>
            <section className="projector-status-col">
              <h3 className="projector-status-heading waiting">Waiting</h3>
              <ul className="projector-name-list">
                {photoRound?.uploadProgress?.waiting?.length ? (
                  photoRound.uploadProgress.waiting.map((p) => <li key={p.id}>{p.name}</li>)
                ) : (
                  <li className="muted">Everyone uploaded</li>
                )}
              </ul>
            </section>
          </div>
        </div>
      )}

      {photoCaptionTransition && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Moving to caption submission…</h2>
        </div>
      )}

      {photoCaptioning && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Write your caption</h2>
          <p className="projector-photo-timer">Time left: {answerTimeRemainingSec}s</p>
          <div className="projector-answering-grid">
            <section className="projector-status-col">
              <h3 className="projector-status-heading ready">Submitted</h3>
              <ul className="projector-name-list">
                {photoRound?.captionProgress?.done?.length ? (
                  photoRound.captionProgress.done.map((p) => <li key={p.id}>{p.name}</li>)
                ) : (
                  <li className="muted">No captions yet</li>
                )}
              </ul>
            </section>
            <section className="projector-status-col">
              <h3 className="projector-status-heading waiting">Waiting</h3>
              <ul className="projector-name-list">
                {photoRound?.captionProgress?.waiting?.length ? (
                  photoRound.captionProgress.waiting.map((p) => <li key={p.id}>{p.name}</li>)
                ) : (
                  <li className="muted">Everyone submitted</li>
                )}
              </ul>
            </section>
          </div>
        </div>
      )}

      {photoVoteLoading && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Loading voting round…</h2>
        </div>
      )}

      {photoVoting && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">
            Vote for your {photoRound?.votingStage === "first"
              ? "favorite"
              : photoRound?.votingStage === "second"
              ? "2nd favorite"
              : "3rd favorite"} pairing
          </h2>
          <p className="muted" style={{ marginBottom: "1rem" }}>
            Votes cast: {photoRound?.voteProgress?.cast ?? 0}/{photoRound?.voteProgress?.needed ?? 0}
          </p>
          <div className="projector-photo-grid">
            {(photoRound?.pairings || []).map((pairing) => (
              <article key={pairing.number} className="projector-photo-card">
                <p className="projector-photo-number">#{pairing.number}</p>
                {pairing.photoDataUrl ? (
                  <img src={pairing.photoDataUrl} alt={`Pairing ${pairing.number}`} />
                ) : (
                  <div className="projector-photo-placeholder">No photo uploaded</div>
                )}
                <p className="projector-photo-caption">{pairing.captionText || "No caption submitted"}</p>
              </article>
            ))}
          </div>
        </div>
      )}

      {photoDistributionLoading && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Loading vote distribution…</h2>
        </div>
      )}

      {photoDistribution && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Photo pairing rankings</h2>
          <div className="projector-photo-grid">
            {(photoRound?.distribution?.pairings || []).map((pairing) => (
              <article key={pairing.number} className="projector-photo-card">
                <p className="projector-photo-number">
                  #{pairing.number} - {Number(pairing.points || 0).toFixed(1)} pts
                </p>
                {pairing.photoDataUrl ? (
                  <img src={pairing.photoDataUrl} alt={`Pairing ${pairing.number}`} />
                ) : (
                  <div className="projector-photo-placeholder">No photo uploaded</div>
                )}
                <p className="projector-photo-caption">{pairing.captionText || "No caption submitted"}</p>
              </article>
            ))}
          </div>
        </div>
      )}

      {photoEndTransition && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Preparing endgame…</h2>
        </div>
      )}

      {ended && (
        <div className="projector-card">
          <ProjectorScoreDropBoard
            players={session.players}
            scores={session.scores}
            phaseKey={`${session.code}-${session.phase}`}
          />
        </div>
      )}
    </div>
  );
}

function NextVoteSplash({ active, text = "Get ready to vote..." }) {
  if (!active) return null;
  return (
    <div className="next-vote-splash" aria-live="polite">
      <div className="next-vote-splash-backdrop" />
      <div className="next-vote-splash-card">
        <p className="next-vote-splash-text">{text}</p>
      </div>
    </div>
  );
}

function ChudOverlay({ payload, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3400);
    return () => clearTimeout(t);
  }, [onDone]);

  if (!payload) return null;

  return (
    <div className="chud-overlay" aria-live="assertive">
      <div className="chud-backdrop" />
      <div className="chud-card">
        <p className="chud-title">CHUD</p>
        <p className="chud-tease">{payload.tease}</p>
        <p className="muted chud-sub">
          Your answer got <strong>0 votes</strong>
          {payload.answerText ? (
            <>
              : “{payload.answerText}”
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

function BothFoldOverlay({ payload, onDone }) {
  const [crossedOut, setCrossedOut] = useState(false);
  const visiblePlayers =
    payload?.foldedAuthorIds?.length === 1
      ? payload.players.filter((player) => payload.foldedAuthorIds.includes(player.id))
      : payload?.players ?? [];

  useEffect(() => {
    if (!payload) return undefined;
    setCrossedOut(false);
    const now = Date.now();
    const crossDelay = Math.max(0, (payload.startsAt + 5000) - now);
    const doneDelay = Math.max(0, payload.endsAt - now);
    const crossTimer = setTimeout(() => setCrossedOut(true), crossDelay);
    const doneTimer = setTimeout(onDone, doneDelay);
    return () => {
      clearTimeout(crossTimer);
      clearTimeout(doneTimer);
    };
  }, [payload, onDone]);

  if (!payload) return null;

  return (
    <div className="both-fold-overlay" aria-live="assertive">
      <div className="both-fold-backdrop" />
      <div className="both-fold-card">
        <p className="both-fold-title">
          {payload.foldedAuthorIds?.length === 1 ? "Chud Alert!" : "Battle of the Chuds"}
        </p>
        <p className="both-fold-copy">
          {payload.foldedAuthorIds?.length === 1
            ? "Someone was so afraid of getting answermogged that they folded under pressure."
            : "Both players were so afraid of getting answermogged that they folded under pressure."}
        </p>
        <div className="both-fold-names">
          {visiblePlayers.map((player, idx) => (
            <p
              key={`${idx}-${player.id}`}
              className={`both-fold-name${
                crossedOut && payload.foldedAuthorIds?.includes(player.id) ? " is-crossed" : ""
              }`}
            >
              <span>{player.name}</span>
              <span className="both-fold-subhuman">subhuman</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  const [photoCaptionDraft, setPhotoCaptionDraft] = useState("");
  const [customPromptDraft, setCustomPromptDraft] = useState("");
  const [showCustomPromptInfo, setShowCustomPromptInfo] = useState(false);
  const [voteRevealVisible, setVoteRevealVisible] = useState(false);
  const [answerTimeLeftMs, setAnswerTimeLeftMs] = useState(0);
  const pendingVoteRevealRef = useRef(null);
  const altRejectTimerRef = useRef(null);
  const latestSessionRef = useRef(null);
  const latestAnswersRef = useRef({});
  const bothFoldShownQueueRef = useRef(null);
  const bothFoldStartTimerRef = useRef(null);

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
    const lr = session?.lastResult;
    if (!lr?.voteBreakdown) {
      setVoteRevealVisible(false);
      pendingVoteRevealRef.current = null;
      return;
    }
    if (session?.phase === "ended") {
      setVoteRevealVisible(true);
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
    const authorAName =
      players.find((p) => p.id === sd.authorA)?.name ?? "Player A";
    const authorBName =
      players.find((p) => p.id === sd.authorB)?.name ?? "Player B";

    bothFoldShownQueueRef.current = queueKey;
    bothFoldStartTimerRef.current = setTimeout(() => {
      setBothFoldPayload({
        queueIndex: queueKey,
        players: [
          { id: sd.authorA, name: authorAName },
          { id: sd.authorB, name: authorBName },
        ],
        foldedAuthorIds,
        startsAt: Number(sd.bothFoldStartsAt || Date.now() + 1500),
        endsAt: Number(sd.bothFoldEndsAt || Date.now() + 10500),
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
      socket.emit("vote", { choice }, (res) => {
        if (!res?.ok) setError(res?.error || "Vote failed.");
      });
    },
    [socket]
  );

  const submitPhoto = useCallback(() => {
    setError("");
    socket.emit("submit_photo", { photoDataUrl }, (res) => {
      if (!res?.ok) setError(res?.error || "Photo submit failed.");
    });
  }, [socket, photoDataUrl]);

  const submitPhotoCaption = useCallback(() => {
    setError("");
    socket.emit("submit_photo_caption", { caption: photoCaptionDraft }, (res) => {
      if (!res?.ok) setError(res?.error || "Caption submit failed.");
    });
  }, [socket, photoCaptionDraft]);

  const submitPhotoRankVote = useCallback(
    (number) => {
      setError("");
      socket.emit("submit_photo_rank_vote", { number }, (res) => {
        if (!res?.ok) setError(res?.error || "Rank vote failed.");
      });
    },
    [socket]
  );

  const myPrompts = session?.myPrompts ?? [];
  const isHost = session?.you && session?.hostPlayerId === session?.you;

  useEffect(() => {
    if (session?.phase !== "answering") return;
    const mine = {};
    for (const p of myPrompts) {
      const k = String(p.index);
      mine[k] = session.answersMine?.[k] ?? "";
    }
    setAnswers((prev) => ({ ...mine, ...prev }));
  }, [session?.phase, session?.answersMine, myPrompts]);

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
  ]);

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
    if (session?.phase === "photo_captioning") {
      setPhotoCaptionDraft(session?.photoRound?.myCaptionText || "");
      return;
    }
    setPhotoCaptionDraft("");
  }, [session?.phase, session?.photoRound?.myCaptionText]);

  const lobby = session?.phase === "lobby";
  const answering = session?.phase === "answering";
  const showdown = session?.phase === "showdown";
  const photoUpload = session?.phase === "photo_upload";
  const photoCaptionTransition = session?.phase === "photo_caption_transition";
  const photoCaptioning = session?.phase === "photo_captioning";
  const photoVoteLoading = session?.phase === "photo_vote_loading";
  const photoVoting = session?.phase === "photo_voting";
  const photoDistributionLoading = session?.phase === "photo_distribution_loading";
  const photoDistribution = session?.phase === "photo_distribution";
  const photoEndTransition = session?.phase === "photo_end_transition";
  const ended = session?.phase === "ended";
  const knownPlayerPhase =
    lobby ||
    answering ||
    showdown ||
    photoUpload ||
    photoCaptionTransition ||
    photoCaptioning ||
    photoVoteLoading ||
    photoVoting ||
    photoDistributionLoading ||
    photoDistribution ||
    photoEndTransition ||
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
  const playerCount = session?.players?.length ?? 0;
  const canStartGame = playerCount >= 3 && playerCount <= 10;

  const showVoteDistribution =
    session?.lastResult?.voteBreakdown &&
    (session?.phase === "ended" || voteRevealVisible);
  const isFinalShowdownSplash =
    session?.phase === "showdown" &&
    !!session?.showdown?.splashActive &&
    Number(session?.showdown?.queueIndex) ===
      Number(session?.showdown?.totalShowdowns) - 1;
  const nextVoteSplashText = isFinalShowdownSplash
    ? "let's see the answermaxxer leaderboard..."
    : "Get ready to vote...";
  const answerTimeLimitSec = session?.answerTimeLimitSec ?? 75;
  const answerTimeRemainingSec = Math.ceil(answerTimeLeftMs / 1000);
  const photoRound = session?.photoRound ?? null;
  const voteStageLabel =
    photoRound?.votingStage === "first"
      ? "favorite"
      : photoRound?.votingStage === "second"
      ? "2nd favorite"
      : "3rd favorite";

  const onPhotoFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPhotoDataUrl(String(reader.result || ""));
    };
    reader.readAsDataURL(file);
  }, []);

  return (
    <div className={`layout${isProjector ? " layout--projector" : ""}`}>
      {!isProjector && (
        <header style={{ marginBottom: "1.75rem" }}>
          <h1 style={{ fontSize: "2.35rem", letterSpacing: "-0.02em" }}>
            Votemaxxed
          </h1>
          <p className="muted" style={{ margin: 0, fontSize: "0.95rem" }}>
            Are you a true votemaxxer? Use your creativity to avoid getting answermogged.
          </p>
        </header>
      )}

      {mogPayload && (
        <MogOverlay
          payload={mogPayload}
          onDone={() => setMogPayload(null)}
          playSound={isProjector}
        />
      )}
      {chudPayload && (
        <ChudOverlay
          payload={chudPayload}
          onDone={() => setChudPayload(null)}
        />
      )}
      {isProjector && bothFoldPayload && (
        <BothFoldOverlay
          payload={bothFoldPayload}
          onDone={() => setBothFoldPayload(null)}
        />
      )}
      <NextVoteSplash
        active={!!session?.showdown?.splashActive}
        text={nextVoteSplashText}
      />

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
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                placeholder="ABCD"
                maxLength={4}
                style={{ textTransform: "uppercase", letterSpacing: "0.2em" }}
              />
              <button
                type="button"
                onClick={joinSession}
                disabled={
                  codeInput.trim().length !== 4 || !name.trim()
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
        <ProjectorView
          session={session}
          showVoteDistribution={showVoteDistribution}
          answerTimeRemainingSec={answerTimeRemainingSec}
          answerTimeLimitSec={answerTimeLimitSec}
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
          <ul style={{ margin: "0 0 1rem", paddingLeft: "1.2rem" }}>
            {session.players?.map((p) => (
              <li key={p.id}>
                {p.name}
                {p.id === session.hostPlayerId ? " — host" : ""}
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
          <p
            style={{
              margin: "0.25rem 0 0.6rem",
              fontWeight: 700,
              color: answerTimeRemainingSec <= 10 ? "var(--danger)" : "var(--accent)",
            }}
          >
            Time left: {answerTimeRemainingSec}s
          </p>
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

      {session && !isProjector && photoUpload && (
        <div className="card">
          <h2>Upload your photo</h2>
          <p className="muted">Time left: {answerTimeRemainingSec}s</p>
          <input type="file" accept="image/*" onChange={onPhotoFileChange} />
          {photoDataUrl && (
            <img
              src={photoDataUrl}
              alt="Your selected upload"
              style={{ width: "100%", marginTop: "0.75rem", borderRadius: "12px" }}
            />
          )}
          <button
            type="button"
            onClick={submitPhoto}
            disabled={!photoDataUrl || !!photoRound?.myPhotoSubmitted}
            style={{ marginTop: "0.9rem" }}
          >
            {photoRound?.myPhotoSubmitted ? "Uploaded" : "Submit photo"}
          </button>
        </div>
      )}

      {session && !isProjector && photoCaptionTransition && (
        <div className="card">
          <h2>Get ready to caption…</h2>
        </div>
      )}

      {session && !isProjector && photoCaptioning && (
        <div className="card">
          <h2>Write your caption</h2>
          <p className="muted">Time left: {answerTimeRemainingSec}s</p>
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
          <h2>Loading voting…</h2>
        </div>
      )}

      {session && !isProjector && photoVoting && (
        <div className="card">
          <h2>Vote for your {voteStageLabel}</h2>
          <p className="muted">
            Pick one number. You cannot reuse numbers across ranks.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", marginTop: "0.9rem" }}>
            {(photoRound?.voteChoices || []).map((num) => {
              const alreadyUsed = [
                photoRound?.myVotes?.third,
                photoRound?.myVotes?.second,
                photoRound?.myVotes?.first,
              ].includes(num);
              const alreadyVotedThisStage = !!photoRound?.myVotes?.[photoRound?.votingStage || "third"];
              return (
                <button
                  key={num}
                  type="button"
                  onClick={() => submitPhotoRankVote(num)}
                  disabled={alreadyUsed || alreadyVotedThisStage}
                >
                  {num}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {session && !isProjector && photoDistributionLoading && (
        <div className="card">
          <h2>Calculating results…</h2>
        </div>
      )}

      {session && !isProjector && photoEndTransition && (
        <div className="card">
          <h2>Moving to endgame…</h2>
        </div>
      )}

      {session && !isProjector && !knownPlayerPhase && (
        <div className="card">
          <h2>Connected</h2>
          <p className="muted">Waiting for the game state to sync…</p>
        </div>
      )}

      {session &&
        !isProjector &&
        showdown &&
        session.showdown &&
        !session.showdown.splashActive && (
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
                ? "Both authors folded this round. No points awarded."
                : session.showdown.foldedAuthorIds?.length === 1
                ? "One author failed to answer this round. No voting."
                : session.showdown.myVote
                ? `You voted ${session.showdown.myVote}.`
                : "You wrote one of these answers — sit tight."}
            </p>
          )}

          {session.showdown.eligibleVoters?.length === 0 && (
            <p className="muted" style={{ marginTop: "1rem" }}>
              No eligible voters this round (edge case).
            </p>
          )}
        </div>
      )}

      {session && !isProjector && ended && (
        <div className="card">
          <p style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>scoremaxxer</p>
        </div>
      )}
    </div>
  );
}
