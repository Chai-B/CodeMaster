import React from 'react';
import { Box, Static, Text, useStdout } from 'ink';
import { LogEntry } from '../util/parser';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue';

/**
 * Settled lines are written once and scroll natively; only the live region
 * repaints.
 *
 * Every log line used to re-render on every bus event, and once output passed
 * the terminal height Ink's frame diffing tore visibly — the flicker. `<Static>`
 * hands a settled line to the terminal exactly once, so a long run costs one
 * write per line instead of one per line per event.
 */
export function MessageList({ settled, live, clearGen }: { settled: LogEntry[]; live: LogEntry[]; clearGen: number }) {
  return (
    <>
      <Static key={clearGen} items={settled}>
        {(e) => <LogLine key={e.id} entry={e} />}
      </Static>
      {live.length > 0 && (
        <Box flexDirection="column">
          {live.map((e) => <LogLine key={e.id} entry={e} />)}
        </Box>
      )}
    </>
  );
}

function Rule() {
  const { stdout } = useStdout();
  const width = Math.max(12, Math.min((stdout?.columns ?? 80) - 4, 96));
  return <Text color={BLUE_DIM}>  {'─'.repeat(width)}</Text>;
}

function LogLine({ entry: { type, text } }: { entry: LogEntry }) {
  if (type === 'plain' && !text.trim()) return <Text> </Text>;

  switch (type) {
    case 'tool': return <Box><Text bold color={BLUE}>  ►► </Text><Text color={BLUE_HI}>{text}</Text></Box>;
    case 'success': return <Box><Text color={BLUE_HI}>  ✓  </Text><Text>{text}</Text></Box>;
    case 'error': return <Box><Text color="#994C4C">  ✗  </Text><Text color="#994C4C">{text}</Text></Box>;
    case 'warn': return <Box><Text color={BLUE_HI}>  ⚠  </Text><Text color={BLUE_HI}>{text}</Text></Box>;
    case 'dim': return <Box><Text color={MUTED}>{'     '}</Text><Text color={MUTED}>{text}</Text></Box>;
    case 'reasoning': return <Box><Text color={BLUE_HI}>  ◆  </Text><Text color={BLUE}>{text}</Text></Box>;
    case 'sep': return <Rule />;
    case 'heading': return <Box flexDirection="column"><Text> </Text><Text bold color={BLUE_HI}>  {text}</Text></Box>;
    case 'user': return <Box marginTop={1}><Text bold color={BLUE_HI}>  ❯ </Text><Text bold>{text}</Text></Box>;
    default: return <Box><Text>{'  '}</Text><Text>{text}</Text></Box>;
  }
}
