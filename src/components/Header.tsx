import React from 'react';
import { Box, Text } from 'ink';
import { BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue.js';

interface HeaderProps {
  shortCwd: string;
  recent: { task: string; time: string }[];
}

const LOGO = [
  '      ▄████▄      ',
  '     ██           ',
  '      ▀████▀      ',
];

export function Header({ shortCwd, recent }: HeaderProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={BLUE_HI}
      marginLeft={1}
      marginRight={1}
      marginTop={1}
      flexDirection="row"
      paddingX={1}
    >
      {/* Left: branding */}
      <Box flexDirection="column" width={22} paddingRight={2} alignItems="center">
        <Text bold color={BLUE_HI}>CodeMaster</Text>
        <Text> </Text>
        {LOGO.map((line, i) => <Text key={i} color={BLUE_HI}>{line}</Text>)}
        <Text> </Text>
        <Text color={MUTED}>{shortCwd}</Text>
      </Box>

      {/* Divider */}
      <Box flexDirection="column" width={1}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Text key={i} color={BLUE_DIM}>│</Text>
        ))}
      </Box>

      {/* Right: tips + recent */}
      <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
        <Text bold color={BLUE_HI}>Tips</Text>
        <Text color={BLUE_DIM}>{'─'.repeat(38)}</Text>
        <Text color={MUTED}>Type a task to run the full pipeline</Text>
        <Text color={MUTED}>/help for commands  ·  /prompts to edit agents</Text>
        <Text> </Text>
        <Text bold color={BLUE_HI}>Recent</Text>
        <Text color={BLUE_DIM}>{'─'.repeat(38)}</Text>
        {recent.length === 0
          ? <Text color={MUTED}>No recent activity</Text>
          : recent.map((e, i) => (
            <Text key={i} color={MUTED}>{e.time}  {e.task}</Text>
          ))
        }
      </Box>
    </Box>
  );
}
