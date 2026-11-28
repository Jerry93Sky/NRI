import type { Socket } from 'socket.io';

const commandsPerMinute = new Map([
  ['campaign:join', 60],
  ['campaign:leave', 60],
  ['scene:pointer', 1200],
  ['token:move', 180],
  ['chat:send', 120],
  ['dice:roll', 120],
]);

export function guardCommands(socket: Socket) {
  const windows = new Map<string, { until: number; used: number }>();
  socket.use(([event, ...args], next) => {
    const max = commandsPerMinute.get(event);
    if (!max) return;
    const last = args.at(-1);
    const acknowledge = typeof last === 'function' ? last : undefined;
    if (args.length !== (acknowledge ? 2 : 1)) {
      acknowledge?.({ error: 'INVALID' });
      return;
    }
    const now = Date.now();
    let window = windows.get(event);
    if (!window || window.until <= now) {
      window = { until: now + 60_000, used: 0 };
      windows.set(event, window);
    }
    if (window.used >= max) {
      acknowledge?.({ error: 'RATE_LIMITED' });
      return;
    }
    window.used++;
    next();
  });
}
