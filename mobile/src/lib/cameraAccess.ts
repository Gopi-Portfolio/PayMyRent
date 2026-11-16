// Camera access for the ID and scan buttons. Choosing a photo from the library needs no permission (the system picker shows only what is chosen).
// The camera does: when it was refused before, the phone will not ask again, so the person is taken straight to this app's page in Settings.
import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';
import i18n from '@/i18n';

/** True when the camera may be used. When not, a message with an "Open Settings" button is shown and false is returned. */
export async function cameraAllowed(): Promise<boolean> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (perm.granted) return true;
  const t = i18n.t.bind(i18n);
  const buttons = perm.canAskAgain === false
    ? [{ text: t('common.cancel'), style: 'cancel' as const }, { text: t('renter.openSettings'), onPress: () => { void Linking.openSettings(); } }]
    : [{ text: t('common.cancel') }];
  Alert.alert(t('renter.cameraTitle'), t('renter.cameraOff'), buttons);
  return false;
}
