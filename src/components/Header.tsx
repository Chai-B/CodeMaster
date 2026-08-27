import React from 'react';
import { Box, Text } from 'ink';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue';
import type { SessionStatusView } from '../util/parser';

interface HeaderProps {
  shortCwd: string;
  session: SessionStatusView | null;
}

const LOGO = [
  '  ▄████▄  ',
  ' ██       ',
  '  ▀████▀  ',
];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function Header({ shortCwd, session }: HeaderProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={BLUE_HI}
      marginX={1}
      marginTop={1}
      flexDirection="row"
      paddingX={1}
    >
      <Box flexDirection="column" width={12} paddingRight={1} alignItems="center">
        <Text bold color={BLUE_HI}>CodeMaster</Text>
        {LOGO.map((l, i) => <Text key={i} color={BLUE_HI}>{l}</Text>)}
        <Text color={MUTED}>Next</Text>
      </Box>

      <Box flexDirection="column" width={1}>
        {Array.from({ length: 5 }).map((_, i) => <Text key={i} color={BLUE_DIM}>│</Text>)}
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {session ? (
          <>
            <Box gap={2}>
              <Text color={MUTED}>Session</Text>
              <Text color={BLUE_HI}>{session.id}</Text>
              <Text color={MUTED}>·</Text>
              <Text color={BLUE_HI}>{session.status}</Text>
            </Box>
            <Box gap={2}>
              <Text color={MUTED}>Task</Text>
              <Text color={BLUE_HI}>{session.taskN}/{session.taskTotal}</Text>
              <Text color={MUTED}>·</Text>
              <Text color={MUTED}>Tokens</Text>
              <Text color={BLUE_HI}>{fmt(session.tokens)}/{fmt(session.tokenBudget)}</Text>
            </Box>
            <Box gap={2}>
              <Text color={MUTED}>Provider</Text>
              <Text color={BLUE}>{session.provider}</Text>
              {session.lastCheckpoint && <><Text color={MUTED}>·</Text><Text color={MUTED}>ckpt {session.lastCheckpoint}</Text></>}
            </Box>
          </>
        ) : (
          <>
            <Text bold color={BLUE_HI}>A persistent reasoning OS for AI engineering</Text>
            <Text color={BLUE_DIM}>{'─'.repeat(42)}</Text>
            <Text color={MUTED}>/new &lt;objective&gt;  to start a session</Text>
            <Text color={MUTED}>/help  for all commands</Text>
          </>
        )}
        <Text color={MUTED}>{shortCwd}</Text>
      </Box>
    </Box>
  );
}
