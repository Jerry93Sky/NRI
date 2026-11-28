import type { Server, Socket } from 'socket.io';

export const campaignMemberRoom = (campaignId: string, userId: string) => `campaign:${campaignId}:member:${userId}`;

export function leaveCampaign(socket: Socket, campaignId: string, userId: string) {
  void socket.leave(`campaign:${campaignId}`);
  void socket.leave(`campaign:${campaignId}:gm`);
  void socket.leave(campaignMemberRoom(campaignId, userId));
}

export function archiveCampaignSockets(io: Server, campaignId: string) {
  const room = `campaign:${campaignId}`;
  io.to(room).emit('campaign:archived', { campaignId });
  for (const id of io.sockets.adapter.rooms.get(room) ?? []) {
    const socket = io.sockets.sockets.get(id);
    if (socket) leaveCampaign(socket, campaignId, socket.data.user.id);
  }
}
