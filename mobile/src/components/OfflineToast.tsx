// The message from lib/toast.ts, drawn above the tab bar.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/lib/toast';
import { radius } from '@/theme';

export function OfflineToast() {
  const message = useToast();
  const insets = useSafeAreaInsets();
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: 76 + insets.bottom }]} accessibilityLiveRegion="polite" testID="toast">
      <View style={styles.pill}>
        <Icon source="content-save-check-outline" size={20} color="#fff" />
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#1F2A24', borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 16, maxWidth: 520 },
  text: { color: '#fff', fontSize: 14, lineHeight: 20, fontWeight: '600', flexShrink: 1 },
});
