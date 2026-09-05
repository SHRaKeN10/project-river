/**
 * Design tokens. Black-and-gold casino palette matched to Palace Poker
 * (palacepoker.com) for the pitch build - warm near-black grounds, their
 * brass gold as the primary accent, and a deep casino red for danger states.
 * Values pulled from their site's own theme variables, not eyeballed:
 * gold #c2a152, red #8b0000, black #000/#222. The felt runs near-black with
 * a gold rail instead of the usual green-table look. Consumed via plain
 * StyleSheet for now; a styling system (NativeWind) can be layered on later
 * without changing these values.
 */
export const colors = {
  bg: '#0d0d0c',
  surface: '#1a1917',
  surfaceAlt: '#242320',
  border: '#332e22',
  felt: '#12120f',
  feltRail: '#c2a152', // brand gold rail, in place of a felt-green edge

  textPrimary: '#f5f1e8',
  textSecondary: '#b8b0a0',
  textMuted: '#7a7263',

  accent: '#c2a152', // Palace Poker brass gold
  accentText: '#171206',
  info: '#3b82f6',
  success: '#22c55e',
  danger: '#c0392b', // deep casino red, brightened off their #8b0000 for contrast on near-black
  warning: '#f59e0b',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const typography = {
  h1: { fontSize: 30, fontWeight: '700' as const },
  h2: { fontSize: 22, fontWeight: '700' as const },
  h3: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
} as const;
