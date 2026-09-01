/**
 * Design tokens. Dark, premium, minimal - not a casino skin. Consumed via
 * plain StyleSheet for now; a styling system (NativeWind) can be layered on
 * later without changing these values.
 */
export const colors = {
  bg: '#0b0f14',
  surface: '#141b23',
  surfaceAlt: '#1c2530',
  border: '#243040',
  felt: '#0c3b2e',
  feltRail: '#08251d',

  textPrimary: '#f2f5f7',
  textSecondary: '#9fb0bf',
  textMuted: '#5f7385',

  accent: '#e8b923', // chip gold
  accentText: '#1a1400',
  info: '#3b82f6',
  success: '#22c55e',
  danger: '#ef4444',
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
