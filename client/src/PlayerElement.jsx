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

const HOST_COLOR = "#FFD447";
const PLAYER_PALETTE = [
  "#8FBC8F",
  "#C8F135",
  "#5DD4F0",
  "#FF7B6B",
  "#C4A8FF",
  "#FFAC6B",
  "#FF6EC7",
  "#A8E6FF",
  "#F0EDD8",
];

/** Keep non-host colors unique by binding each server-assigned icon key to a fixed palette slot. */
const ICON_COLOR_MAP = {
  heart: PLAYER_PALETTE[0],
  hourglass: PLAYER_PALETTE[1],
  club: PLAYER_PALETTE[2],
  "chess-knight": PLAYER_PALETTE[3],
  gem: PLAYER_PALETTE[4],
  rocket: PLAYER_PALETTE[5],
  skull: PLAYER_PALETTE[6],
  flame: PLAYER_PALETTE[7],
  dumbbell: PLAYER_PALETTE[8],
};

/**
 * @param {{ name: string; iconKey?: string; variant?: "default" | "compact"; className?: string; playerId?: string; hostPlayerId?: string }} props
 */
export function PlayerElement({
  name,
  iconKey,
  variant = "default",
  className = "",
  playerId,
  hostPlayerId,
}) {
  const Icon = (iconKey && PLAYER_ICON_MAP[iconKey]) || User;
  const rootClass =
    variant === "compact"
      ? `player-element player-element--compact${className ? ` ${className}` : ""}`
      : `player-element${className ? ` ${className}` : ""}`;
  const backgroundColor =
    playerId && hostPlayerId && playerId === hostPlayerId
      ? HOST_COLOR
      : ICON_COLOR_MAP[iconKey] || PLAYER_PALETTE[0];

  return (
    <div className={rootClass} style={{ backgroundColor }}>
      <div className="player-element__icon-ring" aria-hidden>
        <Icon className="player-element__icon" />
      </div>
      <span className="player-element__name">{name}</span>
    </div>
  );
}
