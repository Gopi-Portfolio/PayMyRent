// Message the owner of a rental you have accepted. Speak (in any of the 8 languages) or type, then send: it goes to the owner's bell,
// where they can reply. Opened from a rental, or from a message in the bell (its Reply button).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { LanguageSelect, languageName } from '@/components/LanguageSelect';
import { MicButton } from '@/components/NoteInput';
import { SearchableSelect } from '@/components/SearchableSelect';
import { DONE_ID, DoneBar, ErrorBanner, Panel, ResultView, Screen, goBack } from '@/components/ui';
import { api } from '@/lib/api';
import { speechAvailable } from '@/lib/speech';
import { brand } from '@/theme';

export default function MessageOwner() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ tenancyId?: string }>();
  const rentals = useQuery({ queryKey: ['rentals'], queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const live: any[] = (rentals.data?.items ?? []).filter((r: any) => r.status === 'active');
  const [picked, setPicked] = useState<string | null>(params.tenancyId ? String(params.tenancyId) : null);
  const rental = live.find((r) => r.id === picked) ?? (live.length === 1 ? live[0] : undefined);
  const [lang, setLang] = useState<string>(i18n.language);
  const [text, setText] = useState('');
  const [viaVoice, setViaVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    if (!rental || !text.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/tenant/tenancies/${rental.id}/messages`, { body: { text: text.trim(), lang, input_method: viaVoice ? 'voice' : 'typed' } });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      setSent(true);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <Screen>
        <ResultView kind="success" title={t('message.renterSentTitle', { defaultValue: 'Message Sent' })}
                    lines={[t('message.renterSentBody', { defaultValue: '{{owner}} will see it in their notifications and can reply to you there.', owner: rental?.owner_name ?? '' })]}>
          <AppButton label={t('common.done', { defaultValue: 'Done' })} icon="check" onPress={() => goBack()} testID="message-done" />
        </ResultView>
      </Screen>
    );
  }
  return (
    <Screen>
      {live.length > 1 ? (
        <SearchableSelect label={t('tenant.chooseRental', { defaultValue: 'Choose a rental' })} value={rental?.id ?? null} testID="message-rental"
          options={live.map((r) => ({ value: r.id as string, label: `${r.owner_name} · ${r.identifier}` }))} onChange={setPicked} />
      ) : null}
      {rental ? (
        <Panel title={t('message.toOwner', { defaultValue: 'Message to {{owner}}', owner: rental.owner_name })} icon="message-text-outline" tone="blue">
          <LanguageSelect label={t('message.iSpeak')} value={lang} onChange={setLang} testID="lang-from" />
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <DoneBar />
            <TextInput mode="outlined" multiline numberOfLines={4} style={{ flex: 1, minHeight: 120, textAlignVertical: 'top' }} value={text} maxLength={500} inputAccessoryViewID={DONE_ID} testID="message-text"
                       placeholder={t('message.placeholder', { lang: languageName(lang) })}
                       onChangeText={(v) => { setText(v); setViaVoice(false); }} />
            <MicButton lang={lang} onText={(s) => { setText((p) => (p ? `${p} ${s}` : s)); setViaVoice(true); }} />
          </View>
          {!speechAvailable ? <Text variant="bodySmall" style={{ color: brand.muted }}>{t('message.noMic')}</Text> : null}
          <ErrorBanner error={err} />
          <AppButton label={t('message.send', { defaultValue: 'Send' })} icon="send" loading={busy} disabled={!text.trim() || busy} onPress={send} testID="send-to-owner" />
        </Panel>
      ) : (
        <Text style={{ color: brand.muted }}>{rentals.isLoading ? '…' : t('message.pickRental', { defaultValue: 'Choose the rental you want to write about.' })}</Text>
      )}
    </Screen>
  );
}
