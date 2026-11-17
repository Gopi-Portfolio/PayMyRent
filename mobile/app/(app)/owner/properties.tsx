// My properties: each one has its own plan, units and vacancy. Tap one to work on it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Button } from '@/components/Buttons';
import { confirmRemove } from '@/lib/confirm';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { KindBadge } from '@/components/KindBadge';
import { ErrorBanner, Panel, Screen, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { brand, radius, shadow } from '@/theme';

export default function MyProperties() {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const current = ownerAccountId(me);
  const qc = useQueryClient();
  const [err, setErr] = React.useState<unknown>(null);
  const q = useQuery({ queryKey: ['workspaces', me?.id], queryFn: () => api<any>('/api/v1/owner/workspaces') });
  return (
    <Screen>
      <ErrorBanner error={err || q.error} onRetry={() => { setErr(null); q.refetch(); }} />
      {(((q.data?.items ?? []).some((w: any) => w.property)) ? (q.data?.items ?? []).filter((w: any) => w.property) : (q.data?.items ?? [])).map((w: any) => (
        <Pressable key={w.owner_account_id} onPress={() => { selectOwner(w.owner_account_id); router.replace('/(app)/owner'); }} accessibilityRole="button"
                   style={[{ backgroundColor: '#fff', borderRadius: radius.lg, padding: 14, gap: 8, borderWidth: w.owner_account_id === current ? 2 : 1,
                             borderColor: w.owner_account_id === current ? brand.teal700 : brand.line }, shadow]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {w.property ? <KindBadge kind={w.property.kind} size={28} testID={`kind-${w.owner_account_id}`} /> : <Icon source="home-plus-outline" size={24} color={brand.teal700} />}
            <Text variant="titleSmall" style={{ flex: 1, fontWeight: '800' }} numberOfLines={1}>{w.property?.name || w.property?.address || t('property.newProperty')}</Text>
            {w.property ? <StatusPill status={w.property.verification_status === 'submitted' ? t('property.statusSubmitted') : w.property.verification_status === 'verified' ? t('property.statusVerified') : t('property.statusRejected')} /> : null}
          </View>
          {w.property ? <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={2}>{`${w.property.address}, ${w.property.city} ${w.property.pincode}`}</Text>
                      : <Text variant="bodySmall" style={{ color: brand.amber700 }}>{t('property.addYourProperty')}</Text>}
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Text style={{ fontWeight: '700' }}>{w.plan ? `${t('property.plan')}: ${String(w.plan).charAt(0).toUpperCase()}${String(w.plan).slice(1)}` : t('property.noPlan')}</Text>
            <Text style={{ fontWeight: '700' }}>{t('property.unitsOf', { used: w.active_units, cap: w.units_capacity })}</Text>
            <Text style={{ fontWeight: '700', color: w.vacant_units ? brand.amber700 : brand.muted }}>{`${t('property.vacant')}: ${w.vacant_units}`}</Text>
          </View>
          {w.property && w.role === 'owner' ? (
            <Button textColor="crimson" icon="home-remove-outline" testID={`remove-property-${w.property.id}`} onPress={() => {
              const name = w.property.name || w.property.address;
              const occupied = Math.max((w.active_units ?? 0) - (w.vacant_units ?? 0), 0);        // units with a renter living in them or an invitation waiting
              if (occupied > 0) {
                // not allowed while anyone is in it: say so, and take the owner to the renters to remove them first
                Alert.alert(t('property.removeBlockedTitle', { name }), t('property.removeBlockedBody', { count: occupied }), [
                  { text: t('common.cancel'), style: 'cancel' },
                  { text: t('property.removeRentersFirst'), onPress: () => router.push('/(app)/owner/remove-renter') },
                ]);
                return;
              }
              confirmRemove(t('property.removeTitle', { name }), t('property.removeBody'), t('property.remove'),
                async () => { try { setErr(null); await api(`/api/v1/owner/properties/${w.property.id}/remove`, { method: 'POST', ownerAccount: w.owner_account_id }); qc.invalidateQueries(); } catch (x) { setErr(x); } });
            }}>
              {t('property.remove')}
            </Button>
          ) : null}
        </Pressable>
      ))}
      <AppButton label={t('property.addAnother')} icon="plus" onPress={() => router.push('/(app)/owner/add-property')} />
    </Screen>
  );
}
