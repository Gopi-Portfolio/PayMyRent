// Public landing, all on one screen with no scrolling: the picture (sky, home, shops, office, commercial) behind the logo at the top, then "Renting Made Simple",
// Login as Owner / Login as Renter, a plan prompt, and the footer links. The plan is chosen after the mobile number. Tenants never pay.
import { Montserrat_900Black_Italic, useFonts } from '@expo-google-fonts/montserrat';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { LanguagePill } from '@/components/LanguagePill';
import { Logo } from '@/components/Logo';
import { BackButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { markLandingSeen, setPendingPlan, setPendingRole } from '@/lib/landing';
import { brand } from '@/theme';

const BG = require('../../assets/brand/landing-bg.jpg');       // 1024 x 1536: sky, home, shops, office and commercial, with an empty pale area below
const BG_RATIO = 1536 / 1024;
const BLUE = '#003472';
const GREEN = '#1F8A02';

/** One of the two doors: an icon tile, a title, one line of help and a chevron. */
function Door({ icon, tint, color, title, sub, onPress, testID }: { icon: string; tint: string; color: string; title: string; sub: string; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID}
               style={({ pressed }) => [styles.door, pressed && { backgroundColor: tint }]}>
      <View style={[styles.doorIcon, { backgroundColor: tint }]}><Icon source={icon} size={30} color={color} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.doorTitle}>{title}</Text>
        <Text style={styles.doorSub}>{sub}</Text>
      </View>
      <Icon source="chevron-right" size={24} color={color} />
    </Pressable>
  );
}

