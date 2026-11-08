// A small UPI app button: the app's OFFICIAL logo, shown whole and unaltered (scaled to fit, never cropped), with its name under it. Several sit in one row.
import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SvgXml } from 'react-native-svg';

import { UPI_LOGOS, UPI_PLACEHOLDER, type UpiAppKey } from '@/lib/upiLogos';
import { brand } from '@/theme';

export function UpiAppButton({ app, label, disabled, onPress, testID }: { app: UpiAppKey; label: string; disabled?: boolean; onPress: () => void; testID?: string }) {
  const logo = UPI_LOGOS[app];
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
               style={({ pressed }) => ({ alignItems: 'center', gap: 6, width: 104, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
      <View style={{ width: 104, height: 60, borderRadius: 12, backgroundColor: logo ? '#fff' : '#F1F3F2', borderWidth: 1, borderColor: brand.line, alignItems: 'center', justifyContent: 'center', padding: 6 }}>
        {logo && 'svg' in logo ? <SvgXml xml={logo.svg} width="100%" height="100%" />
          : logo ? <Image source={logo.png} style={{ width: '100%', height: '100%' }} resizeMode="contain" accessibilityIgnoresInvertColors />
              : <Text style={{ color: brand.ink, fontWeight: '800', fontSize: 14 }} numberOfLines={1}>{UPI_PLACEHOLDER[app]}</Text>}
      </View>
      <Text variant="labelSmall" style={{ fontWeight: '700', color: brand.ink, textAlign: 'center' }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}
