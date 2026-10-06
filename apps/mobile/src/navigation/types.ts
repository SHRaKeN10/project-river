import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

export type AuthStackParams = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
  /** `email` is carried from ForgotPassword so the confirm screen can name the
   * account being reset. */
  ResetPassword: { email?: string } | undefined;
};

export type AppStackParams = {
  /** The tabbed front door: Cash, Tournaments, Profile. */
  Home: undefined;
  Table: {
    tableId: string;
    /** A seat held for this user by the waitlist (ADR-0031) - the buy-in sheet
     * opens straight onto it. */
    claimSeat?: number;
  };
  TournamentDetail: { tournamentId: string };
  TournamentTable: { tournamentId: string };
  Settings: undefined;
};

/** What the screens embedded in the Home tabs need from the stack navigator. */
export type AppNavigation = Pick<NativeStackNavigationProp<AppStackParams>, 'navigate'>;
