// The owner's shortcuts. The two things done most, Add Renter and Record Payment, are big bold cards you can hit without looking;
// everything else is a row of small buttons underneath. No outlines: colour, a soft shadow and a press animation do the work.
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { brand, radius, shadow } from '@/theme';

/** A big action card: gradient, large icon on a soft disc, the action's name and one line saying what it is for. */
export function HeroAction({ icon, label, sub, note, colors, onPress, testID }: {
  icon: string; label: string; sub?: string; note?: { label: string; value: string | number }; colors: readonly [string, string]; onPress: () => void; testID?: string;   // note: a small label next to the icon with its number under it, e.g. "Vacant" over "3"
}) {
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={[label, sub, note ? `${note.value} ${note.label}` : ''].filter(Boolean).join('. ')} style={({ pressed }) => [{ flex: 1 }, pressed && { transform: [{ scale: 0.97 }] }]}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.hero, shadow]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>   {/* the icon and the arrow share one row, so their centres line up */}
          <View style={styles.disc}><Icon source={icon} size={26} color="#fff" /></View>
          {note ? (
            <View style={styles.note} testID="hero-note">
              <Text numberOfLines={1} style={styles.noteLabel}>{note.label}</Text>
              <Text numberOfLines={1} style={styles.noteValue} testID="hero-note-value">{note.value}</Text>
            </View>
          ) : null}
          <View style={styles.arrow}><Icon source="arrow-right" size={16} color="#fff" /></View>
        </View>
        <View style={{ flex: 1, justifyContent: 'flex-start' }}>
          <Text numberOfLines={2} style={styles.heroLabel}>{label}</Text>
          {sub ? <Text numberOfLines={1} style={styles.heroSub}>{sub}</Text> : null}
        </View>
      </LinearGradient>
    </Pressable>
  );
}

/** A small button for the other shortcuts: tinted icon, short label, an optional number (waiting items) and a selected state. */
export function MiniAction({ icon, label, fg, bg, count, clearText, active, onPress, testID }: {
  icon: string; label: string; fg: string; bg: string; count?: number; clearText?: string; active?: boolean; onPress: () => void; testID?: string;
}) {
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityState={{ selected: !!active }} accessibilityLabel={count ? `${label}, ${count}` : clearText ? `${label}, ${clearText}` : label}
               style={({ pressed }) => [styles.mini, shadow, active && { backgroundColor: bg }, pressed && { transform: [{ scale: 0.96 }], backgroundColor: bg }]}>
      <View style={[styles.miniIcon, { backgroundColor: active ? '#fff' : bg }]}>
        <Icon source={icon} size={20} color={fg} />
        {count ? <View style={[styles.count, { backgroundColor: fg }]} testID="mini-count"><Text style={styles.countText}>{count > 99 ? '99+' : count}</Text></View>
          : clearText ? <View style={[styles.count, { backgroundColor: brand.green600, minWidth: 18, paddingHorizontal: 0 }]} testID="mini-clear"><Icon source="check" size={11} color="#fff" /></View> : null}
      </View>
      <Text numberOfLines={1} style={[styles.miniLabel, active && { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { height: 148, borderRadius: radius.lg, padding: 14, flexDirection: 'column', gap: 10 },
  disc: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  note: { flex: 1, minWidth: 44 },
  noteLabel: { color: 'rgba(255,255,255,0.92)', fontSize: 11, lineHeight: 13, fontWeight: '700' },
  noteValue: { color: '#fff', fontSize: 18, lineHeight: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  heroLabel: { color: '#fff', fontSize: 16, lineHeight: 20, fontWeight: '800' },
  heroSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600', marginTop: 1 },
  arrow: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  mini: { flex: 1, minWidth: 72, alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 4, backgroundColor: '#fff', borderRadius: radius.md },
  miniIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  miniLabel: { fontSize: 12, fontWeight: '700', color: '#3B4A47', textAlign: 'center' },
  count: { position: 'absolute', top: -5, right: -7, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#fff' },
  countText: { color: '#fff', fontSize: 10, fontWeight: '800' },
});

/** A full-width button row: icon, name, one line of explanation, and either a number (things waiting) or a calm "all clear". Always shown, so it looks the same for everyone. */
export function WideAction({ icon, label, sub, fg, bg, count, clearText, onPress, testID }: {
  icon: string; label: string; sub?: string; fg: string; bg: string; count?: number; clearText: string; onPress: () => void; testID?: string;
}) {
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={`${label}, ${count ? count : clearText}`}
               style={({ pressed }) => [wide.row, shadow, pressed && { backgroundColor: bg, transform: [{ scale: 0.98 }] }]}>
      <View style={[wide.icon, { backgroundColor: bg }]}><Icon source={icon} size={22} color={fg} /></View>
      <View style={{ flex: 1 }}>
        <Text style={wide.label}>{label}</Text>
        {sub ? <Text numberOfLines={1} style={wide.sub}>{sub}</Text> : null}
      </View>
      {count ? (
        <View style={[wide.pill, { backgroundColor: fg }]} testID="approvals-count"><Text style={wide.pillText}>{count > 99 ? '99+' : count}</Text></View>
      ) : (
        <View style={[wide.pill, { backgroundColor: brand.green100 }]} testID="approvals-clear"><Icon source="check" size={13} color={brand.green600} /><Text style={[wide.pillText, { color: brand.green600 }]}>{clearText}</Text></View>
      )}
      <Icon source="chevron-right" size={20} color="#8A9A96" />
    </Pressable>
  );
}

const wide = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 14 },
  icon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 15, fontWeight: '800', color: '#10201D' },
  sub: { fontSize: 12, color: '#5B6B67', marginTop: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 28, height: 26, borderRadius: 13, paddingHorizontal: 9, justifyContent: 'center' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '800' },
});
