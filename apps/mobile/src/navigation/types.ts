export type AuthStackParams = {
  Login: undefined;
  Register: undefined;
};

export type AppStackParams = {
  Home: undefined;
  Lobby: undefined;
  Table: { tableId: string };
  Profile: undefined;
  Settings: undefined;
};
