export type AuthStackParams = {
  Login: undefined;
  Register: undefined;
};

export type AppStackParams = {
  Home: undefined;
  Lobby: undefined;
  Table: {
    tableId: string;
    /** A seat held for this user by the waitlist (ADR-0031) - the buy-in sheet
     * opens straight onto it. */
    claimSeat?: number;
  };
  Tournaments: undefined;
  TournamentDetail: { tournamentId: string };
  TournamentTable: { tournamentId: string };
  Profile: undefined;
  Settings: undefined;
};
