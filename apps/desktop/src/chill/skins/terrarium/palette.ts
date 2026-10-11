import { hash } from "../../model";

// Botanical colour families stay stable as projects appear, disappear or move.
// Rich greens anchor each family; warmer tips give the canopy a soft shimmer.
const PALETTES = [
  [0x48b99a, 0x7ed6ae, 0xc5dc84, 0xf0c78d], // jade and honey
  [0x67bcae, 0x97cfbe, 0xc3a6dc, 0xe4b3d2], // sea glass and lilac
  [0x80bd70, 0xb6d78c, 0xe8b17e, 0xec9b98], // meadow and apricot
  [0x71b4c2, 0x96d1cf, 0x9db5de, 0xc7b0e2], // lagoon and periwinkle
  [0x65ad8f, 0xa0d29d, 0xe5c883, 0xe4a2bd], // fern and rose
  [0x82c4ad, 0xa7dab1, 0xd5d78d, 0xf0b7a0], // mint and peach
] as const;

export function plantPalette(id: string): readonly number[] {
  return PALETTES[hash(id) % PALETTES.length]!;
}

export function cssColour(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}
