import {
  User,
  Heart,
  Hourglass,
  Crown,
  Club,
  Castle,
  Gem,
  Rocket,
  Skull,
  Flame,
  Dumbbell,
} from "lucide-react";

/** Keys must match server PLAYER_ICON_KEYS in server/src/index.js */
export const PLAYER_ICON_MAP = {
  heart: Heart,
  hourglass: Hourglass,
  // lucide-react has no ChessQueen export; use Crown for queen slot.
  "chess-queen": Crown,
  club: Club,
  // lucide-react@0.468.0 has no ChessKnight export.
  "chess-knight": Castle,
  gem: Gem,
  rocket: Rocket,
  skull: Skull,
  flame: Flame,
  dumbbell: Dumbbell,
};

/**
 * @param {{ name: string; iconKey?: string; variant?: "default" | "compact"; className?: string }} props
 */
export function PlayerElement({ name, iconKey, variant = "default", className = "" }) {
  const Icon = (iconKey && PLAYER_ICON_MAP[iconKey]) || User;
  const rootClass =
    variant === "compact"
      ? `player-element player-element--compact${className ? ` ${className}` : ""}`
      : `player-element${className ? ` ${className}` : ""}`;

  return (
    <div className={rootClass}>
      <div className="player-element__icon-ring" aria-hidden>
        <Icon className="player-element__icon" />
      </div>
      <span className="player-element__name">{name}</span>
    </div>
  );
}
