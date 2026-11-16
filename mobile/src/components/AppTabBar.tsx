// The bottom tab bar, drawn by us instead of the library's default so every tab is built exactly the same way:
// the same box, the same icon size, the same label style and the same room under the labels. That is what keeps Owner, Search and Profile
// (and Home, Pay and Profile for a renter) lined up, whatever phone it runs on.
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { brand } from '@/theme';

export const TAB_HEIGHT = 56;           // the part of the bar above the home-indicator space
export const MIN_BOTTOM_SPACE = 8;      // some room under the labels even on a phone with no home indicator

// just the parts of the navigator's props that this bar uses. expo-router hands a custom tab bar `emitter` and `navigateToTab` (there is no `navigation`);
// the test "uses the props the navigator really passes" checks this against the library's own code, so a library update cannot silently break it.
type RouteLike = { key: string; name: string; params?: object };
export type AppTabBarProps = {
  state: { index: number; routes: RouteLike[] };
  descriptors: Record<string, { options: any }>;
  emitter: { emit: (event: any) => { defaultPrevented?: boolean } };
  navigateToTab: (routeKey: string) => void;
};

export function AppTabBar({ state, descriptors, emitter, navigateToTab }: AppTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomSpace = Math.max(insets.bottom, MIN_BOTTOM_SPACE);
  return (
    <View style={[styles.bar, { height: TAB_HEIGHT + bottomSpace, paddingBottom: bottomSpace }]} accessibilityRole="tablist" testID="tab-bar">
      {state.routes.map((route, index) => {
        const options = descriptors[route.key]?.options ?? {};
        if (options.hidden) return null;                                               // a tab for the other role
        if (options.tabBarButton) {                                                    // the renter's Pay slider draws itself, in a slot of the same width
          const custom = options.tabBarButton({});
          return custom ? <View key={route.key} style={styles.item}>{custom}</View> : null;     // an owner gets nothing here, so no gap is left
        }
        const focused = state.index === index;
        const label: string = options.title ?? route.name;
        const onPress = () => {
          const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event?.defaultPrevented) navigateToTab(route.key);
        };
        return (
          <Pressable key={route.key} onPress={onPress} style={styles.item} accessibilityRole="tab" accessibilityState={{ selected: focused }}
                     accessibilityLabel={label} testID={`tab-${route.name}`}>
            <View style={styles.icon}>{options.tabBarIcon?.({ focused, color: focused ? brand.teal700 : brand.faint, size: 24 })}</View>
            <Text numberOfLines={1} style={[styles.label, { color: focused ? brand.teal700 : brand.faint }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: '#fff', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: brand.line, paddingTop: 0 },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, height: TAB_HEIGHT },
  icon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12, lineHeight: 15, fontWeight: '700', textAlign: 'center' },
});
