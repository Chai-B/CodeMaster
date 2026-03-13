import React from 'react';
import { Box, Text } from 'ink';
import { BLUE_HI, BLUE_DIM, BLUE, MUTED } from '../themes/blue';

export interface Cmd { cmd: string; desc: string }

export function Autocomplete({ options, selectedIndex }: { options: Cmd[]; selectedIndex: number }) {
  if (!options.length) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BLUE_DIM} paddingX={1} marginX={1}>
      {options.map((opt, i) => (
        <Box key={opt.cmd}>
          <Text color={i === selectedIndex ? BLUE_HI : BLUE} bold={i === selectedIndex}>
            {i === selectedIndex ? '❯ ' : '  '}{opt.cmd.padEnd(12)}
          </Text>
          <Text color={MUTED}>{opt.desc}</Text>
        </Box>
      ))}
    </Box>
  );
}
