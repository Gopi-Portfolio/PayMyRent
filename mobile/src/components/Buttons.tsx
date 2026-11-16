// Branded buttons with visible press feedback (colour shift + slight scale) and optional icon.
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { brand, radius } from '@/theme';

type Props = {
  label: string; onPress?: () => void; icon?: string; loading?: boolean; disabled?: boolean; testID?: string;
  variant?: 'primary' | 'accent' | 'outline' | 'soft' | 'green' | 'blue'; compact?: boolean;
};

const PALETTE = {  // getters: read when drawn, so the colours follow the role in use
  get primary() { return { bg: [brand.teal600, brand.teal700] as const, bgPressed: [brand.teal900, brand.teal900] as const, fg: '#fff' }; },
  get accent() { return { bg: ['#FBBF24', brand.amber500] as const, bgPressed: ['#D97706', '#B45309'] as const, fg: '#3B2300' }; },
  get green() { return { bg: [brand.green600, brand.green600] as const, bgPressed: ['#176B01', '#176B01'] as const, fg: '#fff' }; },   // owner actions
  get blue() { return { bg: [brand.blue600, brand.blue600] as const, bgPressed: ['#00244F', '#00244F'] as const, fg: '#fff' }; },     // renter actions
  get outline() { return { bg: ['#fff', '#fff'] as const, bgPressed: [brand.teal100, brand.teal100] as const, fg: brand.teal700 }; },
  get soft() { return { bg: [brand.teal50, brand.teal100] as const, bgPressed: [brand.tealSoft, brand.tealSoft] as const, fg: brand.teal700 }; },
};

export function AppButton({ label, onPress, icon, loading, disabled, testID, variant = 'primary', compact }: Props) {
  const p = PALETTE[variant];
  const off = disabled || loading;
  return (
    <Pressable onPress={off ? undefined : onPress} disabled={off} testID={testID} accessibilityRole="button" accessibilityLabel={label}
               accessibilityState={{ disabled: !!off, busy: !!loading }}>
      {({ pressed }) => (
        <LinearGradient colors={off ? ['#CBD5D1', '#CBD5D1'] : pressed ? p.bgPressed : p.bg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                        style={[styles.btn, compact && { height: 44 }, variant === 'outline' && live.outline,
                                pressed && { transform: [{ scale: 0.98 }] }, !off && variant !== 'outline' && live.glow]}>
          {loading ? <ActivityIndicator color={p.fg} size="small" /> : icon ? <Icon source={icon} size={20} color={off ? '#fff' : p.fg} /> : null}
          <Text style={[styles.label, { color: off ? '#fff' : p.fg }]}>{label}</Text>
        </LinearGradient>
      )}
    </Pressable>
  );
}

export function ButtonRow({ children }: { children: React.ReactNode }) {
  return <View style={{ gap: 10 }}>{children}</View>;
}

const styles = StyleSheet.create({
  btn: { height: 54, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
  label: { fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  textBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.sm },
});

/** Drop-in replacement for react-native-paper's Button (same props we use) with branded press feedback. */
type CompatProps = {
  mode?: 'text' | 'outlined' | 'contained' | 'contained-tonal' | 'elevated'; icon?: string; compact?: boolean; disabled?: boolean;
  loading?: boolean; onPress?: () => void; textColor?: string; testID?: string; contentStyle?: object; style?: object; children?: React.ReactNode;
};

export function Button({ mode = 'text', icon, compact, disabled, loading, onPress, textColor, testID, children }: CompatProps) {
  const label = React.Children.toArray(children).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : '')).join('');
  if (mode === 'contained') return <AppButton label={label} icon={icon} disabled={disabled} loading={loading} onPress={onPress} testID={testID} compact={compact} />;
  if (mode === 'contained-tonal' || mode === 'elevated') return <AppButton variant="soft" label={label} icon={icon} disabled={disabled} loading={loading} onPress={onPress} testID={testID} compact={compact} />;
  if (mode === 'outlined') return <AppButton variant="outline" label={label} icon={icon} disabled={disabled} loading={loading} onPress={onPress} testID={testID} compact={compact} />;
  const color = disabled ? '#9AAAA6' : textColor ?? brand.teal700;
  return (
    <Pressable onPress={disabled || loading ? undefined : onPress} disabled={disabled || loading} testID={testID} accessibilityRole="button" accessibilityLabel={label}
               style={({ pressed }) => [styles.textBtn, compact && { paddingVertical: 6, paddingHorizontal: 8 }, pressed && { backgroundColor: textColor === 'crimson' ? brand.red100 : brand.teal100 }]}>
      {loading ? <ActivityIndicator size="small" color={color} /> : icon ? <Icon source={icon} size={18} color={color} /> : null}
      <Text style={{ color, fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

const live = {   // read when drawn, so they follow the role in use
  get outline(): ViewStyle { return { borderWidth: 1.5, borderColor: brand.teal600 }; },
  get glow(): ViewStyle { return { shadowColor: brand.teal700, shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 4 }; },
};
