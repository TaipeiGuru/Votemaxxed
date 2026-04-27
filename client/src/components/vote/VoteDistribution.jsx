import { useEffect, useMemo, useRef, useState } from "react";
import { PlayerElement } from "../../PlayerElement.jsx";
import { playSfx } from "../../audio/engine.js";

function projectorVoterChipEntries(voters) {
  if (!voters?.length) return [];
  if (typeof voters[0] === "string") {
    return voters.map((name, i) => ({
      key: `${name}-${i}`,
      id: undefined,
      name,
      iconKey: undefined,
    }));
  }
  return voters.map((v) => ({
    key: v.id,
    id: v.id,
    name: v.name,
    iconKey: v.iconKey,
  }));
}

function formatShowdownPointsDelta(n) {
  const x = Number(n) || 0;
  const s = x.toFixed(1);
  return x >= 0 ? `+${s}` : s;
}

function ProjectorColumnPointReveal({ base, mogBonus, alignEnd, animKey }) {
  const mog = Number(mogBonus) > 0;
  const total = (Number(base) || 0) + (Number(mogBonus) || 0);

  useEffect(() => {
    const timer = setTimeout(() => {
      playSfx("kaching", { volume: 0.95 });
    }, 1000);
    return () => clearTimeout(timer);
  }, [animKey]);

  return (
    <div
      className={`projector-point-reveal${alignEnd ? " projector-point-reveal--end" : ""}`}
      aria-live="polite"
    >
      {mog ? (
        <>
          <div key={`${animKey}-b`} className="projector-point-badge projector-point-badge--base">
            {formatShowdownPointsDelta(base)} pts
          </div>
          <div key={`${animKey}-m`} className="projector-point-badge projector-point-badge--mog">
            MOG {formatShowdownPointsDelta(mogBonus)} pts
          </div>
        </>
      ) : (
        <div key={`${animKey}-t`} className="projector-point-badge projector-point-badge--total">
          {formatShowdownPointsDelta(total)} pts
        </div>
      )}
    </div>
  );
}

export function ProjectorDualAnswerColumns({
  showAuthors,
  authorsMuted = false,
  authorAName,
  authorBName,
  authorAId,
  authorBId,
  players,
  answerA,
  answerB,
  votersForA,
  votersForB,
  hostPlayerId,
  rowClassName = "",
  answerPointScores = null,
  answerPointsAnimate = false,
  answerPointsAnimKey = "",
}) {
  const left = projectorVoterChipEntries(votersForA);
  const right = projectorVoterChipEntries(votersForB);
  const authorAPlayer = authorAId && players ? players.find((p) => p.id === authorAId) : null;
  const authorBPlayer = authorBId && players ? players.find((p) => p.id === authorBId) : null;
  return (
    <div className={`projector-answers-row${rowClassName ? ` ${rowClassName}` : ""}`}>
      <div className="projector-answer-stack">
        <div
          className="projector-answer-panel"
          aria-label={showAuthors ? `Answer by ${authorAName}` : "Choice A"}
        >
          {showAuthors ? (
            <div
              className={`vote-distribution-author-wrap${
                authorsMuted ? " vote-distribution-author-wrap--muted" : ""
              }`}
            >
              {authorAPlayer ? (
                <PlayerElement
                  name={authorAPlayer.name}
                  iconKey={authorAPlayer.iconKey}
                  playerId={authorAPlayer.id}
                  hostPlayerId={hostPlayerId}
                  variant="compact"
                />
              ) : (
                <p className="muted vote-distribution-author">{authorAName}</p>
              )}
            </div>
          ) : null}
          <p className="projector-answer-text">{answerA}</p>
        </div>
        <div className="projector-voters projector-voters--a" aria-label="Voters for this answer">
          {left.map((v) => (
            <PlayerElement
              key={v.key}
              name={v.name}
              iconKey={v.iconKey}
              playerId={v.id}
              hostPlayerId={hostPlayerId}
              variant="compact"
            />
          ))}
        </div>
        {answerPointScores != null && answerPointsAnimate ? (
          <ProjectorColumnPointReveal
            animKey={`${answerPointsAnimKey}-a`}
            base={answerPointScores.sideA.base}
            mogBonus={answerPointScores.sideA.mogBonus}
            alignEnd={false}
          />
        ) : null}
      </div>
      <div className="projector-answer-stack">
        <div
          className="projector-answer-panel"
          aria-label={showAuthors ? `Answer by ${authorBName}` : "Choice B"}
        >
          {showAuthors ? (
            <div
              className={`vote-distribution-author-wrap${
                authorsMuted ? " vote-distribution-author-wrap--muted" : ""
              }`}
            >
              {authorBPlayer ? (
                <PlayerElement
                  name={authorBPlayer.name}
                  iconKey={authorBPlayer.iconKey}
                  playerId={authorBPlayer.id}
                  hostPlayerId={hostPlayerId}
                  variant="compact"
                />
              ) : (
                <p className="muted vote-distribution-author">{authorBName}</p>
              )}
            </div>
          ) : null}
          <p className="projector-answer-text">{answerB}</p>
        </div>
        <div className="projector-voters projector-voters--b" aria-label="Voters for this answer">
          {right.map((v) => (
            <PlayerElement
              key={v.key}
              name={v.name}
              iconKey={v.iconKey}
              playerId={v.id}
              hostPlayerId={hostPlayerId}
              variant="compact"
            />
          ))}
        </div>
        {answerPointScores != null && answerPointsAnimate ? (
          <ProjectorColumnPointReveal
            animKey={`${answerPointsAnimKey}-b`}
            base={answerPointScores.sideB.base}
            mogBonus={answerPointScores.sideB.mogBonus}
            alignEnd
          />
        ) : null}
      </div>
    </div>
  );
}

