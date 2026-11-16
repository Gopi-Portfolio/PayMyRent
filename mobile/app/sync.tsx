// "Saved Changes": the entries made while offline that are still waiting to be sent, or that the server did not accept.
import React from 'react';
import { Alert, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { Screen } from '@/components/ui';
import { useOnline } from '@/lib/network';
import { outbox, syncNow, useOutbox, type OutboxItem } from '@/lib/offline';
import { brand, radius, shadow } from '@/theme';

export default function SavedChanges() {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const { items, pending, sending, authBlocked } = useOutbox();
  const when = (ms: number) => new Date(ms).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  const ask = (item: OutboxItem) => Alert.alert(t('offline.discardTitle'), t('offline.discardBody'), [
    { text: t('common.back'), style: 'cancel' },
    { text: t('offline.discard'), style: 'destructive', onPress: () => outbox.discard(item.id) },
  ]);

  return (
    <Screen>
      <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('offline.intro')}</Text>
      {authBlocked ? <Text style={{ color: '#8A1C14', fontWeight: '700' }} testID="sync-signin">{t('offline.signIn')}</Text> : null}
      {items.length > 0 ? (
        <AppButton icon="cloud-upload-outline" label={t('offline.sendNow')} loading={sending} disabled={pending === 0 || sending} onPress={() => { void syncNow({ force: true }); }} testID="send-now" />
      ) : null}
      {items.length === 0 ? (
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 36 }} testID="sync-empty">
          <Icon source="check-circle-outline" size={48} color={brand.green600} />
          <Text style={{ color: brand.muted, textAlign: 'center' }}>{t('offline.empty')}</Text>
        </View>
      ) : null}
      {items.map((item) => {
        const failed = item.status === 'failed';
        const why = item.error ? t(`offline.err_${item.error.code}`, { defaultValue: t(`error.${item.error.code}`, { defaultValue: item.error.message }) }) : null;
        return (
          <View key={item.id} style={[{ backgroundColor: '#fff', borderRadius: radius.md, padding: 14, gap: 8, borderWidth: 1.5, borderColor: failed ? '#F5B5B0' : '#F4DFA6' }, shadow]} testID={`saved-${item.id}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon source={failed ? 'alert-circle-outline' : 'clock-outline'} size={20} color={failed ? '#B42318' : '#B45309'} />
              <Text style={{ flex: 1, fontWeight: '800', color: brand.ink }}>{item.label}</Text>
            </View>
            <Text style={{ fontSize: 12, color: brand.muted }}>{`${when(item.createdAt)} · ${failed ? t('offline.statusFailed') : t('offline.statusWaiting')}`}</Text>
            {why ? <Text style={{ color: '#B42318', lineHeight: 20 }} testID={`why-${item.id}`}>{why}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {failed ? <View style={{ flex: 1 }}><AppButton variant="outline" compact label={t('offline.tryAgain')} icon="refresh" onPress={() => { outbox.retry(item.id); void syncNow({ force: true }); }} testID={`retry-${item.id}`} /></View> : null}
              <View style={{ flex: 1 }}><AppButton variant="outline" compact label={t('offline.discard')} icon="delete-outline" onPress={() => ask(item)} testID={`discard-${item.id}`} /></View>
            </View>
          </View>
        );
      })}
    </Screen>
  );
}
