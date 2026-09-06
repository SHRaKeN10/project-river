export type AuthStackParams = {
  Login: undefined;
  Register: undefined;
};

export type AppStackParams = {
  Home: undefined;
  Lobby: undefined;
  Table: { tableId: string };
  Tournaments: undefined;
  TournamentDetail: { tournamentId: string };
  TournamentTable: { tournamentId: string };
  Profile: undefined;
  Settings: undefined;
};
