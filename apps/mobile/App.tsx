import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import { WIRE_PROTOCOL_VERSION } from '@river/shared-types';

type Health = 'checking' | 'online' | 'offline';

const apiBaseUrl =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? 'http://localhost:3000';

/**
 * Phase 1 placeholder screen. It proves the toolchain end-to-end:
 * Expo app -> shared-types package -> API health endpoint.
 * Real navigation + screens arrive in Phase 7.
 */
export default function App(): JSX.Element {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBaseUrl}/health/ready`, { signal: controller.signal })
      .then((r) => setHealth(r.ok ? 'online' : 'offline'))
      .catch(() => setHealth('offline'));
    return () => controller.abort();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>Project River</Text>
      <Text style={styles.subtitle}>
        Free-to-play poker · wire protocol v{WIRE_PROTOCOL_VERSION}
      </Text>

      <View style={styles.statusRow}>
        {health === 'checking' ? (
          <ActivityIndicator color="#8b5cf6" />
        ) : (
          <View style={[styles.dot, health === 'online' ? styles.dotOn : styles.dotOff]} />
        )}
        <Text style={styles.statusText}>API {health === 'checking' ? 'checking…' : health}</Text>
      </View>
      <Text style={styles.hint}>{apiBaseUrl}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b0b12',
    padding: 24,
  },
  title: { color: '#f5f5f7', fontSize: 32, fontWeight: '700' },
  subtitle: { color: '#a1a1aa', fontSize: 14, marginTop: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 32 },
  statusText: { color: '#e4e4e7', fontSize: 16 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: '#22c55e' },
  dotOff: { backgroundColor: '#ef4444' },
  hint: { color: '#52525b', fontSize: 12, marginTop: 8 },
});
