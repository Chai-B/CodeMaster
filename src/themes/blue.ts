/**
 * Every colour here clears 3:1 contrast against both a black and a white
 * terminal background, so the interface stays legible whichever the user runs.
 * The palette this replaced did not: its two workhorse greys sat at 2.4:1 and
 * 2.8:1 on a dark background, and its bright accent at 2.7:1 on a light one.
 *
 * Hierarchy comes from hue and weight rather than from luminance, because the
 * band that satisfies both backgrounds is too narrow to hold a light-to-dark
 * ramp. BLUE_HI and BLUE_DIM are the two deliberate exceptions — one is only
 * ever bold and short, the other only ever draws rules.
 */
export const BLUE = '#4A7FBF';      // 4.1 : 5.1 — primary accent
export const BLUE_HI = '#6FA8DC';   // bold glyphs, wordmark, selection
export const BLUE_DIM = '#4A5361';  // rules and borders only
export const MUTED = '#6E7B8B';     // 4.3 : 4.9 — secondary text
export const GREEN = '#3F9668';     // 3.6 : 5.8 — success
export const RED = '#B85450';       // 4.8 : 4.4 — failure
export const AMBER = '#A87C30';     // 3.9 : 5.4 — warning
export const VIOLET = '#8E76BF';    // 3.8 : 5.5 — recorded reasoning

/** U+26A0 and U+23FA measure two columns wide and knock the gutter out of
 *  alignment, so every marker below is a one-column character — `●` stands in
 *  for the two-column `⏺`, and `!` for the two-column `⚠`. */
export const GLYPH = {
  tool: '●',
  result: '⎿',
  success: '✓',
  error: '✗',
  warn: '!',
  reasoning: '◇',
  user: '❯',
} as const;

/** The C, drawn in half-blocks. Rendered beside the wordmark at startup. */
export const LOGO = [
  ' ▄████▄ ',
  '██      ',
  ' ▀████▀ ',
];

/** The spinner cycles a word as well as a frame, so a long wait reads as
 *  something happening rather than as one frozen label. */
export const VERBS = ['Thinking', 'Reasoning', 'Composing', 'Weighing', 'Tracing', 'Refining'];

export const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
