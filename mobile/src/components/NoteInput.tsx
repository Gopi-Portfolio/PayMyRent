// Note entry: typed or dictated. Dictation fills the box for review; it is NEVER auto-submitted.
// Live counter uses grapheme counting so Indian-script conjuncts count as one character.
import React, { useState } from 'react';
import { View } from 'react-native';
import { HelperText, IconButton, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { NOTE_MAX, graphemeCount } from '@/lib/format';
import { Button } from '@/components/Buttons';
import { SpeechModule as ExpoSpeechRecognitionModule, speechAvailable, useSpeechEvent as useSpeechRecognitionEvent } from '@/lib/speech';

const SPEECH_LOCALE: Record<string, string> = { en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN', te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN', bn: 'bn-IN' };

type Props = { onSubmit: (text: string, method: 'typed' | 'voice') => Promise<void> | void; busy?: boolean };

export function NoteInput({ onSubmit, busy }: Props) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [method, setMethod] = useState<'typed' | 'voice'>('typed');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const count = graphemeCount(text.trim());
  const over = count > NOTE_MAX;

  useSpeechRecognitionEvent('result', (e) => {
    const transcript = e.results[0]?.transcript ?? '';
    setText((prev) => (prev && !e.isFinal ? prev : transcript));
    setMethod('voice');
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', () => { setListening(false); setVoiceError(t('notes.voiceUnsupported')); });

  async function startVoice() {
    setVoiceError(null);
    if (!speechAvailable) { setVoiceError(t('notes.voiceUnsupported')); return; }
    const locale = SPEECH_LOCALE[i18n.language] ?? 'en-IN';
    // Speech support differs by device/OS/language — check instead of assuming.
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    const { locales } = await ExpoSpeechRecognitionModule.getSupportedLocales({}).catch(() => ({ locales: [] as string[] }));
    if (!perm.granted || (locales.length && !locales.includes(locale))) {
      setVoiceError(t('notes.voiceUnsupported'));
      return;
    }
    setListening(true);
    ExpoSpeechRecognitionModule.start({ lang: locale, interimResults: true, continuous: false });
  }

  return (
    <View>
      <TextInput mode="outlined" multiline maxLength={1000} value={text.toLocaleUpperCase()} onChangeText={(v) => { setText(v.toLocaleUpperCase()); }} autoCapitalize="characters" placeholder={t('notes.placeholder')}
                 accessibilityLabel={t('notes.placeholder')} error={over}
                 right={!speechAvailable ? undefined : <TextInput.Icon icon={listening ? 'microphone-off' : 'microphone'} accessibilityLabel="voice"
                                        onPress={() => (listening ? ExpoSpeechRecognitionModule.stop() : startVoice())} />} />
      <HelperText type={over ? 'error' : 'info'} accessibilityLiveRegion="polite">
        {method === 'voice' && text ? `${t('notes.reviewVoice')} · ` : ''}{count}/{NOTE_MAX}
      </HelperText>
      {voiceError ? <HelperText type="error">{voiceError}</HelperText> : null}
      <Button mode="contained" disabled={!count || over || busy} loading={busy}
              onPress={async () => { await onSubmit(text.trim(), method); setText(''); setMethod('typed'); }}>
        {t('common.save')}
      </Button>
    </View>
  );
}

export function MicButton({ onText, lang }: { onText: (s: string) => void; lang?: string }) {   // lang: listen in this language instead of the app's
  const { i18n } = useTranslation();
  const [on, setOn] = useState(false);
  useSpeechRecognitionEvent('result', (e) => { if (e.isFinal) onText(e.results[0]?.transcript ?? ''); });
  useSpeechRecognitionEvent('end', () => setOn(false));
  if (!speechAvailable) return null;
  return (
    <IconButton icon={on ? 'microphone-off' : 'microphone'} size={28} accessibilityLabel="voice input" onPress={async () => {
      if (on) return ExpoSpeechRecognitionModule.stop();
      const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!p.granted) return;
      setOn(true);
      ExpoSpeechRecognitionModule.start({ lang: SPEECH_LOCALE[lang ?? i18n.language] ?? 'en-IN', interimResults: false });
    }} />
  );
}
