import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, usePathname } from 'expo-router';
import React from 'react';
import { ActivityIndicator, Animated, Dimensions, Easing, FlatList, InputAccessoryView, Keyboard, Modal, Platform, PanResponder, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { Banner, Card, HelperText, Icon, ProgressBar, SegmentedButtons, Text, TextInput, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { fmtDate } from '@/lib/dates';
import { LANGUAGES } from '@/i18n';
import { type InputKind, keyboardFor, maxLengthFor, sanitize } from '@/lib/inputs';
import { ApiError, api } from '@/lib/api';
import { AppButton, Button } from '@/components/Buttons';
import { useAuth } from '@/lib/auth';
import { MAX_ENTRY_PAISE, capToDue, formatINR } from '@/lib/format';
import { brand, radius, shadow } from '@/theme';
import { markLandingSeen } from '@/lib/landing';
import { type KindGroup, kindGroup } from '@/lib/units';
import { Logo, LogoWhite, RentMeezyBarLogo, playLogoIntro } from './Logo';
import { OfflineBanner } from './OfflineBanner';
import { RoleIcon } from './RoleIcon';
import { BellButton } from './Bell';
import { LanguagePill } from './LanguagePill';
import { saveLanguage } from '@/lib/language';

/** Round back button. Goes back one screen; if there is no history it returns to the home screen. */
/** Safe back: pops the stack when it can, otherwise goes to the role home (never a dead tap). */
export function goBack() {
  if (router.canGoBack()) router.back(); else router.replace('/');
}

const ROOT_PATHS = ['/', '/owner', '/tenant', '/profile'];

export function BackButton({ light = true }: { light?: boolean }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  // Shown only when there is really a screen to go back to (re-checked whenever the path changes).
  // The mobile-number screen always has one: after the plans on the landing page, or (if the app opened straight on it) the landing page itself,
  // so a visitor who changes their mind about the plan can go back.
  if (ROOT_PATHS.includes(pathname) || (!router.canGoBack() && pathname !== '/phone')) return null;
  return (
    <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={8} testID="back"
               style={({ pressed }) => [styles.back, { backgroundColor: light ? 'rgba(255,255,255,0.18)' : brand.teal100 }, pressed && { backgroundColor: light ? 'rgba(255,255,255,0.35)' : brand.teal50, transform: [{ scale: 0.94 }] }]}>
      <Icon source="chevron-left" size={26} color={light ? '#fff' : brand.teal700} />
    </Pressable>
  );
}

/** Two big choices (Male / Female). Stored on this device; it decides which person icon the Tenant view shows. */
export function GenderPicker() {
  const { t } = useTranslation();
  const { gender, setGender } = useAuth();
  const items = [{ g: 'male' as const, icon: 'human-male', label: t('profile.male') }, { g: 'female' as const, icon: 'human-female', label: t('profile.female') }];
  return (
    <View style={{ gap: 6 }}>
      <Text variant="labelLarge" style={{ color: brand.muted }}>{t('profile.gender')}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {items.map((it) => {
          const on = gender === it.g;
          return (
            <Pressable key={it.g} onPress={() => setGender(it.g)} accessibilityRole="radio" accessibilityState={{ selected: on }} testID={`gender-${it.g}`}
                       style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: radius.md,
                         borderWidth: 2, borderColor: on ? brand.teal700 : brand.line, backgroundColor: on ? brand.teal100 : pressed ? brand.teal50 : '#fff' })}>
              <Icon source={it.icon} size={26} color={on ? brand.teal700 : brand.muted} />
              <Text style={{ fontWeight: '800', color: on ? brand.teal700 : brand.ink }}>{it.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

let slideUntil = 0;   // set when the role is switched: the next screen that appears slides in from the right

/** Call when the role is switched so the screen that appears next slides in right to left. */
export function playScreenSlide() { slideUntil = Date.now() + 2500; }

/** Wraps the page content (not the header). After a role switch it slides in from the right while fading up, like a page that just refreshed. */
export function SlideIn({ children }: { children: React.ReactNode }) {
  const width = Dimensions.get('window').width;
  const x = React.useRef(new Animated.Value(Date.now() < slideUntil ? 1 : 0)).current;   // 1 = just off to the right and transparent, 0 = in place
  const hidden = React.useRef(Date.now() < slideUntil);
  useFocusEffect(React.useCallback(() => {
    if (Date.now() < slideUntil || hidden.current) {
      slideUntil = 0; hidden.current = false;
      x.setValue(1);
      Animated.timing(x, { toValue: 0, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [x]));
  return (
    <Animated.View style={{ flex: 1, opacity: x.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                            transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, width * 0.4] }) }] }}>{children}</Animated.View>
  );
}

/** Switches the active role (adds it to the account when missing). Shared by the header link. */
function useRoleSwitch() {
  const { me, activeRole, setActiveRole, refresh } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const current: 'owner' | 'tenant' = activeRole ?? me?.roles[0] ?? 'owner';
  const other: 'owner' | 'tenant' = current === 'owner' ? 'tenant' : 'owner';
  async function toggle() {
    if (busy || !me) return;
    setBusy(true);
    try {
      if (!me.roles.includes(other)) { await api('/api/v1/me/roles', { body: { roles: [other] } }); await refresh(); }
      playLogoIntro();
      playScreenSlide();
      qc.invalidateQueries();                          // the page really reloads its data
      setActiveRole(other);
      markLandingSeen();
      router.replace('/');
    } catch { /* stays on the current role */ } finally { setBusy(false); }
  }
  return { me, current, other, busy, toggle };
}

/** Hamburger menu: help, plans, profile, sign out. */
function MenuButton() {
  const { t, i18n } = useTranslation();
  const { me, signOut, refresh } = useAuth();
  const rs = useRoleSwitch();
  const [open, setOpen] = React.useState(false);
  const [langOpen, setLangOpen] = React.useState(false);
  async function chooseLanguage(code: string) {
    setLangOpen(false);
    i18n.changeLanguage(code);                       // switches immediately
    saveLanguage(code);                              // and is remembered on this phone
    if (me?.full_name) {                             // remember it on the account (best effort)
      try { await api('/api/v1/me/profile', { method: 'PUT', body: { full_name: me.full_name, address: me.address, preferred_language: code, version: me.version } }); await refresh(); } catch { /* local change still applies */ }
    }
  }
  const insets = useSafeAreaInsets();
  const go = (fn: () => void) => { setOpen(false); fn(); };
  const items = [
    { icon: 'home-variant-outline', label: t('help.menuHome'), onPress: () => go(() => { markLandingSeen(); router.replace('/'); }), id: 'home' },
    { icon: 'help-circle-outline', label: t('help.menuHelp'), onPress: () => go(() => router.push('/help')), id: 'help' },
    { icon: 'shield-account-outline', label: t('privacy.title'), onPress: () => go(() => router.push('/privacy')), id: 'privacy' },
    ...(me && !(me.roles.includes('owner') && me.roles.includes('tenant'))
      ? [{ icon: 'account-plus-outline', label: t(rs.other === 'owner' ? 'role.addOwner' : 'role.addRenter'), onPress: () => { setOpen(false); rs.toggle(); }, id: 'addrole' }] : []),
    { icon: 'translate', label: `${t('help.menuLanguage')} · ${LANGUAGES.find((l) => l.code === i18n.language)?.label ?? ''}`, onPress: () => { setOpen(false); setLangOpen(true); }, id: 'language' },
    { icon: 'account-outline', label: t('help.menuProfile'), onPress: () => go(() => router.push('/(app)/profile')), id: 'profile' },
    { icon: 'logout', label: t('profile.signOut'), onPress: () => go(async () => { await signOut(); router.replace('/'); }), id: 'signout', danger: true },
  ];
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={t('help.menu')} hitSlop={10} testID="menu"
                 style={({ pressed }) => [styles.back, { backgroundColor: 'rgba(255,255,255,0.18)' }, pressed && { backgroundColor: 'rgba(255,255,255,0.35)', transform: [{ scale: 0.94 }] }]}>
        <Icon source="menu" size={24} color="#fff" />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={() => setOpen(false)} accessibilityLabel={t('help.menuClose')}>
          <View style={[{ position: 'absolute', right: 12, top: insets.top + 56, minWidth: 240, backgroundColor: '#fff', borderRadius: radius.md, paddingVertical: 6 }, shadow]}>
            {items.map((it) => (
              <Pressable key={it.id} onPress={it.onPress} accessibilityRole="menuitem" testID={`menu-${it.id}`}
                         style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13, backgroundColor: pressed ? brand.teal50 : '#fff' })}>
                <Icon source={it.icon} size={22} color={it.danger ? brand.red600 : brand.teal700} />
                <Text style={{ fontWeight: '700', color: it.danger ? brand.red600 : brand.ink }}>{it.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
      <Modal visible={langOpen} transparent animationType="fade" onRequestClose={() => setLangOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 24 }} onPress={() => setLangOpen(false)}>
          <View style={[{ backgroundColor: '#fff', borderRadius: radius.lg, paddingVertical: 8 }, shadow]}>
            <Text variant="titleMedium" style={{ fontWeight: '800', paddingHorizontal: 20, paddingVertical: 12 }}>{t('help.chooseLanguage')}</Text>
            {LANGUAGES.map((l) => {
              const on = l.code === i18n.language;
              return (
                <Pressable key={l.code} onPress={() => chooseLanguage(l.code)} accessibilityRole="menuitem" testID={`lang-${l.code}`}
                           style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14, backgroundColor: pressed || on ? brand.teal50 : '#fff' })}>
                  <Text style={{ flex: 1, fontSize: 16, fontWeight: on ? '800' : '600', color: on ? brand.teal700 : brand.ink }}>{l.label}</Text>
                  {on ? <Icon source="check-circle" size={22} color={brand.teal700} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

/** Slide-to-switch: your role on the left; only the other role's icon sits at the right. Drag it left past 70% of the track to switch. */
function SwitchSlider({ current, other, gender, busy, onSwitch, name, hint }: {
  current: 'owner' | 'tenant'; other: 'owner' | 'tenant'; gender: 'male' | 'female' | null; busy: boolean; onSwitch: () => void; name: string; hint: string;
}) {
  const HANDLE = 40, PAD = 6;
  const [trackW, setTrackW] = React.useState(0);
  const x = React.useRef(new Animated.Value(0)).current;           // 0 .. -max
  const maxRef = React.useRef(0);
  const switching = React.useRef(false);
  const max = Math.max(0, trackW - HANDLE - PAD * 2);
  maxRef.current = max;
  const switchRef = React.useRef(onSwitch);
  switchRef.current = onSwitch;

  const pan = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !switching.current,
    onMoveShouldSetPanResponder: () => !switching.current,
    onPanResponderMove: (_, g) => x.setValue(Math.max(-maxRef.current, Math.min(0, g.dx))),
    onPanResponderRelease: (_, g) => {
      const m = maxRef.current;
      if (m > 0 && -g.dx >= m * 0.7) {                              // dragged far enough: complete the slide and switch
        switching.current = true;
        Animated.timing(x, { toValue: -m, duration: 120, useNativeDriver: false }).start(() => {
          switchRef.current();
          setTimeout(() => { x.setValue(0); switching.current = false; }, 400);
        });
      } else {
        Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
      }
    },
    onPanResponderTerminationRequest: () => false,      // keep the drag; never hand it to a screen-swipe gesture
    onShouldBlockNativeResponder: () => true,
    onPanResponderTerminate: () => { Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(); },
  }), [x]);

  const progress = x.interpolate({ inputRange: [-Math.max(1, max), 0], outputRange: [1, 0], extrapolate: 'clamp' });
  return (
    <View onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} testID="switch-role"
          accessible accessibilityRole="adjustable" accessibilityLabel={hint} accessibilityActions={[{ name: 'activate', label: hint }]}
          onAccessibilityAction={() => onSwitch()}
          style={{ height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.14)', justifyContent: 'center', paddingHorizontal: PAD, overflow: 'hidden' }}>
      {/* who you are: the role keeps the full width except for the handle's space */}
      <Animated.View style={{ position: 'absolute', left: PAD, right: HANDLE + PAD * 2 + 6, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: progress.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: 'clamp' }) }}>
        <RoleIcon role={current} gender={gender} size={34} />
        <Text numberOfLines={1} style={{ flex: 1, color: '#fff', fontSize: 17, fontWeight: '800' }}>{name}</Text>
        <Icon source="chevron-double-left" size={22} color="rgba(255,255,255,0.55)" />
      </Animated.View>
      {/* the hint appears while dragging */}
      <Animated.Text numberOfLines={1} style={{ position: 'absolute', left: 0, right: HANDLE + PAD * 2, textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: '700', opacity: progress.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0, 1] }) }}>{hint}</Animated.Text>
      <Animated.View {...pan.panHandlers} style={{ alignSelf: 'flex-end', width: HANDLE, height: HANDLE, borderRadius: HANDLE / 2, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', transform: [{ translateX: x }], ...shadow }}>
        {busy ? <ActivityIndicator size="small" color={brand.teal700} /> : <RoleIcon role={other} gender={gender} size={30} />}
      </Animated.View>
    </View>
  );
}

/** The page the user is on, named after the link they tapped (null = a role's home screen). */
function usePageTitle(): string | null {
  const { t } = useTranslation();
  const path = usePathname();
  const rules: [RegExp, () => string][] = [
    [/^\/owner\/owner-numbers/, () => t('ownerNumbers.title')], [/^\/owner\/add-property/, () => t('property.add')], [/^\/owner\/properties/, () => t('property.title')], [/^\/owner\/add-tenant/, () => t('owner.addTenant')], [/^\/owner\/record-payment/, () => t('owner.recordPayment')],
    [/^\/owner\/ai/, () => t('owner.askAi')], [/^\/owner\/approvals/, () => t('owner.approvals')], [/^\/owner\/relief/, () => t('relief.title')], [/^\/owner\/message/, () => t('message.title')], [/^\/notifications/, () => t('notifications.title')], [/^\/owner\/import/, () => t('owner.import')],
    [/^\/owner\/report\/collected/, () => t('owner.collected')], [/^\/owner\/report\/pending/, () => t('owner.pending')],
    [/^\/owner\/report\/overdue/, () => t('owner.overdue')], [/^\/owner\/report\/units/, () => t('owner.units')],
    [/^\/owner\/tenancy\//, () => t('titles.renterDetails')], [/^\/owner\/?$/, () => t('titles.ownerDashboard')], [/^\/tenant\/?$/, () => t('titles.renterDashboard')],
    [/^\/tenant\/pay\//, () => t('pay.title')], [/^\/tenant\/rental\//, () => t('titles.rentalDetails')], [/^\/payment-status/, () => t('titles.paymentStatus')],
    [/^\/profile/, () => t('profile.title')], [/^\/help/, () => t('help.title')], [/^\/privacy/, () => t('privacy.title')], [/^\/identity/, () => t('identity.title')],
    [/^\/owner-details/, () => t('ownerDetails.title')], [/^\/plan/, () => t('pricing.selectPlan')], [/^\/sync/, () => t('offline.title')],
  ];
  for (const [re, f] of rules) if (re.test(path)) return f();
  return null;
}

/** Branded top bar on every signed-in screen: back, logo (tap = home), and a one-role-at-a-time strip with a switch link. */
export function DemoBanner() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { me, current, other, busy, toggle } = useRoleSwitch();
  const { gender } = useAuth();
  const page = usePageTitle();
  const both = !!me && me.roles.includes('owner') && me.roles.includes('tenant');
  const [leftW, setLeftW] = React.useState(0);     // widths of the two ends of the header, so the page name never runs into the logo
  const [rightW, setRightW] = React.useState(0);
  const colors: [string, string] = current === 'tenant' ? ['#001F4D', brand.blue600] : [brand.teal900, brand.teal700];
  const roleName = (r: 'owner' | 'tenant') => t(r === 'owner' ? 'role.switchOwner' : 'role.switchTenant');
  return (
    <>
    <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                    style={[styles.header, { paddingTop: insets.top + 8, paddingBottom: 14, flexDirection: 'column', alignItems: 'stretch', gap: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
        {/* left: back + the sunrise logo (tap = home) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} onLayout={(e) => setLeftW(e.nativeEvent.layout.width)}>
          <BackButton />
          <Pressable onPress={() => { markLandingSeen(); router.replace('/'); }} accessibilityRole="button" accessibilityLabel={`${t('app.name')} ${t('help.menuHome')}`} hitSlop={8} testID="logo"
                     style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}>
            <View style={{ marginLeft: -8 }}><RentMeezyBarLogo height={34} light /></View>
          </Pressable>
        </View>
        {/* centre: the page name, equal room on both sides */}
        {me ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, paddingHorizontal: Math.max(leftW, rightW, 96) + 5, alignItems: 'center' }} accessibilityRole="header" testID="page-tab">
            {(() => { const [l1, l2] = splitTitle(page ?? t('help.menuHome'));   // two lines inside the same 44px row, so the panel does not grow
              return (<>
                <Text numberOfLines={1} style={{ color: '#fff', fontSize: 17, lineHeight: 21, fontWeight: '800', textAlign: 'center', letterSpacing: 0.5 }}>{l1.toUpperCase()}</Text>
                {l2 ? <Text numberOfLines={1} style={{ color: '#fff', opacity: 0.85, fontSize: 12, lineHeight: 15, fontWeight: '600', textAlign: 'center' }}>{l2}</Text> : null}
              </>); })()}
          </View>
        ) : null}
        {me ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} onLayout={(e) => setRightW(e.nativeEvent.layout.width)}><BellButton /><MenuButton /></View> : null}
      </View>
      {me && both ? (
        <SwitchSlider current={current} other={other} gender={gender} busy={busy} onSwitch={toggle}
                      name={roleName(current)} hint={t('role.switchTo', { role: roleName(other) })} />
      ) : me ? (
        // one role only: just show it. Adding the other role is a deliberate choice in the menu, not a slide.
        <View style={{ height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.14)', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 }}>
          <RoleIcon role={current} gender={gender} size={34} />
          <Text numberOfLines={1} style={{ flex: 1, color: '#fff', fontSize: 17, fontWeight: '800' }}>{roleName(current)}</Text>
        </View>
      ) : null}
    </LinearGradient>
    <OfflineBanner />
    </>
  );
}

export function Screen({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  const theme = useTheme();
  const body = <View style={styles.pad}>{children}</View>;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <DemoBanner />
      <SlideIn>{scroll ? <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingBottom: 32 }}>{body}</ScrollView> : body}</SlideIn>
    </View>
  );
}

/** A heading on two lines: the first half of the words large, the rest on a second, smaller line. One-word titles stay on one line. */
export function splitTitle(title: string): [string, string] {
  const w = title.trim().split(/\s+/);
  if (w.length < 2) return [title, ''];
  const cut = Math.ceil(w.length / 2);
  return [w.slice(0, cut).join(' '), w.slice(cut).join(' ')];
}

/** Auth screens: gradient hero with the logo, then a white sheet holding the form. */
export function AuthShell({ title, subtitle, icon, note, children }: { title: string; subtitle?: string; icon?: string; note?: string; children: React.ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: brand.teal900 }}>
      <LanguagePill top={insets.top + 10} />
      <LinearGradient colors={[brand.teal900, brand.teal700, brand.teal600]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                      style={[styles.hero, { paddingTop: insets.top + 64, paddingBottom: 80 }]}>
        <View style={{ position: 'absolute', left: 16, top: insets.top + 10 }}><BackButton /></View>
        <LogoWhite width={260} />
        <Text style={styles.heroTag}>{title}</Text>
        {subtitle ? <Text style={styles.heroSub}>{subtitle}</Text> : null}
        {icon ? <View style={styles.badgeCircle}><Icon source={icon} size={30} color="#3B2300" /></View> : null}
      </LinearGradient>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} automaticallyAdjustKeyboardInsets style={[styles.sheet, { backgroundColor: theme.colors.background }]}
                  contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}>
        {children}
        {note ? <Text style={styles.authNote} testID="auth-note">{note}</Text> : null}
      </ScrollView>
    </View>
  );
}

