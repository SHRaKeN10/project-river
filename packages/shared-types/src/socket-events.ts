/** Canonical WebSocket event names. Import these constants everywhere - never
 * type the string literal by hand. */

export const ClientToServer = {
  /** Enter a table room as a spectator (no seat, no buy-in). */
  TABLE_WATCH: 'table:watch',
  TABLE_UNWATCH: 'table:unwatch',
  TABLE_JOIN: 'table:join',
  TABLE_LEAVE: 'table:leave',
  PLAYER_ACTION: 'player:action',
  PLAYER_READY: 'player:ready',
  PLAYER_SIT_OUT: 'player:sitOut',
  PLAYER_RETURN: 'player:return',
  /** Arm / disarm the UTG straddle for your next under-the-gun turn (ADR-0027). */
  PLAYER_STRADDLE: 'player:straddle',
  TABLE_CHAT: 'table:chat',

  /** Watch a tournament: the server routes you to your own table (or, if you
   * hold no seat, to the feature table as a spectator). */
  TOURNAMENT_WATCH: 'tournament:watch',
  TOURNAMENT_UNWATCH: 'tournament:unwatch',
  /** Act on your current tournament hand. The server knows which table. */
  TOURNAMENT_ACTION: 'tournament:action',
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
  /** A seat's flat time charge fired (membership-club billing, not a pot rake). */
  TIME_CHARGE: 'table:timeCharge',

  /** An authoritative tournament level-clock snapshot: on watch, on every blind
   * change, and after each hand-for-hand round. The client runs a local
   * countdown between these and never broadcasts per second. */
  TOURNAMENT_CLOCK: 'tournament:clock',
  /** Your seat in a tournament changed (initial draw, or a balance move). The
   * `table:state` that follows carries the new table. */
  TOURNAMENT_ASSIGNMENT: 'tournament:assignment',
  /** You busted. Carries your finishing position. */
  TOURNAMENT_ELIMINATED: 'tournament:eliminated',
  /** A tournament table dissolved (broke / the event ended). */
  TOURNAMENT_TABLE_CLOSED: 'tournament:tableClosed',
  /** The tournament is over. Carries the final standings. */
  TOURNAMENT_FINISHED: 'tournament:finished',
} as const;

export type ClientToServerEvent = (typeof ClientToServer)[keyof typeof ClientToServer];
export type ServerToClientEvent = (typeof ServerToClient)[keyof typeof ServerToClient];
