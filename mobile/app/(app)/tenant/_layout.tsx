import { Stack } from 'expo-router';

// The payment screens rise from the bottom like a sheet, so finishing the Pay slide never looks like the whole screen swiping sideways.
export default function TenantStack() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right', gestureEnabled: false, fullScreenGestureEnabled: false }}>
      <Stack.Screen name="pay/index" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="pay/[id]" options={{ animation: 'slide_from_bottom' }} />
    </Stack>
  );
}
