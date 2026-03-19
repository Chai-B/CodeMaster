import React from 'react';
import { Box, Text } from 'ink';
import { BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue.js';
import type { LogEntry } from '../utils/parser.js';

function LogLine({ entry: { type, text } }: { entry: LogEntry }) {
  if (type === 'plain' && !text.trim()) return null;

  switch (type) {
    // ── Main step (⏺) ──
    case 'step':
    case 'heading':
      return (
        <Box marginTop={1}>
          <Text bold color={BLUE_HI}>⏺ </Text>
          <Text bold>{text}</Text>
        </Box>
      );

    // ── Tool/agent calls (→ ← arrows) ──
    case 'tool':
      return (
        <Box>
          <Text color={BLUE_DIM}>  ⎿  </Text>
          <Text color={BLUE_HI}>{text}</Text>
        </Box>
      );

    // ── Success (✓) ──
    case 'success':
      return (
        <Box>
          <Text color={BLUE_DIM}>  ⎿  </Text>
          <Text color="#6DBF8B">✓ </Text>
          <Text>{text}</Text>
        </Box>
      );

    // ── Error (✗) ──
    case 'error':
      return (
        <Box>
          <Text color={BLUE_DIM}>  ⎿  </Text>
          <Text color="#C75D5D">✗ </Text>
          <Text color="#C75D5D">{text}</Text>
        </Box>
      );

    // ── Warning (⚠) ──
    case 'warn':
      return (
        <Box>
          <Text color={BLUE_DIM}>  ⎿  </Text>
          <Text color="#E8B86D">⚠ </Text>
          <Text color="#E8B86D">{text}</Text>
        </Box>
      );

    // ── Nested detail (level 1) ──
    case 'nested':
      return (
        <Box>
          <Text color={BLUE_DIM}>  ⎿  </Text>
          <Text>{text}</Text>
        </Box>
      );

    // ── Nested detail (level 2) ──
    case 'nested2':
      return (
        <Box>
          <Text color={BLUE_DIM}>     ⎿  </Text>
          <Text color={MUTED}>{text}</Text>
        </Box>
      );

    // ── Dim / deep detail ──
    case 'dim':
      return (
        <Box>
          <Text color={BLUE_DIM}>     ⎿  </Text>
          <Text color={MUTED}>{text}</Text>
        </Box>
      );

    // ── Separator ──
    case 'sep':
      return <Text> </Text>;

    // ── User input ──
    case 'user':
      return (
        <Box marginTop={1}>
          <Text bold color={BLUE_HI}>❯ </Text>
          <Text bold>{text}</Text>
        </Box>
      );

    // ── Default: nested style ──
    default:
      return (
        <Box>
          <Text color={BLUE_DIM}>  ⎿  </Text>
          <Text>{text}</Text>
        </Box>
      );
  }
}

export function MessageList({ logs }: { logs: LogEntry[] }) {
  return (
    <Box flexDirection="column">
      {logs.map((e) => <LogLine key={e.id} entry={e} />)}
    </Box>
  );
}
