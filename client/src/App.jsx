import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

function useSocket() {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = io(SERVER, { transports: ["websocket", "polling"] });
  }
  return ref.current;
}

function MogOverlay({ payload, onDone }) {
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
    </div>
  );
}

function ProjectorView({ session, showVoteDistribution }) {
  const code = session?.code ?? "";
  const lobby = session?.phase === "lobby";
  const answering = session?.phase === "answering";
  const showdown = session?.phase === "showdown";
  const ended = session?.phase === "ended";
  const sd = session?.showdown;
  const progress = session?.answerProgress ?? { done: [], waiting: [] };

  const votingLive = showdown && sd && !sd.reviewActive && !sd.splashActive;

  return (
    <div className="projector-root">
      <header className="projector-top">
        <div>
          <p className="projector-kicker">Votemaxxed · Projector</p>
          <p className="projector-code">{code}</p>
        </div>
        <p className="projector-phase-label muted">
          {lobby && "Waiting for the host"}
          {answering && "Players are writing answers"}
          {showdown && !sd?.splashActive && "Showdown"}
          {showdown && sd?.splashActive && "Next round"}
          {ended && "Game over"}
        </p>
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
          <h2 className="projector-card-title">Answer status</h2>
          <p className="muted projector-lead">
            Each player must save answers for both prompts they were assigned.
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

      {showdown && sd && (
        <div className="projector-card projector-showdown">
          {votingLive && (
            <>
              <h2 className="projector-prompt">{sd.promptText}</h2>
              <div className="projector-answers-row">
                <div className="projector-answer-panel" aria-label="Choice A">
                  <p className="projector-answer-text">{sd.answerA}</p>
                </div>
                <div className="projector-answer-panel" aria-label="Choice B">
                  <p className="projector-answer-text">{sd.answerB}</p>
                </div>
              </div>
              <p className="muted projector-vote-meta">
                Votes {sd.votesCast ?? 0} / {sd.votesNeeded ?? 0}
              </p>
            </>
          )}

          {sd.reviewActive && !showVoteDistribution && (
            <div className="projector-pending-result">
              <h2 className="projector-prompt">{sd.promptText}</h2>
              <p className="muted">Resolving this round…</p>
            </div>
          )}

          {showVoteDistribution && session.lastResult?.voteBreakdown && (
            <VoteDistribution
              breakdown={session.lastResult.voteBreakdown}
              mog={!!session.lastResult.mog}
              projector
            />
          )}
        </div>
      )}

      {ended && (
        <div className="projector-card">
          <h2 className="projector-card-title">Game over</h2>
          {showVoteDistribution && session.lastResult?.voteBreakdown && (
            <VoteDistribution
              breakdown={session.lastResult.voteBreakdown}
              mog={!!session.lastResult.mog}
              projector
            />
          )}
          {session.winner && (
            <p className="projector-winner-line">
              {session.winner.names?.join(" · ")} —{" "}
              <strong>{session.winner.score?.toFixed(1)}</strong> pts
            </p>
          )}
          <h3 className="projector-scores-title">Final scores</h3>
          <ul className="projector-score-list">
            {session.players
              ?.map((p) => ({
                ...p,
                score: session.scores?.[p.id] ?? 0,
              }))
              .sort((a, b) => b.score - a.score)
              .map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <span className="projector-score-val">{p.score.toFixed(1)}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NextVoteSplash({ active }) {
  if (!active) return null;
  return (
    <div className="next-vote-splash" aria-live="polite">
      <div className="next-vote-splash-backdrop" />
      <div className="next-vote-splash-card">
        <p className="next-vote-splash-text">Get ready for the next vote...</p>
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

export default function App() {
  const socket = useSocket();
  const [name, setName] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [altPromptVisible, setAltPromptVisible] = useState({});
  /** null | 'saving' | 'saved' */
  const [answersSaveStatus, setAnswersSaveStatus] = useState(null);
  const [mogPayload, setMogPayload] = useState(null);
  const [chudPayload, setChudPayload] = useState(null);
  const [customPromptDraft, setCustomPromptDraft] = useState("");
  const [voteRevealVisible, setVoteRevealVisible] = useState(false);
  const pendingVoteRevealRef = useRef(null);

  useEffect(() => {
    function onState(s) {
      if (s.phase === "gone") {
        setSession(null);
        setError(s.message || "Session ended.");
        return;
      }
      setSession(s);
      setError("");
    }
    function onMog(p) {
      setMogPayload(p);
    }
    function onChud(p) {
      setChudPayload(p);
    }
    socket.on("session_state", onState);
    socket.on("unanimous_victory", onMog);
    socket.on("chud_overlay", onChud);
    return () => {
      socket.off("session_state", onState);
      socket.off("unanimous_victory", onMog);
      socket.off("chud_overlay", onChud);
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

  const vote = useCallback(
    (choice) => {
      socket.emit("vote", { choice }, (res) => {
        if (!res?.ok) setError(res?.error || "Vote failed.");
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
    if (session?.phase !== "answering") setAnswersSaveStatus(null);
  }, [session?.phase]);

  useEffect(() => {
    if (session?.phase !== "answering") setAltPromptVisible({});
  }, [session?.phase]);

  useEffect(() => {
    if (session?.phase !== "lobby") setCustomPromptDraft("");
  }, [session?.phase]);

  const lobby = session?.phase === "lobby";
  const answering = session?.phase === "answering";
  const showdown = session?.phase === "showdown";
  const ended = session?.phase === "ended";

  const canVote = useMemo(() => {
    if (!showdown || !session?.showdown) return false;
    const d = session.showdown;
    const eligible = d.eligibleVoters || [];
    return (
      eligible.includes(session.you) &&
      !d.myVote &&
      !d.reviewActive &&
      !d.splashActive
    );
  }, [showdown, session]);

  const displayCode = session?.code;
  const isProjector = session?.role === "projector";

  const showVoteDistribution =
    session?.lastResult?.voteBreakdown &&
    (session?.phase === "ended" || voteRevealVisible);

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
        />
      )}
      {chudPayload && (
        <ChudOverlay
          payload={chudPayload}
          onDone={() => setChudPayload(null)}
        />
      )}
      <NextVoteSplash active={!!session?.showdown?.splashActive} />

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
                style={{
                  marginTop: "0.75rem",
                  width: "100%",
                  background: "var(--surface)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                }}
              >
                Join session
              </button>
              <button
                type="button"
                onClick={joinAsProjector}
                disabled={!codeInput.trim()}
                style={{
                  marginTop: "0.5rem",
                  width: "100%",
                  background: "transparent",
                  color: "var(--accent)",
                  border: "1px solid var(--accent-dim)",
                }}
              >
                Project
              </button>
              <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}>
                Project: enter the code above, then open a TV or second display — does not
                count as a player.
              </p>
            </div>
          </div>
        </div>
      )}

      {isProjector && session && (
        <ProjectorView session={session} showVoteDistribution={showVoteDistribution} />
      )}

      {session && !isProjector && lobby && (
        <div className="card">
          <p className="muted" style={{ margin: "0 0 0.5rem" }}>
            Session code
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
              <h2 style={{ fontSize: "1.15rem", marginBottom: "0.35rem" }}>
                Custom prompts
              </h2>
              <p className="muted" style={{ margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
                {isHost
                  ? `These are guaranteed to appear (up to ${session.maxCustomPrompts ?? 0}, one per player). The rest are random from the built-in list.`
                  : "The host chose these — they will appear in the game."}
              </p>
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
                    <label htmlFor="custom-prompt">New prompt</label>
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

          {isHost ? (
            <button
              type="button"
              onClick={startGame}
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
          <p className="muted">
            You have two prompts. Everyone gets two — each prompt is shared by two
            players.
          </p>
          {myPrompts.map((p) => (
            <div key={p.index} style={{ marginTop: "1.25rem" }}>
              <label htmlFor={`a-${p.index}`}>{p.text}</label>
              {session?.promptAlt?.[String(p.index)]?.swapped && (
                <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                  Prompt switched to the alternate (locked).
                </p>
              )}
              {!session?.promptAlt?.[String(p.index)]?.swapped && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={() =>
                      setAltPromptVisible((prev) => ({
                        ...prev,
                        [String(p.index)]: !prev[String(p.index)],
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
                    {altPromptVisible[String(p.index)] ? "Hide alternate prompt" : "See alternate prompt"}
                  </button>
                  {altPromptVisible[String(p.index)] && (
                    <button
                      type="button"
                      onClick={() => requestAlternatePrompt(p.index)}
                      disabled={
                        (session?.promptAlt?.[String(p.index)]?.requestedBy || []).includes(session?.you)
                      }
                      style={{
                        padding: "0.4rem 0.7rem",
                        fontSize: "0.85rem",
                        background: "var(--surface)",
                        border: "1px solid var(--accent-dim)",
                        color: "var(--accent)",
                      }}
                    >
                      Request this prompt
                    </button>
                  )}
                </div>
              )}
              {altPromptVisible[String(p.index)] &&
                !session?.promptAlt?.[String(p.index)]?.swapped && (
                  <div
                    style={{
                      marginTop: "0.75rem",
                      padding: "0.75rem",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "rgba(139, 149, 168, 0.06)",
                    }}
                  >
                    <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.82rem" }}>
                      Alternate prompt
                    </p>
                    <p style={{ margin: 0 }}>
                      {session?.promptAlt?.[String(p.index)]?.altText || "—"}
                    </p>
                    {(() => {
                      const st = session?.promptAlt?.[String(p.index)];
                      const requestedBy = st?.requestedBy || [];
                      const otherAuthor = (p.authorIds || []).find((id) => id !== session?.you) || null;
                      const otherRequested = otherAuthor ? requestedBy.includes(otherAuthor) : false;
                      const youRequested = requestedBy.includes(session?.you);
                      return (
                        <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.82rem" }}>
                          {youRequested ? "You requested this." : "You have not requested this."}{" "}
                          {otherAuthor
                            ? otherRequested
                              ? "The other author requested it too."
                              : "Waiting on the other author."
                            : null}
                        </p>
                      );
                    })()}
                  </div>
                )}
              <input
                id={`a-${p.index}`}
                type="text"
                value={answers[String(p.index)] ?? ""}
                onChange={(e) => {
                  setAnswersSaveStatus(null);
                  setAnswers((prev) => ({
                    ...prev,
                    [String(p.index)]: e.target.value,
                  }));
                }}
                maxLength={50}
                autoComplete="off"
              />
            </div>
          ))}
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

      {session && !isProjector && showdown && session.showdown && (
        <div className="card">
          {/*<p className="muted" style={{ margin: "0 0 0.25rem" }}>
            Showdown{" "}
            {session.showdown.queueIndex + 1} / {session.showdown.totalShowdowns}{" "}
            · Pass {session.showdown.passNumber}/{session.showdown.passesTotal}
          </p>*/}
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
              {session.showdown.myVote
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
          <h2>Game over</h2>
          {session.winner && (
            <>
              <p style={{ fontSize: "1.25rem", margin: "0.75rem 0" }}>
                {session.winner.names?.join(" · ")} —{" "}
                <strong>{session.winner.score?.toFixed(1)}</strong> pts
              </p>
              <p className="muted">
                Cumulative score across all showdowns (two full passes over every
                prompt).
              </p>
            </>
          )}
          <h3 style={{ marginTop: "1.5rem" }}>Final scores</h3>
          <ul>
            {session.players
              ?.map((p) => ({
                ...p,
                score: session.scores?.[p.id] ?? 0,
              }))
              .sort((a, b) => b.score - a.score)
              .map((p) => (
                <li key={p.id}>
                  {p.name}: {p.score.toFixed(1)}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
