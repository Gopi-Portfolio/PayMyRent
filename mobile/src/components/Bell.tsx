// The notification bell in the top bar: a red number shows how many things are new since the person last opened the list.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export function BellButton() {
  const { t } = useTranslation();
  const { me, activeRole } = useAuth();
  const role = activeRole ?? me?.roles[0] ?? 'tenant';       // the list follows the role in use: an owner's news is not shown while being a renter
  const q = useQuery({ queryKey: ['notifications', role], refetchInterval: 30000, queryFn: () => api<any>(`/api/v1/me/notifications?role=${role}`) });
  const unread = Number(q.data?.unread ?? 0);
  return (
    <Pressable onPress={() => router.push('/notifications')} accessibilityRole="button" testID="bell" hitSlop={10}
               accessibilityLabel={unread > 0 ? t('notifications.bellUnread', { count: unread }) : t('notifications.title')}
               style={({ pressed }) => [styles.bell, pressed && { backgroundColor: 'rgba(255,255,255,0.35)', transform: [{ scale: 0.94 }] }]}>
      <Icon source={unread > 0 ? 'bell-ring' : 'bell-outline'} size={24} color="#fff" />
      {unread > 0 ? (
        <View style={styles.badge} testID="bell-count"><Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text></View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)' },
  badge: { position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: brand.red600, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#fff' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
});
