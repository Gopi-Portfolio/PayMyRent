// One plain "Are you sure?" for removing things: a title, one sentence, Cancel and a red button.
import { Alert } from 'react-native';
import i18n from '@/i18n';

export function confirmRemove(title: string, body: string, confirmLabel: string, onConfirm: () => void): void {
  Alert.alert(title, body, [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