/** The "Done" bar above the iPhone keyboard. Number and phone pads have no Return key, and in a multi-line box Return starts a new line,
 *  so without this the keyboard cannot be closed. Render <DoneBar /> once on the screen and give each text box inputAccessoryViewID={DONE_ID}. */
export const DONE_ID = 'pmr-done-bar';
export function DoneBar() {
  const { t } = useTranslation();
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={DONE_ID}>
      <View style={{ backgroundColor: '#F2F2F7', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#C7C7CC', alignItems: 'flex-end' }}>
        <Pressable onPress={() => Keyboard.dismiss()} accessibilityRole="button" accessibilityLabel={t('common.done')} hitSlop={8} style={{ paddingHorizontal: 18, paddingVertical: 10 }}>
          <Text style={{ color: '#007AFF', fontSize: 17, fontWeight: '600' }}>{t('common.done')}</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

/** A tick inside a text box that closes the keyboard, shown while the box is being typed in. Spread it on a text box that has no Return-to-close key (a number pad,
 *  or a multi-line box where Return starts a new line): <TextInput {...done} />, with `const done = useDoneTick()`. The bar above the iOS keyboard is not reliable and
 *  Android has none, so this is the way to close the keyboard on every phone. */
export function useDoneTick(testID?: string) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return {
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    right: open ? <TextInput.Icon icon="check-circle" onPress={() => Keyboard.dismiss()} accessibilityLabel={t('common.done')} testID={testID ? `${testID}-done` : undefined} /> : undefined,
  };
}

// Every typed value is stored and shown in CAPITAL LETTERS (names, addresses, document numbers, notes ...). Only things where case matters
// stay as typed: e-mail addresses and secret fields. Digits and scripts without capitals (Tamil, Hindi ...) are unaffected.
const KEEP_CASE: (InputKind | undefined)[] = ['email'];
const upper = (v: string) => v.toLocaleUpperCase();

export function Field({ label, value, onChangeText, error, keyboardType, secure, maxLength, testID, multiline, kind, maxPaise, maxNumber, min, lines }: {
  label: string; value: string; onChangeText: (s: string) => void; error?: string; keyboardType?: 'default' | 'number-pad' | 'decimal-pad' | 'phone-pad' | 'email-address';
  secure?: boolean; maxLength?: number; testID?: string; multiline?: boolean; kind?: InputKind;
  maxPaise?: number;     // amount boxes: the most that can be entered here (shown as "Up to"); without it the server's ceiling applies
  maxNumber?: number;    // day / reading boxes: the largest number that can be entered
  min?: number;          // day boxes: the smallest number (typing 0 or less is held at this)
  lines?: number;        // text area: how many lines tall it starts (with multiline)
}) {
  const { t } = useTranslation();
  const caps = !secure && !KEEP_CASE.includes(kind) && keyboardType !== 'email-address';
  const shown = caps ? upper(value) : value;
  // a value that arrives in small letters (saved earlier) is turned into capitals in the form itself, so what is shown is what is sent
  React.useEffect(() => { if (caps && value !== shown) onChangeText(shown); }, [caps, value, shown]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [held, setHeld] = React.useState(false);        // the last thing typed was cut back to the limit
  const ceiling = kind === 'amount' ? Math.min(maxPaise ?? MAX_ENTRY_PAISE, MAX_ENTRY_PAISE) : undefined;
  const change = (v: string) => {
    let x = kind ? sanitize(kind, v) : v;
    let cut = false;
    if (kind === 'amount' && ceiling !== undefined) { const c = capToDue(x, ceiling); x = c.text; cut = c.capped; }
    else if ((kind === 'day' || kind === 'reading' || kind === 'percent') && x !== '' && !x.endsWith('.')) {
      const n = Number(x);
      if (maxNumber !== undefined && n > maxNumber) { x = String(maxNumber); cut = true; }
      else if (min !== undefined && n < min) { x = String(min); cut = true; }
    }
    setHeld(cut);
    onChangeText(caps ? upper(x) : x);
  };
  const limitText = kind === 'amount' && ceiling !== undefined && (maxPaise !== undefined || held) ? t('form.maxAmount', { amount: formatINR(ceiling) })
    : (kind === 'day' || kind === 'reading' || kind === 'percent') && maxNumber !== undefined && held ? t('form.maxNumber', { max: maxNumber }) : undefined;
  const kbType = keyboardType ?? (kind ? keyboardFor(kind) : undefined);
  // number / phone pads have no Return key on iOS (and Return in a multi-line box is a new line), so they get a Done bar that closes the keyboard
  const numeric = Platform.OS === 'ios' && (!!multiline || kbType === 'number-pad' || kbType === 'decimal-pad' || kbType === 'phone-pad');   // also multi-line boxes: Return there starts a new line
  const accId = `done-${React.useId()}`;
  // a number pad has no Return key and Return in a multi-line box is a new line, so those get the tick that closes the keyboard (any phone)
  const pad = kbType === 'number-pad' || kbType === 'decimal-pad' || kbType === 'phone-pad';
  const done = useDoneTick(testID);
  return (
    <View>
      {numeric ? (
        <InputAccessoryView nativeID={accId}>
          <View style={{ backgroundColor: '#F2F2F7', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#C7C7CC', alignItems: 'flex-end' }}>
            <Pressable onPress={() => Keyboard.dismiss()} accessibilityRole="button" accessibilityLabel={t('common.done')} hitSlop={8} style={{ paddingHorizontal: 18, paddingVertical: 10 }}>
              <Text style={{ color: '#007AFF', fontSize: 17, fontWeight: '600' }}>{t('common.done')}</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
      <TextInput mode="outlined" label={label} value={shown} onChangeText={change}
                 returnKeyType={multiline ? undefined : 'done'} blurOnSubmit={multiline ? false : true} onSubmitEditing={multiline ? undefined : () => Keyboard.dismiss()}
                 inputAccessoryViewID={numeric ? accId : undefined}
                 {...(pad || multiline ? { onFocus: done.onFocus, onBlur: done.onBlur, right: done.right } : {})}
                 keyboardType={kbType} secureTextEntry={secure}
                 maxLength={maxLength ?? (kind ? maxLengthFor(kind) : undefined)} autoCorrect={kind === 'email' || kind === 'pan' ? false : undefined}
                 autoCapitalize={!caps ? 'none' : 'characters'} error={!!error} testID={testID} accessibilityLabel={label} multiline={multiline} numberOfLines={multiline ? lines : undefined}
                 outlineStyle={{ borderRadius: radius.md }} style={[{ backgroundColor: '#FFFFFF' }, multiline && lines ? { minHeight: 24 * lines + 32, textAlignVertical: 'top' } : null]} />
      {error ? <HelperText type="error" accessibilityLiveRegion="polite">{t(`error.${error}`, { defaultValue: error })}</HelperText>
        : limitText ? <HelperText type={held ? 'error' : 'info'} accessibilityLiveRegion="polite" testID="field-limit">{limitText}</HelperText> : null}
    </View>
  );
}

export function Money({ paise, style }: { paise: number; style?: object }) {
  return <Text style={[{ fontVariant: ['tabular-nums'] }, style]}>{formatINR(paise)}</Text>;
}

const TONES = {
  green: { bg: brand.green100, fg: brand.green600 },
  amber: { bg: brand.amber100, fg: '#B45309' },
  red: { bg: brand.red100, fg: brand.red600 },
  blue: { bg: brand.blue100, fg: brand.blue600 },
  get teal() { return { bg: brand.teal100, fg: brand.teal700 }; },
  pink: { bg: '#FCE7F3', fg: '#DB2777' },
  violet: { bg: '#EDE9FE', fg: '#7C3AED' },
} as const;
export type Tone = keyof typeof TONES;

export function Metric({ label, paise, count, detail, icon = 'cash', tone = 'teal', onPress, active, tinted, compact }: { label: string; paise?: number; count?: number; detail?: string; icon?: string; tone?: Tone; onPress?: () => void; active?: boolean; tinted?: boolean; compact?: boolean }) {
  const c = TONES[tone];
  if (compact) {   // tile-sized box for the shortcut row: the number first, the name under it, light fill and a very light border
    return (
      <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} testID="metric-compact"
                 style={({ pressed }) => [{ width: '31%', backgroundColor: `${c.fg}12`, borderRadius: radius.lg, borderWidth: active ? 2 : 1.5, borderColor: active ? c.fg : `${c.fg}1A`,
                                            paddingVertical: 14, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', gap: 2 }, shadow, pressed && { backgroundColor: c.bg, transform: [{ scale: 0.96 }] }]}
                 accessible accessibilityLabel={`${label} ${paise !== undefined ? formatINR(paise) : count}${detail ? `, ${detail}` : ''}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon source={icon} size={22} color={c.fg} />
          <Text style={{ fontSize: 28, fontWeight: '800', color: brand.ink, fontVariant: ['tabular-nums'] }}>{paise !== undefined ? formatINR(paise) : count}</Text>
        </View>
        <Text variant="labelLarge" style={{ color: brand.muted, fontWeight: '700' }} numberOfLines={1}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}
               style={({ pressed }) => [styles.metric, shadow, tinted && { backgroundColor: c.bg, borderWidth: 1.5, borderColor: `${c.fg}4D` }, active && { borderWidth: 2, borderColor: c.fg }, pressed && { transform: [{ scale: 0.98 }], backgroundColor: c.bg }]}
               accessible accessibilityLabel={`${label} ${paise !== undefined ? formatINR(paise) : count}${detail ? `, ${detail}` : ''}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={[styles.metricIcon, { backgroundColor: c.bg }]}><Icon source={icon} size={20} color={c.fg} /></View>
        <Text variant="labelMedium" style={{ color: brand.muted, flex: 1 }} numberOfLines={1}>{label}</Text>
      </View>
      <View style={{ height: 10 }} />
      <Text style={styles.metricValue} adjustsFontSizeToFit numberOfLines={1}>{paise !== undefined ? formatINR(paise) : count}</Text>
      {detail ? <Text variant="labelSmall" style={{ color: brand.muted, marginTop: 2 }} numberOfLines={3}>{detail}</Text> : null}
    </Pressable>
  );
}

export function Avatar({ name, size = 44 }: { name?: string | null; size?: number }) {
  const letter = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: brand.teal100, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: brand.teal700, fontWeight: '800', fontSize: size * 0.42 }}>{letter}</Text>
    </View>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  const e = error as ApiError;
  const network = e.code === 'OFFLINE' || e.code === 'TIMEOUT';
  const msg = network ? e.message : e.message || t('error.generic');
  return <Banner visible actions={onRetry ? [{ label: t('common.retry'), onPress: onRetry }] : []} icon="alert-circle" style={styles.errBanner}>{msg}</Banner>;
}

export type Plan = { code: string; label: string; price_paise: number; price_display: string; max_units: number; max_properties?: number;
  regular_price_display?: string | null; saving_percent?: number | null;      // the launch price is price_display; the saving is worked out by the server
  ai_enabled: boolean; ai_monthly_tokens: number; paid_message_units?: number; email_messages?: number };

function Tick({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <Icon source="check-bold" size={18} color={brand.green600} />
      <Text style={{ flex: 1, color: '#111', fontSize: 14, lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

/** The plans as a list of cards, all on one screen: an icon, the name and price, a short tick list, and a Choose button. The most popular plan is marked,
 *  and the chosen plan is outlined in green. Tapping a card or its button selects it. */
export function PricingCards({ onSelect, selected, cardCta, currentPlan, freeMonth = false }: { onSelect?: (code: string) => void; selected?: string | null; cta?: string; cardCta?: string; currentPlan?: string | null; freeMonth?: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => api<{ plans: Plan[] }>('/api/v1/plans', { auth: false }) });
  const plans = q.data?.plans ?? [];
  const n = (v: number) => Number(v).toLocaleString('en-IN');
  return (
    <View style={{ gap: 14 }}>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {plans.map((p) => {
        const active = selected === p.code || (selected === undefined && currentPlan === p.code);
        const popular = p.code === 'growth';
        const name = t(`pricing.name_${p.code}`, { defaultValue: p.label });
        const props = p.max_properties ?? 1;
        return (
          <Pressable key={p.code} onPress={onSelect ? () => onSelect(p.code) : undefined} accessibilityRole="radio" accessibilityState={{ selected: active }} testID={`plan-${p.code}`}
                     style={({ pressed }) => [styles.planCard, shadow, { borderColor: active ? brand.green600 : popular ? '#8CC779' : '#E1E8E1', borderWidth: active ? 2.5 : 1.5 },
                       (active || popular) && { backgroundColor: brand.teal50 }, pressed && { backgroundColor: brand.teal100 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[styles.planIcon, { backgroundColor: brand.teal100 }]}>
                <Icon source={p.code === 'starter' ? 'sprout' : p.code === 'growth' ? 'crown' : p.code === 'max' ? 'crown-outline' : 'domain'} size={28} color={brand.green600} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#111', fontSize: 20, fontWeight: '800' }}>{name}</Text>
                <Text style={{ color: '#111', fontSize: 28, fontWeight: '800' }}>{p.price_display}<Text style={{ color: brand.muted, fontSize: 14, fontWeight: '500' }}> {t('pricing.perMonth')}</Text></Text>
              </View>
              {currentPlan === p.code ? (
                <View style={styles.planBadge}><Text style={styles.planBadgeText}>{t('pricing.current')}</Text></View>
              ) : popular ? (
                <View style={styles.planBadge}><Text style={styles.planBadgeText}>{t('pricing.mostPopular')}</Text></View>
              ) : null}
            </View>
            {freeMonth ? (
              <View style={{ alignSelf: 'flex-start', backgroundColor: brand.green100, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, marginTop: 8 }} testID={`free-${p.code}`}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: brand.green600 }}>{t('pricing.firstMonthFree')}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 12 }}>
              <View style={{ flex: 1, gap: 7 }}>
                <Tick text={t('pricing.units', { count: p.max_units })} />
                <Tick text={t('pricing.props', { count: props })} />
                <Tick text={t('pricing.b_bills')} />
                {p.ai_enabled ? <Tick text={t('pricing.ai_short')} /> : null}
              </View>
              <Pressable onPress={onSelect ? () => onSelect(p.code) : undefined} accessibilityRole="button" testID={`choose-${p.code}`}
                         style={({ pressed }) => [styles.planBtn, active && { backgroundColor: brand.green600 }, pressed && { opacity: 0.85 }]}>
                {active ? <Icon source="check" size={18} color="#fff" /> : null}
                <Text style={[styles.planBtnText, active && { color: '#fff' }]} numberOfLines={1}>{active ? t('pricing.selected') : (cardCta ?? t('pricing.chooseNamed', { name }))}</Text>
              </Pressable>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Current plan summary with a link to change it. `compact` = single tappable row (owner home). */
export function PlanCard({ owner, compact = false }: { owner: string | null; compact?: boolean }) {
  const { t } = useTranslation();
  const sub = useQuery({ queryKey: ['sub', owner], enabled: !!owner, queryFn: () => api<any>('/api/v1/subscription', { ownerAccount: owner }) });
  const d = sub.data;
  if (!d) return null;
  const plan = String(d.current?.plan_code ?? '—');
  const label = plan.charAt(0).toUpperCase() + plan.slice(1);
  const bad = d.state === 'read_only' || d.state === 'none' || d.state === 'grace';
  const go = () => router.push('/(onboarding)/plan');
  const end = fmtDate(String(d.current?.period_end ?? ''));
  if (compact) {
    return (
      <Pressable onPress={go} accessibilityRole="button" accessibilityLabel={`${label} ${t('pricing.change')}`} testID="plan-link"
                 style={({ pressed }) => [styles.planRow, shadow, pressed && { backgroundColor: brand.teal50 }]}>
        <View style={[styles.planIcon, { width: 40, height: 40, borderRadius: 13, backgroundColor: bad ? brand.amber100 : brand.teal100 }]}>
          <Icon source="crown" size={22} color={bad ? '#B45309' : brand.teal700} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="titleSmall" style={{ fontWeight: '800' }}>{label}</Text>
          <Text variant="bodySmall" style={{ color: brand.muted }}>{`${d.units_used}/${d.units_capacity}`}{end ? ` · ${end}` : ''}</Text>
        </View>
        <Text style={{ color: brand.teal700, fontWeight: '800' }}>{t('pricing.change')}</Text>
        <Icon source="chevron-right" size={20} color={brand.teal700} />
      </Pressable>
    );
  }
  return (
    <View style={[styles.planBox, shadow]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={[styles.planIcon, { backgroundColor: brand.teal100 }]}><Icon source="crown" size={26} color={brand.teal700} /></View>
        <View style={{ flex: 1 }}>
          <Text variant="titleMedium" style={{ fontWeight: '800' }}>{label}</Text>
          <Text variant="bodySmall" style={{ color: bad ? '#B45309' : brand.muted }}>{`${d.state}${end ? ` · ${end}` : ''}`}</Text>
        </View>
      </View>
      <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 12 }}>{`${d.units_used}/${d.units_capacity}`}</Text>
      <UsageBar used={d.units_used} allowance={d.units_capacity} />
      {d.ai ? (
        <>
          <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 10 }}>{t('ai.usage', { used: d.ai.tokens_consumed, allowance: d.ai.token_allowance, date: fmtDate(String(d.ai.period_end)) })}</Text>
          <UsageBar used={d.ai.tokens_consumed} allowance={d.ai.token_allowance} />
        </>
      ) : null}
      <View style={{ marginTop: 14 }}><AppButton variant="soft" icon="swap-horizontal" label={t('pricing.change')} onPress={go} testID="change-plan" /></View>
    </View>
  );
}

/** White rounded card with soft shadow; optional titled header with a tinted icon. */
export function Panel({ children, title, icon, tone = 'teal', style }: { children: React.ReactNode; title?: string; icon?: string; tone?: Tone; style?: object }) {
  const c = TONES[tone];
  return (
    <View style={[styles.panel, shadow, style]}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          {icon ? <View style={[styles.panelIcon, { backgroundColor: c.bg }]}><Icon source={icon} size={18} color={c.fg} /></View> : null}
          <Text variant="titleSmall" style={{ fontWeight: '800' }}>{title}</Text>
        </View>
      ) : null}
      <View style={{ gap: 12 }}>{children}</View>
    </View>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  paid: 'green', confirmed: 'green', active: 'green', settled: 'green', open: 'amber', pending: 'amber', proposed: 'amber', invited: 'blue',
  partial: 'amber', overdue: 'red', failed: 'red', disputed: 'red', ended: 'blue', issued: 'blue', draft: 'blue',
};
export function StatusPill({ status }: { status: string }) {
  const c = TONES[STATUS_TONE[String(status).toLowerCase()] ?? 'teal'];
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: '800', textTransform: 'capitalize' }}>{String(status).replace(/_/g, ' ')}</Text>
    </View>
  );
}

/** Big gradient figure card (amount due, receipt total…). */
export function AmountHero({ label, paise, caption, icon = 'wallet', tone = 'teal', compact = false }: { label: string; paise: number; caption?: string; icon?: string; tone?: 'teal' | 'amber' | 'green'; compact?: boolean }) {
  const colors = tone === 'amber' ? ['#B45309', '#F59E0B'] as const : tone === 'green' ? [brand.green600, brand.green600] as const : [brand.teal900, brand.teal600] as const;
  if (compact) {                    // one slim row: label on the left, the amount on the right
    return (
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md }}
                      accessible accessibilityLabel={`${label} ${formatINR(paise)}`}>
        <Icon source={icon} size={18} color="rgba(255,255,255,0.9)" />
        <Text style={{ color: 'rgba(255,255,255,0.92)', fontWeight: '700', flex: 1 }} numberOfLines={1}>{label}</Text>
        <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] }} adjustsFontSizeToFit numberOfLines={1}>{formatINR(paise)}</Text>
      </LinearGradient>
    );
  }
  return (
    <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.amountHero}>
      <View style={styles.amountDeco} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon source={icon} size={20} color="rgba(255,255,255,0.9)" />
        <Text style={{ color: 'rgba(255,255,255,0.9)', fontWeight: '700' }}>{label}</Text>
      </View>
      <Text style={styles.amountBig} adjustsFontSizeToFit numberOfLines={1}>{formatINR(paise)}</Text>
      {caption ? <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>{caption}</Text> : null}
    </LinearGradient>
  );
}

/** Full-screen outcome: big coloured icon, title, detail lines, actions. */
export function ResultView({ kind, title, lines = [], hint, error, children }: {
  kind: 'success' | 'failed' | 'pending' | 'review'; title: string; lines?: string[]; hint?: string; error?: unknown; children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    if (kind !== 'pending') return;
    const id = setTimeout(() => setSlow(true), 20000);
    return () => clearTimeout(id);
  }, [kind]);
  const cfg = kind === 'success' ? { icon: 'check-bold', bg: brand.green600, ring: brand.green100 }
    : kind === 'failed' ? { icon: 'close-thick', bg: brand.red600, ring: brand.red100 }
    : kind === 'review' ? { icon: 'account-search', bg: brand.blue600, ring: brand.blue100 } : { icon: 'timer-sand', bg: brand.amber500, ring: brand.amber100 };
  return (
    <View style={{ alignItems: 'center', gap: 14, paddingTop: 24 }}>
      <View style={{ width: 132, height: 132, borderRadius: 66, backgroundColor: cfg.ring, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 92, height: 92, borderRadius: 46, backgroundColor: cfg.bg, alignItems: 'center', justifyContent: 'center', ...shadow }}>
          {kind === 'pending' ? <ActivityIndicator size="large" color="#fff" /> : <Icon source={cfg.icon} size={48} color="#fff" />}
        </View>
      </View>
      <Text variant="headlineSmall" style={{ fontWeight: '800', textAlign: 'center' }} accessibilityRole="alert" accessibilityLiveRegion="polite">{title}</Text>
      {lines.map((l, i) => <Text key={i} style={{ color: brand.muted, textAlign: 'center' }}>{l}</Text>)}
      {(kind === 'pending' || kind === 'review') && hint ? <Text style={{ color: brand.muted, textAlign: 'center' }}>{hint}</Text> : null}
      {kind === 'pending' && slow && !error ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: brand.amber100, borderRadius: radius.md, padding: 12 }}>
          <Icon source="timer-sand" size={20} color="#B45309" /><Text style={{ flex: 1, color: '#92400E' }}>{t('common.slow')}</Text>
        </View>
      ) : null}
      {error ? <View style={{ alignSelf: 'stretch' }}><ErrorBanner error={error} /></View> : null}
      <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 8 }}>{children}</View>
    </View>
  );
}

