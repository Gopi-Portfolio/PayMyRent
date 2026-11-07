// Public landing: brand hero, what PayMyRent does, pricing (visible before login). Tenants never pay.
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { HeroIllustration } from '@/components/Illustration';
import { LanguagePill } from '@/components/LanguagePill';
import { Logo } from '@/components/Logo';
import { BackButton, PricingCards } from '@/components/ui';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { markLandingSeen, setPendingPlan, setPendingRole } from '@/lib/landing';
import { brand, radius, shadow } from '@/theme';

// The buildings picture sits at the foot of the page and the content starts higher. Set to false to put the picture back under the tagline.
const ILLUSTRATION_AT_BOTTOM = true;

const FEATURES = [
  { icon: 'file-document-outline', key: 'welcome.f1', tone: brand.teal100, fg: brand.teal700 },
  { icon: 'cash-fast', key: 'welcome.f2', tone: brand.amber100, fg: '#B45309' },
  { icon: 'bell-ring-outline', key: 'welcome.f3', tone: brand.blue100, fg: brand.blue600 },
] as const;

export default function Welcome() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { me, signOut } = useAuth();
  const owner = ownerAccountId(me);
  // an owner with a plan sees it marked on the landing page
  const sub = useQuery({ queryKey: ['subscription', owner], enabled: !!owner && !!me?.profile_complete, queryFn: () => api<any>('/api/v1/subscription', { ownerAccount: owner }) });
  const currentPlan: string | null = sub.data?.current?.plan_code ?? null;
  return (
    <View style={{ flex: 1, backgroundColor: brand.canvas }}>
      <LanguagePill top={insets.top + 10} />
      <ScrollView contentContainerStyle={{ paddingBottom: 230 }}>
        <LinearGradient colors={[brand.teal900, brand.teal700, brand.teal600]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                        style={[styles.hero, { paddingTop: insets.top + 36 }, ILLUSTRATION_AT_BOTTOM && { paddingBottom: 56 }]}>
          {me ? <View style={{ position: 'absolute', left: 16, top: insets.top + 10 }}><BackButton /></View> : null}
          <Logo size={60} light stacked />
          <Text style={styles.tagline} accessibilityRole="header">{t('app.tagline')}</Text>
          {ILLUSTRATION_AT_BOTTOM ? null : <View style={{ marginTop: 18 }}><HeroIllustration width={300} /></View>}
        </LinearGradient>
        <View style={styles.body}>
          <View style={[styles.features, shadow]}>
            {FEATURES.map((f) => (
              <View key={f.key} style={styles.featureRow}>
                <View style={[styles.featureIcon, { backgroundColor: f.tone }]}><Icon source={f.icon} size={22} color={f.fg} /></View>
                <Text variant="bodyMedium" style={{ flex: 1, fontWeight: '600' }}>{t(f.key)}</Text>
              </View>
            ))}
          </View>
          {me ? null : <Text variant="titleSmall" style={{ fontWeight: '800', color: brand.teal700, textAlign: 'center' }}>{t('welcome.newOwner')}</Text>}
          <PricingCards currentPlan={currentPlan} cardCta={t('pricing.choose')}
                        onSelect={(code) => {
                          setPendingPlan(code); markLandingSeen();
                          if (!me) { setPendingRole('owner'); router.push('/(public)/phone'); return; }       // a new owner: sign in, owner details, then this plan
                          router.push('/(onboarding)/plan');
                        }} />
        </View>
        {ILLUSTRATION_AT_BOTTOM ? (
          <LinearGradient colors={[brand.teal700, brand.teal900]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.bottomPicture} testID="landing-picture">
            <HeroIllustration width={300} />
          </LinearGradient>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        {me
          ? (
            <View style={{ gap: 8 }}>
              <AppButton label={t('welcome.openApp')} icon="view-dashboard-outline" onPress={() => { markLandingSeen(); router.replace('/'); }} testID="cta-dashboard" />
              {/* signed in as someone else, or with another number: sign out here and go straight to the number entry */}
              <AppButton variant="outline" label={t('welcome.otherNumber')} icon="cellphone-key" testID="cta-other-number"
                         onPress={async () => { await signOut(); setPendingPlan(null); markLandingSeen(); router.push('/(public)/phone'); }} />
            </View>
          )
          : (
            <View style={{ gap: 8 }}>
              {/* an owner who already has an account signs in here: no plan to pick, and the account decides where they land */}
              <AppButton variant="green" label={t('welcome.ownerRegistered')} icon="store" testID="cta-owner-registered"
                         onPress={() => { setPendingRole('owner'); markLandingSeen(); router.push('/(public)/phone'); }} />
              <AppButton variant="blue" label={t('welcome.renterSignIn')} icon="home" testID="cta-renter"
                         onPress={() => { setPendingPlan(null); setPendingRole('tenant'); markLandingSeen(); router.push('/(public)/phone'); }} />
              <Text variant="labelSmall" style={{ color: brand.muted, textAlign: 'center' }}>{t('welcome.renterNote')}</Text>
            </View>
          )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingBottom: 64, paddingHorizontal: 24 },
  tagline: { color: 'rgba(255,255,255,0.92)', fontSize: 17, fontWeight: '500', textAlign: 'center', marginTop: 18, lineHeight: 24 },
  body: { paddingHorizontal: 16, marginTop: -36, gap: 20 },
  features: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16, gap: 14 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  featureIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  bottomPicture: { alignItems: 'center', paddingTop: 28, paddingBottom: 12, marginTop: 24 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, backgroundColor: 'rgba(244,247,246,0.96)' },
});
