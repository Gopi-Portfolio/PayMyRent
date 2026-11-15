// Compact upload tiles, the way most sites do it: a dashed box with the name of the page, a tick when it is done, and two small buttons
// (camera, gallery). Two or three tiles sit side by side in ONE module (Aadhaar front + back, deed first + last page).
import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { brand, radius } from '@/theme';

function Pill({ icon, label, onPress, disabled, testID }: { icon: string; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <Pressable onPress={disabled ? undefined : onPress} disabled={disabled} testID={testID} accessibilityRole="button" accessibilityLabel={label}
               style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, height: 30, paddingHorizontal: 10, borderRadius: radius.pill,
                 backgroundColor: pressed ? brand.teal100 : brand.teal50, borderWidth: 1, borderColor: brand.teal100, opacity: disabled ? 0.5 : 1 })}>
      <Icon source={icon} size={14} color={brand.teal700} />
      <Text style={{ fontSize: 12, fontWeight: '700', color: brand.teal700 }}>{label}</Text>
    </Pressable>
  );
}

export type SlotProps = {
  label: string; done: boolean; busy?: boolean; disabled?: boolean; gallery?: boolean; testID: string;
  cameraLabel: string; galleryLabel: string; retakeLabel: string; doneLabel: string;
  onCamera: () => void; onGallery?: () => void;
};

export function UploadSlot({ label, done, busy, disabled, gallery = true, testID, cameraLabel, galleryLabel, retakeLabel, doneLabel, onCamera, onGallery }: SlotProps) {
  return (
    <View style={{ flex: 1, minHeight: 112, borderRadius: radius.md, borderWidth: 1.5, borderStyle: done ? 'solid' : 'dashed',
                   borderColor: done ? brand.teal600 : '#B8C7C3', backgroundColor: done ? brand.teal50 : '#FAFCFB', padding: 10, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      {busy ? <ActivityIndicator size="small" color={brand.teal700} /> : <Icon source={done ? 'check-circle' : 'tray-arrow-up'} size={24} color={done ? brand.teal700 : brand.muted} />}
      <Text numberOfLines={2} style={{ fontSize: 12.5, fontWeight: '700', textAlign: 'center', color: brand.ink }}>{label}</Text>
      {done ? <Text style={{ fontSize: 11, color: brand.teal700, fontWeight: '700' }}>{doneLabel}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Pill icon="camera-outline" label={done ? retakeLabel : cameraLabel} onPress={onCamera} disabled={busy || disabled} testID={`doc-camera-${testID}`} />
        {gallery && onGallery ? <Pill icon="image-outline" label={galleryLabel} onPress={onGallery} disabled={busy || disabled} testID={`doc-gallery-${testID}`} /> : null}
      </View>
    </View>
  );
}

/** Slots in one row (they share the width equally). */
export function SlotRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 10 }}>{children}</View>;
}
