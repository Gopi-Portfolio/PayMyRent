// The owner's shortcuts. The two things done most, Add Renter and Record Payment, are big bold cards you can hit without looking;
// everything else is a row of small buttons underneath. No outlines: colour, a soft shadow and a press animation do the work.
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { brand, radius, shadow } from '@/theme';

export type ActionCard = { key: string; icon: string; title: string; message: string; footnote?: string; lead?: boolean; onPress: () => void; testID?: string };

const CARD_GAP = 12;
const CARD_SHARE = 0.8;          // each card takes this much of the width, so the next one peeks in from the edge and shows there is more to swipe to

/** The main actions as wide cards you swipe left and right. Each card says what it does in a sentence; the one that is the owner's most common action is solid green. */
export function ActionCarousel({ cards }: { cards: ActionCard[] }) {
  const [width, setWidth] = React.useState(0);
  const [index, setIndex] = React.useState(0);
  const cardW = Math.round(width * CARD_SHARE);
  const step = cardW + CARD_GAP;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} testID="action-carousel" style={{ gap: 10 }}>
      {width > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={step} snapToAlignment="start" decelerationRate="fast" disableIntervalMomentum
                    scrollEventThrottle={16} onScroll={(e) => setIndex(Math.max(0, Math.min(cards.length - 1, Math.round(e.nativeEvent.contentOffset.x / step))))}
                    contentContainerStyle={{ gap: CARD_GAP, paddingRight: Math.max(0, width - cardW) }} testID="action-scroll">
          {cards.map((c) => {
            const fg = c.lead ? '#fff' : brand.ink;
            const soft = c.lead ? 'rgba(255,255,255,0.88)' : brand.muted;
            const chip = c.lead ? 'rgba(255,255,255,0.22)' : brand.green100;
            const accent = c.lead ? '#fff' : brand.green600;
            const body = (
              <>
                <View style={styles.cardTop}>
                  <View style={[styles.cardIcon, { backgroundColor: chip }]}><Icon source={c.icon} size={28} color={accent} /></View>
                  <View style={[styles.cardArrow, { backgroundColor: chip }]}><Icon source="arrow-right" size={18} color={accent} /></View>
                </View>
                <Text style={[styles.cardTitle, { color: fg }]}>{c.title}</Text>
                <Text style={[styles.cardMessage, { color: soft }]}>{c.message}</Text>
                {c.footnote ? <View style={[styles.cardNote, { backgroundColor: chip }]}><Text style={[styles.cardNoteText, { color: accent }]}>{c.footnote}</Text></View> : null}
              </>
            );
            return (
              <Pressable key={c.key} onPress={c.onPress} testID={c.testID} accessibilityRole="button" accessibilityLabel={`${c.title}. ${c.message}${c.footnote ? `. ${c.footnote}` : ''}`}
                         style={({ pressed }) => [{ width: cardW }, pressed && { transform: [{ scale: 0.98 }] }]}>
                {c.lead ? (
                  <LinearGradient colors={['#176F01', '#1F8A02']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.card, shadow]}>{body}</LinearGradient>
                ) : (
                  <View style={[styles.card, styles.cardPlain, shadow]}>{body}</View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {cards.map((c, i) => <View key={c.key} testID={`dot-${i}`} style={[styles.dot, i === index && styles.dotOn]} />)}
      </View>
    </View>
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
  card: { flex: 1, minHeight: 176, borderRadius: radius.lg, padding: 16, gap: 8 },
  cardPlain: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#CFE6C8' },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  cardIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  cardArrow: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 20, lineHeight: 25, fontWeight: '800' },
  cardMessage: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  cardNote: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, marginTop: 2 },
  cardNoteText: { fontSize: 12, fontWeight: '800' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#C9D6CC' },
  dotOn: { width: 20, backgroundColor: brand.green600 },
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
