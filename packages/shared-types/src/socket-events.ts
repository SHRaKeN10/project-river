/** Canonical WebSocket event names. Import these constants everywhere - never
 * type the string literal by hand. */

export const ClientToServer = {
  TABLE_JOIN: 'table:join',
  TABLE_LEAVE: 'table:leave',
  PLAYER_ACTION: 'player:action',
  PLAYER_READY: 'player:ready',
  PLAYER_SIT_OUT: 'player:sitOut',
  PLAYER_RETURN: 'player:return',
  TABLE_CHAT: 'table:chat',
} as const;

export const ServerToClient = {
  TABLE_STATE: 'table:state',
  TABLE_UPDATE: 'table:update',
  HAND_START: 'hand:start',
  HAND_UPDATE: 'hand:update',
  HAND_END: 'hand:end',
  PLAYER_JOINED: 'player:joined',
  PLAYER_LEFT: 'player:left',
  PLAYER_DISCONNECTED: 'player:disconnected',
  PLAYER_RECONNECTED: 'player:reconnected',
  ACTION_PROMPT: 'action:prompt',
  ERROR: 'error',
} as const;

export type ClientToServerEvent = (typeof ClientToServer)[keyof typeof ClientToServer];
export type ServerToClientEvent = (typeof ServerToClient)[keyof typeof ServerToClient];
