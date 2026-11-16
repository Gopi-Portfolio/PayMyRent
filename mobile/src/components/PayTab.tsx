// Centre "Pay" button of the tenant tab bar. Enabled only when something is due; opens a bottom sheet
// (same look as the dropdown pickers) to choose which rental to pay, then goes to that rental's payment screen.
import { useQuery } from '@tanstack/react-query';
import { router, usePathname } from 'expo-router';
import React from 'react';
import { Animated, FlatList, Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api';
import { formatINR, payNow } from '@/lib/format';
import { useOnline } from '@/lib/network';
import { OWNER_COLORS, brand, radius, shadow } from '@/theme';

// `payer` is false while signed in as an owner: owners do not pay rent, so the slider stays locked.
export function PayTabButton({ payer = true }: { payer?: boolean }) {
  const { t } = useTranslation();
  const rentals = useQuery({ queryKey: ['rentals'], queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const owners: string[] = [];
  const due = (rentals.data?.items ?? [])
    .filter((r: any) => r.status === 'active' && payNow(r) > 0)
    .map((r: any) => { if (!owners.includes(r.owner_account_id)) owners.push(r.owner_account_id);
                       return { ...r, color: OWNER_COLORS[owners.indexOf(r.owner_account_id) % OWNER_COLORS.length] }; });
  const onPayScreen = usePathname().includes('/pay/') || usePathname().endsWith('/pay');   // already paying: nothing more to open
  const online = useOnline();                            // paying needs the internet: the slider is switched off while offline
  const enabled = payer && due.length > 0 && !onPayScreen && online;
  const totalDue = due.reduce((n: number, r: any) => n + payNow(r), 0);

  // slide-to-pay: drag the icon from left to right past 70% of the track to open the list of rentals to pay
  const PAD = 2;
  const [trackW, setTrackW] = React.useState(0);
  const [handleW, setHandleW] = React.useState(60);   // the handle is as wide as the amount it shows
  const x = React.useRef(new Animated.Value(0)).current;
  const max = Math.max(0, trackW - handleW - PAD * 2);
  const maxRef = React.useRef(0); maxRef.current = max;
  const enabledRef = React.useRef(false); enabledRef.current = enabled;
  // one rental with a balance: go straight to its payment screen; several: choose which one first
  const dueRef = React.useRef<any[]>([]); dueRef.current = due;
  const go = React.useCallback(() => {
    const d = dueRef.current;
    if (d.length === 1) router.push(`/(app)/tenant/pay/${d[0].id}`); else if (d.length > 1) router.push('/(app)/tenant/pay');
  }, []);
  const busyRef = React.useRef(false);
  const pan = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => enabledRef.current && !busyRef.current,
    onStartShouldSetPanResponderCapture: () => enabledRef.current && !busyRef.current,   // claim the touch before any parent screen can
    onMoveShouldSetPanResponder: () => enabledRef.current && !busyRef.current,
    onMoveShouldSetPanResponderCapture: () => enabledRef.current && !busyRef.current,
    onPanResponderMove: (_, g) => x.setValue(Math.min(maxRef.current, Math.max(0, g.dx))),
    onPanResponderRelease: (_, g) => {
      const m = maxRef.current;
      if (m > 0 && g.dx >= m * 0.7) {
        busyRef.current = true;
        Animated.timing(x, { toValue: m, duration: 120, useNativeDriver: false }).start(() => {
          go();
          setTimeout(() => { x.setValue(0); busyRef.current = false; }, 300);
        });
      } else Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
    },
    onPanResponderTerminationRequest: () => false,      // keep the drag; never hand it to a screen-swipe gesture
    onShouldBlockNativeResponder: () => true,
    onPanResponderTerminate: () => { Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(); },
  }), [x, go]);
  const fade = x.interpolate({ inputRange: [0, Math.max(1, max)], outputRange: [1, 0], extrapolate: 'clamp' });

  return (
    <View style={styles.slot}>
      <View {...pan.panHandlers} onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} testID="tab-pay"
            accessible accessibilityRole="adjustable" accessibilityLabel={enabled ? t('pay.tab') : `${t('pay.tab')}: ${online ? t('pay.nothingDue') : t('offline.payNeedsInternet')}`}
            accessibilityState={{ disabled: !enabled }} accessibilityActions={enabled ? [{ name: 'activate', label: t('pay.tab') }] : []}
            onAccessibilityAction={() => enabled && go()}
            style={[styles.track, { backgroundColor: enabled ? '#DCE8F7' : brand.disabledBg }]}>
        <Animated.View style={{ position: 'absolute', right: 8, opacity: fade }}>
          <Icon source="chevron-double-right" size={20} color={enabled ? '#003472' : '#B8C4C0'} />
        </Animated.View>
        <Animated.View onLayout={(e) => setHandleW(e.nativeEvent.layout.width)}
                       style={[styles.handle, { backgroundColor: enabled ? '#003472' : '#D5DEDB', transform: [{ translateX: x }] }, enabled && shadow]}>
          {enabled ? <Text numberOfLines={1} style={{ fontWeight: '800', fontSize: 14, color: '#fff' }}>{t('pay.tab')}</Text>
                 : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Icon source="lock-outline" size={16} color="#9AA9A5" /><Text numberOfLines={1} style={{ fontWeight: '800', fontSize: 14, color: brand.disabled }}>{t('pay.tab')}</Text></View>}
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  track: { alignSelf: 'stretch', marginHorizontal: 10, height: 40, borderRadius: radius.pill, justifyContent: 'center', alignItems: 'flex-start', padding: 2 },
  handle: { minWidth: 36, height: 36, borderRadius: 18, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { maxHeight: '75%', backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 14, paddingBottom: 32 },
  grab: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: '#C5D2CE', marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 6, borderRadius: radius.md },
});
