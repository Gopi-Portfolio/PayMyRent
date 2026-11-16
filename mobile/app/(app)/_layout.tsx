import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { Icon } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppTabBar } from '@/components/AppTabBar';
import { PayTabButton } from '@/components/PayTab';
import { useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export default function AppLayout() {
  const { t } = useTranslation();
  const { me, activeRole } = useAuth();
  if (!me) return <Redirect href="/(public)/welcome" />;
  const role = activeRole ?? me.roles[0];
  return (
    <Tabs tabBar={(props: any) => <AppTabBar {...props} />} screenOptions={{
      headerShown: false, tabBarActiveTintColor: brand.teal700, tabBarInactiveTintColor: brand.faint,
    }}>
      {/* every tab icon is the role's own colour (green for owners, blue for renters), so Search and Profile match Owner; the label shows which tab is open */}
      <Tabs.Screen name="owner" options={{ title: t('role.switchOwner'), href: role === 'owner' ? undefined : null,
        tabBarIcon: () => <Icon source="store" size={24} color={brand.teal700} /> }} />
      <Tabs.Screen name="tenant" options={{ title: t('tenant.myRentals'), href: role === 'tenant' ? undefined : null,
        tabBarIcon: () => <Icon source="home" size={24} color={brand.teal700} /> }} />
      {/* paying is for renters: owners do not see the Pay tab at all. (expo-router refuses `href` together with `tabBarButton`, so the button itself draws nothing for an owner.) */}
      <Tabs.Screen name="pay-tab" options={{ title: t('pay.tab'), tabBarButton: role === 'tenant' ? () => <PayTabButton payer /> : () => null }} />
      <Tabs.Screen name="search" options={{ title: t('common.search'), href: role === 'owner' ? undefined : null,        // owners: left of Profile
        tabBarIcon: () => <Icon source="magnify" size={24} color={brand.teal700} /> }} />
      <Tabs.Screen name="profile/index" options={{ title: t('profile.title'),
        tabBarIcon: () => <Icon source="account" size={24} color={brand.teal700} /> }} />
    </Tabs>
  );
}
