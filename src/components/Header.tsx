import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { BLUE_HI, BLUE_DIM, MUTED, LOGO } from '../themes/blue.js';

const TAGLINE = 'Describe what you want done, or /help for commands.';

/** The startup card: the C, the wordmark, where you are.
 *
 *  Printed once into the terminal's scrollback as the first line of the
 *  transcript, not repainted forever at the top of a pinned frame. The seven-row
 *  bordered banner this replaced spent its right half repeating what the status
 *  bar already said, and cost those rows on every single frame. */
export function Banner({ shortCwd, version }: { shortCwd: string; version: string }) {
  const { stdout } = useStdout();
  const cols = Math.max(28, stdout?.columns ?? 80);
  // Border, padding and margin take eight columns before a glyph is drawn; the
  // mark takes ten more. A narrow window keeps the words and drops the mark.
  const inner = cols - 8;
  const mark = inner >= LOGO[0]!.length + 24;
  const text = Math.max(8, inner - (mark ? LOGO[0]!.length + 2 : 0));

  return (
    <Box alignSelf="flex-start" borderStyle="round" borderColor={BLUE_DIM} paddingX={2} marginX={1}>
      {mark && (
        <Box flexDirection="column" flexShrink={0} marginRight={2}>
          {LOGO.map((l, i) => <Text key={i} color={BLUE_HI} bold>{l}</Text>)}
        </Box>
      )}
      <Box flexDirection="column" width={text}>
        <Box>
          <Text bold color={BLUE_HI}>CodeMaster</Text>
          <Text color={MUTED}>{`  v${version}`}</Text>
        </Box>
        <Text color={MUTED} wrap="truncate-middle">{shortCwd}</Text>
        <Text color={BLUE_DIM} wrap="truncate-end">{TAGLINE}</Text>
      </Box>
    </Box>
  );
}
