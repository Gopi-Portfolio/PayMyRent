// Everything the app told this person lately. Opening the list clears the bell's number; what was new stays marked while you read it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ErrorBanner, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { brand, radius, shadow } from '@/theme';

const ICON: Record<string, string> = {
  terms_changed: 'file-document-edit-outline', cash_recorded: 'hand-coin', payment_received: 'cash-check', deposit_changed: 'shield-lock-outline',
  relief_requested: 'hand-heart-outline', relief_approved: 'handshake-outline', relief_declined: 'close-circle-outline', vacate_requested: 'door-open', vacate_declined: 'close-circle-outline', rent_reminder: 'bell-ring-outline',
  charge_reviewed: 'flash-outline', tenancy_closed: 'door-open', invitation: 'email-fast-outline', security_event: 'shield-alert-outline', subscription_expiring: 'clock-alert-outline',
  dispute_update: 'scale-balance', agreement_ending_owner: 'file-sign', agreement_ending_tenant: 'file-sign', agreement_lapsed_owner: 'file-alert-outline',
  agreement_lapsed_tenant: 'file-alert-outline', agreement_renewed: 'file-check-outline',
};
// where a tap on a notification leads, when there is a natural place
const GO: Record<string, string> = { relief_requested: '/(app)/owner/relief', vacate_requested: '/(app)/owner/vacate', invitation: '/(app)/tenant' };

export default function Notifications() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { me, activeRole } = useAuth();
  const role = activeRole ?? me?.roles[0] ?? 'tenant';
  const q = useQuery({ queryKey: ['notifications', role], queryFn: () => api<any>(`/api/v1/me/notifications?role=${role}`) });
  const fresh = React.useRef<Set<string> | null>(null);            // what was new when the list opened, kept highlighted while reading
  if (q.data && fresh.current === null) fresh.current = new Set((q.data.items as any[]).filter((i) => i.unread).map((i) => i.id));
  React.useEffect(() => {
    if (q.data && q.data.unread > 0) {
      api(`/api/v1/me/notifications/seen?role=${role}`, { method: 'POST' }).then(() => qc.setQueryData(['notifications', role], (d: any) => (d ? { ...d, unread: 0 } : d))).catch(() => undefined);
    }
  }, [q.data?.unread]);   // eslint-disable-line react-hooks/exhaustive-deps
  const items: any[] = q.data?.items ?? [];
  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.data && items.length === 0 ? (
        <View style={{ alignItems: 'center', padding: 32, gap: 10 }}>
          <Icon source="bell-sleep-outline" size={44} color={brand.muted} />
          <Text style={{ color: brand.muted, textAlign: 'center' }}>{t('notifications.empty')}</Text>
        </View>
      ) : null}
      {items.map((n) => {
        const isNew = fresh.current?.has(n.id);
        const go = n.tenancy_id && n.template.startsWith('agreement') ? `/agreement/${n.tenancy_id}` : GO[n.template];
        return (
          <Pressable key={n.id} disabled={!go} onPress={() => go && router.push(go as any)} testID={`notification-${n.template}`}
                     style={({ pressed }) => [{ backgroundColor: isNew ? brand.teal50 : '#fff', borderRadius: radius.md, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'flex-start',
                                                borderLeftWidth: isNew ? 4 : 0, borderLeftColor: brand.teal700 }, shadow, pressed && { opacity: 0.85 }]}>
            <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: brand.teal100, alignItems: 'center', justifyContent: 'center' }}>
              <Icon source={ICON[n.template] ?? 'bell-outline'} size={20} color={brand.teal700} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodyMedium" style={{ fontWeight: isNew ? '700' : '500' }}>{n.text}</Text>
              <Text variant="labelSmall" style={{ color: brand.muted }}>{fmtDate(n.created_at)}</Text>
            </View>
            {go ? <Icon source="chevron-right" size={20} color={brand.muted} /> : null}
          </Pressable>
        );
      })}
    </Screen>
  );
}
