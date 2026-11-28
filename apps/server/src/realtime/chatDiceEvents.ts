import type { Server, Socket } from 'socket.io';
import type { sendChat, rollDice } from '../modules/chat/commands.js';
import { withCampaignAudience } from './campaignAudience.js';

type Message = Extract<Awaited<ReturnType<typeof sendChat>>, { message: unknown }>['message'];
type Roll = Extract<Awaited<ReturnType<typeof rollDice>>, { roll: unknown }>['roll'];

type Ack = ((result: unknown) => void) | undefined;

export async function publishChat(io: Server, message: Message, displayName: string, sender: Socket, ack: Ack, replayed = false) {
  const { campaignId, senderId, recipientId } = message;
  const acknowledged = await withCampaignAudience(io, campaignId, async (_tx, scope) => {
    const event = recipientId ? 'chat:private' : 'chat:message';
    const payload = { ...message, displayName, private: Boolean(recipientId) };
    let sent = false;
    for (const recipient of scope.recipients) {
      if (!scope.canSend(recipient)) continue;
      if (recipient.socket === sender && recipient.userId === senderId && sender.rooms.has(`campaign:${campaignId}`)) {
        ack?.({ ok: true, message: payload });
        sent = true;
      }
      if (!replayed) recipient.socket.emit(event, payload);
    }
    return sent;
  }, recipientId ? [senderId, recipientId] : undefined);
  if (!acknowledged) ack?.({ error: 'FORBIDDEN' });
}

export async function publishRoll(io: Server, roll: Roll, displayName: string, sender: Socket, ack: Ack, replayed = false) {
  const acknowledged = await withCampaignAudience(io, roll.campaignId, async (_tx, scope) => {
    const payload = { ...roll, displayName };
    let sent = false;
    for (const recipient of scope.recipients) {
      if (!scope.canSend(recipient) || (roll.hidden && recipient.role === 'PLAYER')) continue;
      if (recipient.socket === sender && recipient.userId === roll.userId) {
        ack?.({ ok: true, roll: payload });
        sent = true;
      }
      if (!replayed) recipient.socket.emit('dice:result', payload);
    }
    return sent;
  });
  if (!acknowledged) ack?.({ error: 'FORBIDDEN' });
}