export function ProjectorScoreDropBoard({ players, scores, phaseKey, hostPlayerId }) {
  const rows = useMemo(() => {
    const scoreRows = (players ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      iconKey: p.iconKey,
      score: Number(scores?.[p.id] ?? 0),
    }));
    scoreRows.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.name.localeCompare(b.name)));
    const uniqueScores = Array.from(new Set(scoreRows.map((r) => r.score)));
    const groupByScore = new Map(uniqueScores.map((s, i) => [s, i]));
    return scoreRows.map((r) => ({ ...r, group: groupByScore.get(r.score) ?? 0 }));
  }, [players, scores]);

  const [revealedGroup, setRevealedGroup] = useState(0);
  const [droppingIds, setDroppingIds] = useState([]);
  const dropClearTimerRef = useRef(null);

  useEffect(() => {
    setRevealedGroup(0);
    setDroppingIds([]);
  }, [phaseKey]);

  useEffect(() => {
    if (!rows.length) return undefined;
    const maxGroup = rows.reduce((max, r) => Math.max(max, r.group), -1);
    if (revealedGroup >= maxGroup) return undefined;
    const t = setTimeout(() => {
      const nextGroup = revealedGroup + 1;
      const nextDropIds = rows.filter((r) => r.group === nextGroup).map((r) => r.id);
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
  const orderedVisible = [...visibleRows].sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.name.localeCompare(b.name)
  );
  const topById = new Map(orderedVisible.map((r, i) => [r.id, i * 88]));

  return (
    <div className="projector-score-drop" aria-live="polite">
      <div className="projector-score-drop-stage" style={{ height: `${Math.max(rows.length, 1) * 88}px` }}>
        {orderedVisible.map((row) => (
          <div
            key={row.id}
            className={`projector-score-drop-row${droppingIds.includes(row.id) ? " is-dropping" : ""}`}
            style={{ top: `${topById.get(row.id) ?? 0}px` }}
          >
            <PlayerElement
              name={row.name}
              iconKey={row.iconKey}
              playerId={row.id}
              hostPlayerId={hostPlayerId}
              variant="compact"
            />
            <span className="projector-score-drop-value">{row.score.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function VoteDistribution({ breakdown, mog, projector, players = [], hostPlayerId }) {
  if (!breakdown) return null;
  const {
    promptText,
    answerAText,
    answerBText,
    authorAName,
    authorBName,
    authorAId,
    authorBId,
    votersForA,
    votersForB,
  } = breakdown;
  const authorAPlayer = authorAId && players.length ? players.find((p) => p.id === authorAId) : null;
  const authorBPlayer = authorBId && players.length ? players.find((p) => p.id === authorBId) : null;

  function voterNodes(voters) {
    if (!voters?.length) return <span className="muted">—</span>;
    const entries = projectorVoterChipEntries(voters);
    return (
      <span className="player-element-list">
        {entries.map((v) => (
          <PlayerElement
            key={v.key}
            name={v.name}
            iconKey={v.iconKey}
            playerId={v.id}
            hostPlayerId={hostPlayerId}
            variant="compact"
          />
        ))}
      </span>
    );
  }

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
        <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem", color: "var(--accent-dim)" }}>
          MOGGED — unanimous win for this round.
        </p>
      )}
      {projector ? (
        <ProjectorDualAnswerColumns
          showAuthors
          authorAName={authorAName}
          authorBName={authorBName}
          authorAId={authorAId}
          authorBId={authorBId}
          players={players}
          answerA={String(answerAText ?? "")}
          answerB={String(answerBText ?? "")}
          votersForA={votersForA ?? []}
          votersForB={votersForB ?? []}
          hostPlayerId={hostPlayerId}
          rowClassName="vote-distribution-projector-row"
        />
      ) : (
        <div style={{ display: "grid", gap: "0.85rem", gridTemplateColumns: "1fr 1fr" }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.75rem", minWidth: 0 }}>
            <div style={{ margin: "0 0 0.35rem" }}>
              {authorAPlayer ? (
                <PlayerElement
                  name={authorAPlayer.name}
                  iconKey={authorAPlayer.iconKey}
                  playerId={authorAPlayer.id}
                  hostPlayerId={hostPlayerId}
                  variant="compact"
                />
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  {authorAName}
                </p>
              )}
            </div>
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
              {voterNodes(votersForA)}
            </p>
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.75rem", minWidth: 0 }}>
            <div style={{ margin: "0 0 0.35rem" }}>
              {authorBPlayer ? (
                <PlayerElement
                  name={authorBPlayer.name}
                  iconKey={authorBPlayer.iconKey}
                  playerId={authorBPlayer.id}
                  hostPlayerId={hostPlayerId}
                  variant="compact"
                />
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  {authorBName}
                </p>
              )}
            </div>
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
              {voterNodes(votersForB)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
