import React from 'react';
import { Box, Text } from 'ink';
import { LogEntry } from '../utils/parser';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue';

export function MessageList({ logs }: { logs: LogEntry[] }) {
  return (
    <Box flexDirection="column">
      {logs.map((e) => <LogLine key={e.id} entry={e} />)}
    </Box>
  );
}

function LogLine({ entry: { type, text } }: { entry: LogEntry }) {
  if (type === 'plain' && !text.trim()) return <Text> </Text>;

  switch (type) {
    case 'tool':    return <Box><Text bold color={BLUE}>  ►► </Text><Text color={BLUE_HI}>{text}</Text></Box>;
    case 'success': return <Box><Text color={BLUE_HI}>  ✓  </Text><Text>{text}</Text></Box>;
    case 'error':   return <Box><Text color="#994C4C">  ✗  </Text><Text color="#994C4C">{text}</Text></Box>;
    case 'warn':    return <Box><Text color={BLUE_HI}>  ⚠  </Text><Text color={BLUE_HI}>{text}</Text></Box>;
    case 'dim':     return <Text color={MUTED}>{'     '}{text}</Text>;
    case 'sep':     return <Text color={BLUE_DIM}>  {'─'.repeat(56)}</Text>;
    case 'heading': return <Box flexDirection="column"><Text> </Text><Text bold color={BLUE_HI}>  {text}</Text></Box>;
    case 'user':    return <Box flexDirection="column" marginTop={1}><Text bold color={BLUE_HI}>You</Text><Text>{text}</Text></Box>;
    default:        return <Text>  {text}</Text>;
  }
}
