import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { Icon } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { PayTabButton } from '@/components/PayTab';
import { useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export default function AppLayout() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { me, activeRole } = useAuth();
  if (!me) return <Redirect href="/(public)/welcome" />;
  const role = activeRole ?? me.roles[0];
  const bottomSpace = Math.max(insets.bottom, 8);      // at least a little room below the labels, even on a phone with no home indicator
  return (
    <Tabs screenOptions={{
      headerShown: false, tabBarActiveTintColor: brand.teal700, tabBarInactiveTintColor: brand.faint,
      tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
      tabBarItemStyle: { alignItems: 'center', justifyContent: 'center' },     // every icon and label sits on the same line, whatever tabs are shown
      // The bar's own height and bottom padding already include the phone's home-indicator space; a fixed height and padding replaced that and pushed the
      // icons and labels out of line. So both are worked out from the real bottom inset: 56 of bar plus whatever the phone needs.
      tabBarStyle: { height: 56 + bottomSpace, paddingTop: 6, paddingBottom: bottomSpace, backgroundColor: '#fff', borderTopColor: brand.line },
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
