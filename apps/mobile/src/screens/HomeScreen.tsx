import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BottomTabBar } from '../components';
import { HomeHeader } from '../features/home/HomeHeader';
import { colors } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';
import { LobbyScreen } from './LobbyScreen';
import { ProfileScreen } from './ProfileScreen';
import { TournamentsScreen } from './TournamentsScreen';

type Props = NativeStackScreenProps<AppStackParams, 'Home'>;

type TabId = 'cash' | 'tournaments' | 'profile';

const TABS: { id: TabId; label: string; glyph: string }[] = [
  { id: 'cash', label: 'Cash', glyph: '♠' },
  { id: 'tournaments', label: 'Tournaments', glyph: '♛' },
  { id: 'profile', label: 'Profile', glyph: '☺' },
];

/** The app's front door: who you are and your chips on top, the three areas
 * (Cash, Tournaments, Profile) one tap away along the bottom. */
export function HomeScreen({ navigation }: Props): JSX.Element {
  const [tab, setTab] = useState<TabId>('cash');

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.top} edges={['top']}>
        <HomeHeader onPressProfile={() => setTab('profile')} />
      </SafeAreaView>
      <View style={styles.content}>
        {tab === 'cash' ? <LobbyScreen navigation={navigation} /> : null}
        {tab === 'tournaments' ? <TournamentsScreen navigation={navigation} /> : null}
        {tab === 'profile' ? <ProfileScreen navigation={navigation} /> : null}
      </View>
      <BottomTabBar items={TABS} active={tab} onChange={setTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.goldSoft,
  },
  content: { flex: 1 },
});
