import { useEffect, useState } from "react";
import { duckBgm, playSfx } from "../../audio/engine.js";

export function MogOverlay({ payload, onDone, playSound = false }) {
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
    duckBgm({ targetVolume: 0.1, attackMs: 100, holdMs: 2400, releaseMs: 400 });
    playSfx("mogged", { volume: 1, allowOverlap: false, ignoreMaster: true });
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
      </div>
    </div>
  );
}

export function NextVoteSplash({ active, text = "Get ready to vote..." }) {
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

export function ChudOverlay({ payload, onDone }) {
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
      </div>
    </div>
  );
}

export function BothFoldOverlay({ payload, onDone }) {
  const [crossedOut, setCrossedOut] = useState(false);
  const visiblePlayers =
    payload?.foldedAuthorIds?.length === 1
      ? payload.players.filter((player) => payload.foldedAuthorIds.includes(player.id))
      : payload?.players ?? [];

  useEffect(() => {
    if (!payload) return undefined;
    setCrossedOut(false);
    const now = Date.now();
    const crossDelay = Math.max(0, payload.startsAt + 2000 - now);
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
              <span className="both-fold-name-inner">{player.name}</span>
              <span className="both-fold-subhuman">subhuman</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