/** Pill-style tab switcher with icons (replaces SegmentedButtons on detail screens). */
export function TabPills({ value, onChange, tabs }: { value: string; onChange: (v: string) => void; tabs: { value: string; label: string; icon: string }[] }) {
  return (
    <View style={live.tabs}>
      {tabs.map((tb) => {
        const on = tb.value === value;
        return (
          <Pressable key={tb.value} onPress={() => onChange(tb.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
                     style={({ pressed }) => [styles.tab, on && { backgroundColor: brand.teal700 }, !on && pressed && { backgroundColor: brand.teal100 }]}>
            <Icon source={tb.icon} size={18} color={on ? '#fff' : brand.teal700} />
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ fontSize: 11, fontWeight: '800', color: on ? '#fff' : brand.teal700 }}>{tb.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip2({ label, icon, onPress }: { label: string; icon?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [live.chip, pressed && { backgroundColor: brand.teal100 }]}>
      {icon ? <Icon source={icon} size={16} color={brand.teal700} /> : null}
      <Text style={{ color: brand.teal700, fontWeight: '800', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

// ───────────── list filters (owner renters list and renter home) ─────────────
export type ListFilter = { kind: 'all' | KindGroup; pay: 'all' | 'paid' | 'unpaid' };
export const NO_FILTER: ListFilter = { kind: 'all', pay: 'all' };
const kindOf = (x: any): string => kindGroup(x.unit_kind ?? x.kind);
const isUnpaid = (x: any): boolean => Number(x.balance_paise ?? 0) > 0;
export function applyFilter<T>(items: T[], f: ListFilter): T[] {
  return items.filter((x: any) => (f.kind === 'all' || kindOf(x) === f.kind) && (f.pay === 'all' || (f.pay === 'unpaid') === isUnpaid(x)));
}

/** One row of tap-to-filter chips: All · Residential only · Commercial only · Paid up · Unpaid (each with its count). A kind chip and a
 *  payment chip combine (e.g. Houses only + Unpaid); tapping a selected chip clears it; "All" clears both. */
export function FilterBar({ items, value, onChange }: { items: any[]; value: ListFilter; onChange: (f: ListFilter) => void }) {
  const { t } = useTranslation();
  const count = (f: ListFilter) => applyFilter(items, f).length;
  const chip = (label: string, n: number, selected: boolean, icon: string, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${label} ${n}`}
               style={[live.chip, selected && { backgroundColor: brand.teal700, borderColor: brand.teal700 }]}>
      <Icon source={icon} size={16} color={selected ? '#fff' : brand.teal700} />
      <Text style={{ color: selected ? '#fff' : brand.teal700, fontWeight: '800', fontSize: 13 }}>{`${label} (${n})`}</Text>
    </Pressable>
  );
  const none = value.kind === 'all' && value.pay === 'all';
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {chip(t('filters.all'), items.length, none, 'view-list-outline', () => onChange(NO_FILTER))}
      {chip(t('filters.residential'), count({ ...NO_FILTER, kind: 'residential' }), value.kind === 'residential', 'home-variant-outline', () => onChange({ ...value, kind: value.kind === 'residential' ? 'all' : 'residential' }))}
      {chip(t('filters.commercial'), count({ ...NO_FILTER, kind: 'commercial' }), value.kind === 'commercial', 'office-building-outline', () => onChange({ ...value, kind: value.kind === 'commercial' ? 'all' : 'commercial' }))}
      {chip(t('filters.paid'), count({ ...NO_FILTER, pay: 'paid' }), value.pay === 'paid', 'check-circle-outline', () => onChange({ ...value, pay: value.pay === 'paid' ? 'all' : 'paid' }))}
      {chip(t('filters.unpaid'), count({ ...NO_FILTER, pay: 'unpaid' }), value.pay === 'unpaid', 'clock-alert-outline', () => onChange({ ...value, pay: value.pay === 'unpaid' ? 'all' : 'unpaid' }))}
    </ScrollView>
  );
}

/** Identity verification status row: tap to open the verification screen. */
export function IdentityRow() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const st = me?.identity_status ?? 'none';
  const tone = st === 'verified' ? TONES.green : st === 'failed' || st === 'rejected' ? TONES.red : st === 'none' ? TONES.blue : TONES.amber;
  return (
    <Pressable onPress={() => router.push('/(onboarding)/identity')} accessibilityRole="button" testID="identity-link"
               style={({ pressed }) => [styles.planRow, shadow, pressed && { backgroundColor: brand.teal50 }]}>
      <View style={[styles.planIcon, { width: 40, height: 40, borderRadius: 13, backgroundColor: tone.bg }]}>
        <Icon source={st === 'verified' ? 'shield-check' : 'face-recognition'} size={22} color={tone.fg} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="titleSmall" style={{ fontWeight: '800' }}>{t('identity.title')}</Text>
        <Text variant="bodySmall" style={{ color: tone.fg, fontWeight: '700' }}>{t(`identity.${st}`)}</Text>
      </View>
      <Icon source="chevron-right" size={20} color={brand.muted} />
    </Pressable>
  );
}

export function UsageBar({ used, allowance }: { used: number; allowance: number }) {
  return <ProgressBar progress={allowance ? Math.min(1, used / allowance) : 0} accessibilityLabel={`${used} / ${allowance}`} style={{ height: 8, borderRadius: 4 }} />;
}

export { Card };

const styles = StyleSheet.create({
  pad: { padding: 16, gap: 12 },
  back: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  planBadge: { backgroundColor: brand.green600, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, alignSelf: 'flex-start' },
  planBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  planBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', minWidth: 120, maxWidth: 170, height: 46, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5, borderColor: brand.green600, backgroundColor: '#fff' },
  planBtnText: { color: brand.green600, fontSize: 15, fontWeight: '800' },
  hero: { alignItems: 'center', paddingBottom: 44, paddingHorizontal: 24, gap: 6 },
  heroTag: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 18, textAlign: 'center' },
  authNote: { textAlign: 'center', color: '#000', fontSize: 15, lineHeight: 22, marginTop: 8 },
  heroSub: { color: 'rgba(255,255,255,0.8)', fontSize: 14, textAlign: 'center' },
  badgeCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: brand.amber500, alignItems: 'center', justifyContent: 'center', marginTop: 14, borderWidth: 4, borderColor: 'rgba(255,255,255,0.35)' },
  sheet: { flex: 1, marginTop: -26, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  metric: { flex: 1, minWidth: '46%', backgroundColor: '#fff', borderRadius: radius.lg, padding: 14 },
  metricIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  metricValue: { fontSize: 22, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  errBanner: { borderRadius: radius.md, marginVertical: 6 },
  cards: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  planCard: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16, borderWidth: 2 },
  panel: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16 },
  panelIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  amountHero: { borderRadius: radius.lg + 4, padding: 20, gap: 6, overflow: 'hidden' },
  amountDeco: { position: 'absolute', right: -40, top: -40, width: 160, height: 160, borderRadius: 80, backgroundColor: 'rgba(255,255,255,0.10)' },
  amountBig: { color: '#fff', fontSize: 38, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 8, paddingHorizontal: 2, borderRadius: radius.sm + 2 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 12 },
  planBox: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16 },
  planIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  expandBtn: { alignSelf: 'center', marginTop: 8, width: 40, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: 4 },
  arrow: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  price: { fontSize: 26, fontWeight: '800' },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: brand.line, marginTop: 10 },
  star: { position: 'absolute', top: -10, right: 10, backgroundColor: brand.amber500, borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
});


/** Live result of the amount being typed: what is still owed after it (or the advance if it is more than the due). One slim row. */
export function BalancePreview({ duePaise, paise }: { duePaise: number; paise: number | null }) {
  const { t } = useTranslation();
  if (!paise) return null;
  const left = duePaise - paise;
  const settled = left === 0;
  const advance = left < 0;
  const fg = settled || advance ? brand.green600 : '#B45309';
  const bg = settled || advance ? brand.green100 : brand.amber100;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: radius.md, backgroundColor: bg }} accessibilityLiveRegion="polite" testID="balance-preview">
      <Icon source={settled ? 'check-circle-outline' : advance ? 'piggy-bank-outline' : 'clock-outline'} size={20} color={fg} />
      <Text style={{ flex: 1, color: fg, fontWeight: '700' }}>{settled ? t('pay.fullySettled') : advance ? t('pay.advanceAfter') : t('pay.remainingAfter')}</Text>
      <Text style={{ color: fg, fontWeight: '800', fontSize: 18, fontVariant: ['tabular-nums'] }}>{formatINR(Math.abs(left))}</Text>
    </View>
  );
}

const live = {   // read when drawn, so they follow the role in use
  get tabs(): ViewStyle { return { flexDirection: 'row', backgroundColor: brand.teal50, borderRadius: radius.md, padding: 4, gap: 4, borderWidth: 1, borderColor: brand.line }; },
  get chip(): ViewStyle { return { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: brand.teal50, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: brand.teal100 }; },
};
