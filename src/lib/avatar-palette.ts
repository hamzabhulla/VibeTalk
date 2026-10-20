// Mockup avatar palette (2026-10-20 desktop redesign): soft pastel
// tile + deep ink initials, picked deterministically by name so a
// person keeps their colour across People / Calls / chat list.
export const AV_PALETTES = [
  "bg-[#fdeeda] text-[#b45309]",
  "bg-[#e3e9fd] text-[#3b4ba8]",
  "bg-[#e7e2f5] text-[#6d4fa1]",
  "bg-[#fde2e2] text-[#b91c1c]",
  "bg-[#dcefe2] text-[#15803d]",
] as const;

export function paletteFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_PALETTES[h % AV_PALETTES.length];
}
