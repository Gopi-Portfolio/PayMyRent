// The owner's shortcuts. The two things done most, Add Renter and Record Payment, are big bold cards you can hit without looking;
// everything else is a row of small buttons underneath. No outlines: colour, a soft shadow and a press animation do the work.
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { brand, radius, shadow } from '@/theme';

export type ActionCard = { key: string; icon: string; title: string; message: string; footnote?: string; colors: readonly [string, string]; onPress: () => void; testID?: string };

const CARD_GAP = 12;

/** The main actions as full-width cards you swipe left and right, one at a time. The arrow on each card is the swipe cue: tap it to slide to the next card
 *  (on the last card it points back and slides to the first). Tapping the card itself opens its screen. Each card has its own solid colour and white text. */
export function ActionCarousel({ cards }: { cards: ActionCard[] }) {
  const [width, setWidth] = React.useState(0);
  const [index, setIndex] = React.useState(0);
  const scroller = React.useRef<{ scrollTo: (o: { x: number; animated?: boolean }) => void } | null>(null);
  const step = width + CARD_GAP;
  const goTo = (i: number) => { setIndex(i); scroller.current?.scrollTo({ x: i * step, animated: true }); };
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} testID="action-carousel" style={{ gap: 8 }}>
      {width > 0 ? (
        <ScrollView ref={scroller as any} horizontal showsHorizontalScrollIndicator={false} snapToInterval={step} snapToAlignment="start" decelerationRate="fast" disableIntervalMomentum
                    scrollEventThrottle={16} onScroll={(e) => setIndex(Math.max(0, Math.min(cards.length - 1, Math.round(e.nativeEvent.contentOffset.x / step))))}
                    contentContainerStyle={{ gap: CARD_GAP }} testID="action-scroll">
          {cards.map((c, i) => {
            const last = i === cards.length - 1;
            const next = cards[last ? 0 : i + 1];
            const fg = '#fff';
            const soft = 'rgba(255,255,255,0.92)';
            const chip = 'rgba(255,255,255,0.24)';
            const accent = '#fff';
            const body = (
              <>
                <View style={[styles.cardIcon, { backgroundColor: chip }]}><Icon source={c.icon} size={26} color={accent} /></View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.cardTitleRow}>
                    <Text style={[styles.cardTitle, { color: fg }]}>{c.title}</Text>
                    {c.footnote ? <View style={[styles.cardNote, { backgroundColor: chip }]}><Text style={[styles.cardNoteText, { color: accent }]}>{c.footnote}</Text></View> : null}
                  </View>
                  <Text style={[styles.cardMessage, { color: soft }]} numberOfLines={2}>{c.message}</Text>
                </View>
                {/* the scroll cue: slides to the next card; the last card's arrow points back to the first */}
                <Pressable onPress={() => goTo(last ? 0 : i + 1)} hitSlop={10} accessibilityRole="button" accessibilityLabel={next.title} testID={`arrow-${i}`}
                           style={[styles.cardArrow, { backgroundColor: chip }]}>
                  <Icon source={last ? 'chevron-left' : 'chevron-right'} size={22} color={accent} />
                </Pressable>
              </>
            );
            // the whole card is the button: the Pressable itself has the card's size, shape and padding (the colour is drawn behind the content, not around it),
            // so a tap anywhere on it opens the screen, instead of only where a smaller inner box happened to sit
            return (
              <Pressable key={c.key} onPress={c.onPress} testID={c.testID} accessibilityRole="button" accessibilityLabel={`${c.title}. ${c.message}${c.footnote ? `. ${c.footnote}` : ''}`}
                         android_ripple={{ color: 'rgba(255,255,255,0.25)' }}
                         style={({ pressed }) => [styles.card, shadow, { width, overflow: 'hidden' }, pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] }]}>
                <LinearGradient pointerEvents="none" colors={c.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                {body}
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
  card: { minHeight: 92, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: 14, gap: 12, flexDirection: 'row', alignItems: 'center' },
  cardIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  cardArrow: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2 },
  cardTitle: { fontSize: 18, lineHeight: 23, fontWeight: '800' },
  cardMessage: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  cardNote: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  cardNoteText: { fontSize: 11, fontWeight: '800' },
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
