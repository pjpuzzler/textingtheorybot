interface EloColorStop {
  elo: number;
  color: { r: number; g: number; b: number };
  hex: string;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => ("0" + Math.round(c).toString(16)).slice(-2);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const ELO_COLOR_STOPS_DATA: { elo: number; name: string; hex: string }[] = [
  { elo: 200, name: "megablunder", hex: "#6C040C" },
  { elo: 400, name: "blunder", hex: "#FA412D" },
  { elo: 600, name: "mistake", hex: "#FFA459" },
  { elo: 800, name: "inaccuracy", hex: "#F7C631" },
  { elo: 1000, name: "good", hex: "#95B776" },
  { elo: 1200, name: "excellent", hex: "#80B64B" },
  { elo: 1400, name: "best", hex: "#80B64B" },
  { elo: 1600, name: "great", hex: "#749BBF" },
  { elo: 1800, name: "brilliant", hex: "#27C2A3" },
  { elo: 2000, name: "superbrilliant", hex: "#E273E7" },
];

const ELO_COLOR_STOPS: EloColorStop[] = ELO_COLOR_STOPS_DATA.map((stop) => ({
  elo: stop.elo,
  color: hexToRgb(stop.hex),
  hex: stop.hex,
}));

export function getEloColor(elo: number): string {
  const minElo = ELO_COLOR_STOPS[0].elo;
  const maxElo = ELO_COLOR_STOPS[ELO_COLOR_STOPS.length - 1].elo;
  const clampedElo = Math.max(minElo, Math.min(elo, maxElo));

  const endStopIndex = ELO_COLOR_STOPS.findIndex(
    (stop) => stop.elo >= clampedElo
  );

  if (endStopIndex === 0) {
    return ELO_COLOR_STOPS[0].hex;
  }

  const startStop = ELO_COLOR_STOPS[endStopIndex - 1];
  const endStop = ELO_COLOR_STOPS[endStopIndex];

  if (startStop.hex === endStop.hex) {
    return startStop.hex;
  }

  const eloRange = endStop.elo - startStop.elo;
  const progress = eloRange === 0 ? 1 : (clampedElo - startStop.elo) / eloRange;

  const r =
    startStop.color.r + (endStop.color.r - startStop.color.r) * progress;
  const g =
    startStop.color.g + (endStop.color.g - startStop.color.g) * progress;
  const b =
    startStop.color.b + (endStop.color.b - startStop.color.b) * progress;

  return rgbToHex(r, g, b);
}
