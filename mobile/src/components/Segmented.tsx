// A small segmented switch (two to four options in one rounded bar), for choices such as PAN card / Aadhaar card or shop / house.
import React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from 'react-native-paper';

import { brand, radius } from '@/theme';

export function Segmented({ value, onChange, options, testID }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; testID?: string }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: brand.teal50, borderRadius: radius.pill, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }} testID={testID ? `${testID}-${o.value}` : undefined}
                     style={{ flex: 1, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, backgroundColor: on ? brand.teal700 : 'transparent' }}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ fontSize: 13, fontWeight: '700', color: on ? '#fff' : brand.teal700 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
