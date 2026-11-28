import type { Server } from 'socket.io';
import { cookieName } from '../config/runtime.js';
import { activeSession, digest } from '../security/access.js';

const sessionRoom = (tokenHash: string) => `session:${tokenHash}`;
export type SocketSession = { tokenHash: string; expiresAt: number };

export function disconnectSession(io: Server, tokenHash: string) {
  io.in(sessionRoom(tokenHash)).disconnectSockets(true);
}

export function authenticateRealtime(io: Server) {
  io.use(async (socket, next) => {
    try {
      const cookie = socket.handshake.headers.cookie ?? '';
      const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!token) return next(new Error('UNAUTHENTICATED'));
      const tokenHash = digest(decodeURIComponent(token));
      const session = await activeSession(tokenHash);
      if (!session) return next(new Error('UNAUTHENTICATED'));

      const { id, displayName } = session.user;
      socket.data.user = { id, displayName };
      socket.data.session = { tokenHash, expiresAt: session.expiresAt.getTime() } satisfies SocketSession;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });
  io.on('connection', (socket) => {
    const { tokenHash, expiresAt } = socket.data.session as SocketSession;
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, expiresAt - Date.now()));
    expiryTimer.unref();
    socket.once('disconnect', () => clearTimeout(expiryTimer));

    // Recheck after joining the revocation room to cover concurrent logout and handshake.
    const authorized = Promise.resolve(socket.join(sessionRoom(tokenHash))).then(async () => {
      if (!socket.connected || !await activeSession(tokenHash) || !socket.connected) return false;
      await socket.join(`user:${socket.data.user.id}`);
      return true;
    }).catch(() => false).then((allowed) => {
      if (!allowed) socket.disconnect(true);
      return allowed;
    });
    socket.use((_packet, resume) => {
      void authorized.then((allowed) => {
        if (allowed && socket.connected && Date.now() < expiresAt) resume();
      });
    });
  });
}
