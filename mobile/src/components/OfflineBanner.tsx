// A bar under the top bar of every signed-in screen that says what the phone is doing with the connection:
//   offline            -> "You're offline. What you enter is saved on this phone and sent when you're back online." (and how many are waiting)
//   sending            -> "Sending your saved changes..."
//   something refused  -> "1 saved change needs your attention"
//   signed out         -> "Please sign in again to send your saved changes."
// A tap opens the list of saved changes. When all is well and nothing waits, it takes no room at all.
import { router } from 'expo-router';
import React from 'react';
import { Pressable } from 'react-native';
import { ActivityIndicator, Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useOnline } from '@/lib/network';
import { useOutbox } from '@/lib/offline';
import { brand } from '@/theme';

export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  const { pending, failed, sending, authBlocked } = useOutbox();
  if (online && pending === 0 && failed === 0 && !authBlocked) return null;

  let tone = { bg: brand.amber100, fg: '#7C4A03', icon: 'clock-outline' };
  let text = t('offline.waiting', { count: pending });
  let busy = false;
  if (authBlocked) { tone = { bg: brand.red100, fg: '#8A1C14', icon: 'account-alert-outline' }; text = t('offline.signIn'); }
  else if (!online) { tone = { bg: brand.amber100, fg: '#7C4A03', icon: 'cloud-off-outline' }; text = pending > 0 ? `${t('offline.banner')} ${t('offline.waiting', { count: pending })}.` : t('offline.banner'); }
  else if (failed > 0) { tone = { bg: brand.red100, fg: '#8A1C14', icon: 'alert-circle-outline' }; text = t('offline.attention', { count: failed }); }
  else if (sending) { tone = { bg: brand.blue100, fg: '#00346F', icon: 'cloud-sync-outline' }; text = t('offline.sending'); busy = true; }

  return (
    <Pressable onPress={() => router.push('/sync')} accessibilityRole="button" accessibilityLabel={text} testID="offline-banner"
               style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 16, backgroundColor: tone.bg }}>
      {busy ? <ActivityIndicator size={18} color={tone.fg} /> : <Icon source={tone.icon} size={20} color={tone.fg} />}
      <Text style={{ flex: 1, color: tone.fg, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>{text}</Text>
      <Icon source="chevron-right" size={18} color={tone.fg} />
    </Pressable>
  );
}
