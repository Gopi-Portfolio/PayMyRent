// First verified login: role intent. Grants nothing by itself; data access is per tenancy/owner account.
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Icon, Text } from 'react-native-paper';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ErrorBanner, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getPendingRole, setPendingRole } from '@/lib/landing';
import { brand, radius, shadow } from '@/theme';

const CHOICES = [
  { key: 'owner', roles: ['owner'], icon: 'store' },
  { key: 'tenant', roles: ['tenant'], icon: 'home' },
  { key: 'both', roles: ['owner', 'tenant'], icon: 'swap-horizontal' },
] as const;

export default function Role() {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function choose(roles: readonly string[]) {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/me/roles', { body: { roles } });
      await refresh();
      router.push('/(onboarding)/profile');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  useEffect(() => {   // the door used on the landing page (Owner / Renter) is applied once; the choices below stay for anyone who did not use one
    const pending = getPendingRole();
    if (pending) { setPendingRole(null); choose([pending]); }
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Screen>
      <Text variant="headlineSmall" style={{ fontWeight: '800' }} accessibilityRole="header">{t('role.title')}</Text>
      <ErrorBanner error={err} />
      {CHOICES.map((c) => (
        <Pressable key={c.key} onPress={() => !busy && choose(c.roles)} accessibilityRole="button" testID={`role-${c.key}`}
                   style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#fff', borderRadius: radius.lg, padding: 18, minHeight: 76 }, shadow, pressed && { backgroundColor: brand.teal50, transform: [{ scale: 0.98 }] }]}>
          <View style={{ width: 52, height: 52, borderRadius: radius.md, backgroundColor: brand.teal100, alignItems: 'center', justifyContent: 'center' }}>
            <Icon source={c.icon} size={28} color={brand.teal700} />
          </View>
          <Text variant="titleMedium" style={{ flex: 1, fontWeight: '700' }}>{t(`role.${c.key}`)}</Text>
          <Icon source="chevron-right" size={22} color={brand.muted} />
        </Pressable>
      ))}
    </Screen>
  );
}
