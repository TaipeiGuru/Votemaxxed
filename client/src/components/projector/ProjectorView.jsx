import { PlayerElement } from "../../PlayerElement.jsx";
import {
  ProjectorDualAnswerColumns,
  ProjectorScoreDropBoard,
} from "../vote/VoteDistribution.jsx";

export function ProjectorView({
  session,
  showVoteDistribution,
  answerTimeRemainingSec,
}) {
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
  const finalResultsTransition = session?.phase === "final_results_transition";
  const playAgainTransition = session?.phase === "play_again_transition";
  const round1Scores = session?.phase === "round1_scores";
  const round2TextSplash = session?.phase === "round2_text_splash";
  const round2Scores = session?.phase === "round2_scores";
  const photoRoundSplash = session?.phase === "photo_round_splash";
  const ended = session?.phase === "ended";
  const sd = session?.showdown;
  const progress = session?.answerProgress ?? { done: [], waiting: [] };
  const photoRound = session?.photoRound ?? null;
  const photoVotePairings = photoRound?.pairings || [];
  const photoVoteGridCols = Math.max(1, Math.ceil(Math.sqrt(photoVotePairings.length || 1)));
  const photoVoteGridRows = Math.max(
    1,
    Math.ceil((photoVotePairings.length || 1) / photoVoteGridCols)
  );
  const photoDistributionPairings = photoRound?.distribution?.pairings || [];
  const photoDistributionGridCols = Math.max(
    1,
    Math.ceil(Math.sqrt(photoDistributionPairings.length || 1))
  );
  const photoDistributionGridRows = Math.max(
    1,
    Math.ceil((photoDistributionPairings.length || 1) / photoDistributionGridCols)
  );

  const breakdownVisible = !!session?.lastResult?.voteBreakdown && showVoteDistribution;

  const projectorTextRound = Number(session?.showdown?.textRoundNumber);
  const projectorAnswerPointScores =
    breakdownVisible &&
    session?.phase === "showdown" &&
    (projectorTextRound === 1 || projectorTextRound === 2) &&
    session?.lastResult?.answerScores
      ? session.lastResult.answerScores
      : null;

  const projectorHeaderMatchPlayer = photoDistributionLoading;

  return (
    <div className="projector-root">
      <header
        className={`projector-top${projectorHeaderMatchPlayer ? " projector-top--match-player" : ""}`}
      >
        <div className="projector-brand">
          <div className="header-brand-row">
            <img
              src="/images/white_logo.png"
              alt=""
              className="header-brand-logo header-brand-logo--projector"
              width={46}
              height={46}
            />
            <p className="projector-kicker">Votemaxxed</p>
          </div>
          <p className="muted projector-match-player-tagline">
            Are you a true votemaxxer? Use your creativity to avoid getting answermogged.
          </p>
        </div>
        {code && !projectorHeaderMatchPlayer ? (
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
            {(session.players?.length ?? 0) === 1 ? "" : "s"} connected. The host will start when
            ready.
          </p>
          <ul className="projector-player-list">
            {session.players?.map((p) => (
              <li key={p.id}>
                <div className="projector-player-element-wrap">
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
                    <li key={p.id}>
                      <PlayerElement
                        name={p.name}
                        iconKey={p.iconKey}
                        playerId={p.id}
                        hostPlayerId={session.hostPlayerId}
                        variant="compact"
                      />
                    </li>
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
                    <li key={p.id}>
                      <PlayerElement
                        name={p.name}
                        iconKey={p.iconKey}
                        playerId={p.id}
                        hostPlayerId={session.hostPlayerId}
                        variant="compact"
                      />
                    </li>
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

      {showdown && sd && !sd.splashActive && !(sd.foldedAuthorIds?.length > 0) && !sd.bothFolded && (
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
            authorsMuted
            authorAName={session.lastResult?.voteBreakdown?.authorAName}
            authorBName={session.lastResult?.voteBreakdown?.authorBName}
            authorAId={session.lastResult?.voteBreakdown?.authorAId}
            authorBId={session.lastResult?.voteBreakdown?.authorBId}
            players={session.players}
            answerA={sd.answerA}
            answerB={sd.answerB}
            votersForA={sd.votersForA ?? []}
            votersForB={sd.votersForB ?? []}
            hostPlayerId={session.hostPlayerId}
            answerPointScores={projectorAnswerPointScores}
            answerPointsAnimate={!!projectorAnswerPointScores}
            answerPointsAnimKey={String(session.lastResult?.queueIndex ?? "")}
          />
        </div>
      )}

      {photoUpload && (
        <div className="projector-card projector-photo-round">
          <p className="projector-photo-timer">Time left: {answerTimeRemainingSec}s</p>
          <div className="projector-answering-grid">
            <section className="projector-status-col">
              <h3 className="projector-status-heading ready">Ready</h3>
              <ul className="projector-name-list">
                {photoRound?.uploadProgress?.done?.length ? (
                  photoRound.uploadProgress.done.map((p) => (
                    <li key={p.id}>
                      <PlayerElement
                        name={p.name}
                        iconKey={p.iconKey}
                        playerId={p.id}
                        hostPlayerId={session.hostPlayerId}
                        variant="compact"
                      />
                    </li>
                  ))
                ) : (
                  <li className="muted">No uploads yet</li>
                )}
              </ul>
            </section>
            <section className="projector-status-col">
              <h3 className="projector-status-heading waiting">Waiting</h3>
              <ul className="projector-name-list">
                {photoRound?.uploadProgress?.waiting?.length ? (
                  photoRound.uploadProgress.waiting.map((p) => (
                    <li key={p.id}>
                      <PlayerElement
                        name={p.name}
                        iconKey={p.iconKey}
                        playerId={p.id}
                        hostPlayerId={session.hostPlayerId}
                        variant="compact"
                      />
                    </li>
                  ))
                ) : (
                  <li className="muted">Everyone uploaded</li>
                )}
              </ul>
            </section>
          </div>
        </div>
      )}

      {photoCaptionTransition && (
        <div className="card">
          <h2>Get ready to caption…</h2>
        </div>
      )}

      {photoCaptioning && (
        <div className="projector-card projector-photo-round">
          <p className="projector-photo-timer">Time left: {answerTimeRemainingSec}s</p>
          <div className="projector-answering-grid">
            <section className="projector-status-col">
              <h3 className="projector-status-heading ready">Ready</h3>
              <ul className="projector-name-list">
                {photoRound?.captionProgress?.done?.length ? (
                  photoRound.captionProgress.done.map((p) => (
                    <li key={p.id}>
                      <PlayerElement
                        name={p.name}
                        iconKey={p.iconKey}
                        playerId={p.id}
                        hostPlayerId={session.hostPlayerId}
                        variant="compact"
                      />
                    </li>
                  ))
                ) : (
                  <li className="muted">No captions yet</li>
                )}
              </ul>
            </section>
            <section className="projector-status-col">
              <h3 className="projector-status-heading waiting">Waiting</h3>
              <ul className="projector-name-list">
                {photoRound?.captionProgress?.waiting?.length ? (
                  photoRound.captionProgress.waiting.map((p) => (
                    <li key={p.id}>
                      <PlayerElement
                        name={p.name}
                        iconKey={p.iconKey}
                        playerId={p.id}
                        hostPlayerId={session.hostPlayerId}
                        variant="compact"
                      />
                    </li>
                  ))
                ) : (
                  <li className="muted">Everyone submitted</li>
                )}
              </ul>
            </section>
          </div>
        </div>
      )}

      {photoVoteLoading && (
        <div className="card">
          <h2>Get ready to vote...</h2>
        </div>
      )}

      {photoVoting && (
        <div className="projector-card projector-photo-round projector-photo-round--vote-fit">
          <p
            className="projector-photo-timer"
            style={{
              marginBottom: "clamp(0.25rem, 0.75vh, 0.6rem)",
              color: answerTimeRemainingSec <= 10 ? "var(--danger)" : "var(--accent)",
            }}
          >
            Time left: {answerTimeRemainingSec}s
          </p>
          <div
            className="projector-photo-grid projector-photo-grid--vote-fit"
            style={{
              "--vote-grid-cols": photoVoteGridCols,
              "--vote-grid-rows": photoVoteGridRows,
            }}
          >
            {photoVotePairings.map((pairing) => (
              <article key={pairing.number} className="projector-photo-card projector-photo-card--vote-fit">
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
        <div className="projector-card projector-card--surface projector-photo-round">
          <h2>Let's see who mogged...</h2>
        </div>
      )}

      {photoDistribution && (
        <div className="projector-card projector-photo-round projector-photo-round--vote-fit">
          <div
            className="projector-photo-grid projector-photo-grid--vote-fit"
            style={{
              "--vote-grid-cols": photoDistributionGridCols,
              "--vote-grid-rows": photoDistributionGridRows,
            }}
          >
            {photoDistributionPairings.map((pairing) => (
              <article key={pairing.number} className="projector-photo-card projector-photo-card--vote-fit">
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

      {finalResultsTransition && (
        <div className="projector-card projector-card--surface projector-photo-round">
          <h2 className="projector-card-title" style={{ textAlign: "center", marginBottom: "0.5rem" }}>
            Final results
          </h2>
          <p className="muted projector-lead" style={{ textAlign: "center", marginBottom: 0 }}>
            Who will be the ultimate votemaxxer?
          </p>
        </div>
      )}

      {playAgainTransition && (
        <div className="projector-card projector-card--surface projector-photo-round">
          <h2 className="projector-card-title" style={{ textAlign: "center", marginBottom: "0.5rem" }}>
            Round 1
          </h2>
        </div>
      )}

      {(round1Scores || round2Scores || ended) && (
        <div className="projector-card">
          <ProjectorScoreDropBoard
            players={session.players}
            scores={session.scores}
            phaseKey={`${session.code}-${session.phase}`}
            hostPlayerId={session.hostPlayerId}
          />
        </div>
      )}

      {round2TextSplash && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Round 2 - double points!</h2>
        </div>
      )}

      {photoRoundSplash && (
        <div className="projector-card projector-photo-round">
          <h2 className="projector-card-title">Round 3</h2>
          <p className="muted projector-lead" style={{ textAlign: "center", marginBottom: 0 }}>
            Photo uploads open in a moment…
          </p>
        </div>
      )}
    </div>
  );
}