export default function Welcome() {
  const { t } = useTranslation();
  const [fontsReady] = useFonts({ Montserrat_900Black_Italic });       // the page redraws when the font is ready
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [mainH, setMainH] = React.useState(330);                 // measured, so a longer language never cuts the page off: it scrolls instead
  const [footH, setFootH] = React.useState(56);
  const { me, signOut } = useAuth();
  const imgH = Math.round(screenW * BG_RATIO);
  const bandH = Math.round(imgH * 0.8);                          // show the picture down to the start of its lower leaves
  const mainTop = Math.round(screenW * 0.92);                    // the text starts under the row of buildings
  const contentH = Math.max(screenH, mainTop + mainH + footH + 12);   // fits one screen when it can; taller (and scrollable) when the text is longer

  // back on the landing page nothing has been chosen yet
  useFocusEffect(React.useCallback(() => { setPendingRole(null); setPendingPlan(null); }, []));

  const go = (role: 'owner' | 'tenant' | null) => { setPendingPlan(null); setPendingRole(role); markLandingSeen(); router.push('/(public)/phone'); };   // the plan is chosen after the OTP

  return (
    <View style={{ flex: 1, backgroundColor: '#EEF7FC' }}>
      <ScrollView showsVerticalScrollIndicator={false} bounces={false} contentContainerStyle={{ minHeight: screenH }}>
      <View style={{ height: contentH }}>
      {/* the picture at the very top, fading into the page, with a light white wash so it is softer */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: bandH, overflow: 'hidden' }}>
        <Image source={BG} style={{ width: screenW, height: imgH }} resizeMode="cover" />
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.2)' }} />
        <LinearGradient colors={['rgba(238,247,252,0)', '#EEF7FC']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: Math.round(bandH * 0.12) }} />
      </View>
      <LanguagePill top={insets.top + 12} onLight />

      {/* headline in the sky */}
      <View style={{ position: 'absolute', top: insets.top + 59, left: 0, right: 0, paddingHorizontal: 18 }}>
        <View style={{ alignItems: 'center' }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={[styles.hero, fontsReady && { fontFamily: 'Montserrat_900Black_Italic' }]} accessibilityRole="header">
            {t('welcome.heroA')} <Text style={[styles.hero, { color: GREEN }, fontsReady && { fontFamily: 'Montserrat_900Black_Italic' }]}>{t('welcome.heroB')}</Text>
          </Text>
          <Text style={styles.sub}>{t('welcome.heroSub')}</Text>
        </View>
      </View>
      {me ? <View style={{ position: 'absolute', top: insets.top + 12, left: 16 }}><BackButton light={false} /></View> : null}

      {/* the logo and the two doors, under the buildings */}
      <View onLayout={(e) => setMainH(e.nativeEvent.layout.height)} style={{ position: 'absolute', top: mainTop, left: 0, right: 0, paddingHorizontal: 18 }}>
        <View style={{ alignItems: 'center', marginTop: -16 }}><Logo size={64} stacked bare /></View>
        <View style={{ marginTop: 28, gap: 10 }}>
          {me ? (
            <>
              <AppButton label={t('welcome.openApp')} icon="view-dashboard-outline" onPress={() => { markLandingSeen(); router.replace('/'); }} testID="cta-dashboard" />
              {/* signed in as someone else, or with another number: sign out here and go straight to the number entry */}
              <AppButton variant="outline" label={t('welcome.otherNumber')} icon="cellphone-key" testID="cta-other-number"
                         onPress={async () => { await signOut(); setPendingPlan(null); markLandingSeen(); router.push('/(public)/phone'); }} />
            </>
          ) : (
            <>
              <Door icon="home-outline" tint="#E4F3DF" color={GREEN} title={t('welcome.loginOwner')} sub={t('welcome.loginOwnerSub')} onPress={() => go('owner')} testID="cta-owner-registered" />
              <Door icon="account-group" tint="#DCE8F7" color={BLUE} title={t('welcome.loginRenter')} sub={t('welcome.loginRenterSub')} onPress={() => go('tenant')} testID="cta-renter" />
              <Text style={styles.notOwner}>{t('welcome.notOwner')}</Text>
              <Pressable onPress={() => router.push('/(public)/plans')} accessibilityRole="button" testID="cta-plans" style={({ pressed }) => [styles.primary, pressed && { opacity: 0.9 }]}>
                <Icon source="crown" size={22} color="#fff" />
                <Text style={styles.primaryText}>{t('welcome.choosePlanBtn')}</Text>
                <Icon source="chevron-right" size={24} color="#fff" />
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* footer links */}
      <View onLayout={(e) => setFootH(e.nativeEvent.layout.height)} style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
        <Pressable style={styles.footItem} onPress={() => router.push('/privacy')} accessibilityRole="link"><Icon source="shield-check-outline" size={18} color="#222" /><Text style={styles.footText}>{t('welcome.secure')}</Text></Pressable>
        <View style={styles.footLine} />
        <Pressable style={styles.footItem} onPress={() => router.push('/help')} accessibilityRole="link"><Icon source="headset" size={18} color="#222" /><Text style={styles.footText}>{t('welcome.helpLink')}</Text></Pressable>
        <View style={styles.footLine} />
        <Pressable style={styles.footItem} onPress={() => router.push('/privacy')} accessibilityRole="link"><Icon source="lock-outline" size={18} color="#222" /><Text style={styles.footText}>{t('welcome.privacyLink')}</Text></Pressable>
      </View>
      </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { color: '#111', fontSize: 24, lineHeight: 30, letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center', fontWeight: '900' },
  sub: { color: '#222', fontSize: 14, lineHeight: 18, fontWeight: '700', textAlign: 'center', marginTop: -3 },
  door: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 20, borderWidth: 1.5, borderColor: '#D7E7D0', paddingVertical: 10, paddingHorizontal: 12 },
  doorIcon: { width: 52, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  doorTitle: { color: '#111', fontSize: 18, fontWeight: '800' },
  doorSub: { color: '#333', fontSize: 13, lineHeight: 17, marginTop: 1 },
  notOwner: { color: '#111', fontSize: 16, lineHeight: 22, fontWeight: '800', textAlign: 'center', marginTop: 12 },
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: GREEN, borderRadius: 28, height: 54 },
  primaryText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: 'rgba(255,255,255,0.75)', paddingTop: 10 },
  footItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 },
  footText: { color: '#222', fontSize: 13 },
  footLine: { width: 1, height: 20, backgroundColor: '#C9D0CC' },
});
