// Router gate: public pricing → OTP → role → profile → (owner) plan → home.
import { Redirect, router } from 'expo-router';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { AuthShell, ErrorBanner } from '@/components/ui';

import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { getPendingRole, landingSeen, setPendingPlan, setPendingRole } from '@/lib/landing';

/** The visitor used the Owner or Renter button on the landing page. A new account simply becomes that role. An account that already has the OTHER role
 *  is asked first ("Want to become an owner?"): adding a role is a change to the account, so it never happens silently. Yes makes the same number both
 *  owner and renter (the two views can be switched any time) and carries on to the owner steps and the plan. An account that already has the role is
 *  just switched to that view. */
function ApplyDoor({ role }: { role: 'owner' | 'tenant' }) {
  const { t } = useTranslation();
  const { me, refresh, setActiveRole } = useAuth();
  const [busy, setBusy] = React.useState(false);
  const has = !!me?.roles.includes(role);
  const asks = !!me && me.roles.length > 0 && !has;                    // an existing account of the other role
  const finish = React.useCallback(async (add: boolean) => {
    setPendingRole(null);                                              // used once
    setBusy(true);
    try {
      if (add && me && !has) { await api('/api/v1/me/roles', { body: { roles: [role] } }); await refresh(); }
      if (add || has) setActiveRole(role);
      else setPendingPlan(null);                                       // declined: the plan chosen on the landing page is no longer wanted
    } catch { /* the usual routing below still applies */ }
    router.replace('/');
  }, [me, has, role, refresh, setActiveRole]);
  React.useEffect(() => { if (!asks) finish(true); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!asks) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  const key = role === 'owner' ? 'becomeOwner' : 'becomeRenter';
  return (
    <AuthShell title={t(`role.${key}Title`)} icon={role === 'owner' ? 'store' : 'home'}>
      <Text style={{ lineHeight: 22 }}>{t(`role.${key}Body`)}</Text>
      <AppButton label={t(`role.${key}Yes`)} icon="check" loading={busy} disabled={busy} onPress={() => finish(true)} testID="role-yes" />
      <AppButton variant="outline" label={t(`role.${key}No`)} icon="close" disabled={busy} onPress={() => finish(false)} testID="role-no" />
    </AuthShell>
  );
}

export default function Index() {
  const { me, loading, activeRole, authError, refresh } = useAuth();
  const { t } = useTranslation();
  if (loading) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  if (!me && authError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        <Text variant="headlineSmall" style={{ fontWeight: '800' }}>{t('common.retry')}</Text>
        <ErrorBanner error={authError} />
        <AppButton icon="refresh" label={t('common.retry')} onPress={() => refresh()} />
      </View>
    );
  }
  if (!me) return <Redirect href="/(public)/welcome" />;           // the landing page is for people who are signed out; a signed-in person goes straight to their home
  const door = getPendingRole();
  if (door) return <ApplyDoor role={door} />;
  if (me.roles.length === 0) return <Redirect href="/(onboarding)/role" />;
  if (!me.profile_complete) return <Redirect href="/(onboarding)/profile" />;
  const role = activeRole ?? me.roles[0];
  if (role === 'owner') {
    const ver = me.owner_accounts[0]?.verification;
    if (!ver || ver === 'rejected') return <Redirect href="/(onboarding)/owner-details" />;
    const state = me.owner_accounts[0]?.state ?? 'none';
    if (state === 'none') return <Redirect href="/(onboarding)/plan" />;
    return <Redirect href="/(app)/owner" />;
  }
  return <Redirect href="/(app)/tenant" />;
}
