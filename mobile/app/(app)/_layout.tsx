import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { Icon } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { PayTabButton } from '@/components/PayTab';
import { useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export default function AppLayout() {
  const { t } = useTranslation();
  const { me, activeRole } = useAuth();
  if (!me) return <Redirect href="/(public)/welcome" />;
  const role = activeRole ?? me.roles[0];
  return (
    <Tabs screenOptions={{
      headerShown: false, tabBarActiveTintColor: brand.teal700, tabBarInactiveTintColor: brand.faint,
      tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
      tabBarStyle: { height: 66, paddingTop: 6, paddingBottom: 10, backgroundColor: '#fff', borderTopColor: brand.line },
    }}>
      <Tabs.Screen name="owner" options={{ title: t('role.switchOwner'), href: role === 'owner' ? undefined : null,
        tabBarIcon: ({ color }) => <Icon source="store" size={24} color={color as string} /> }} />
      <Tabs.Screen name="tenant" options={{ title: t('tenant.myRentals'), href: role === 'tenant' ? undefined : null,
        tabBarIcon: ({ color }) => <Icon source="home" size={24} color={color as string} /> }} />
      <Tabs.Screen name="pay-tab" options={{ title: t('pay.tab'), tabBarButton: () => <PayTabButton payer={role === 'tenant'} /> }} />
      <Tabs.Screen name="profile/index" options={{ title: t('profile.title'),
        tabBarIcon: ({ color }) => <Icon source="account" size={24} color={color as string} /> }} />
    </Tabs>
  );
}
