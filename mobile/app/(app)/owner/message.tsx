// Message a renter. Speak (in any of the 8 languages) or type, choose the language the renter should get, check the translation and what it says
// back in your own language, then send it to the renter's bell and, if you choose, by SMS or WhatsApp. You can change "Send in" after speaking and it translates again.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { LanguageSelect, languageName } from '@/components/LanguageSelect';
import { MicButton } from '@/components/NoteInput';
import { SearchableSelect } from '@/components/SearchableSelect';
import { DONE_ID, DoneBar, ErrorBanner, Panel, Screen } from '@/components/ui';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { speechAvailable } from '@/lib/speech';
import { brand, radius } from '@/theme';

type Result = { text: string; lang: string; back: string | null; numbersOk: boolean; translated: boolean };
const AI_PLAN_ERRORS = ['AI_FEATURE_NOT_IN_PLAN', 'AI_QUOTA_EXHAUSTED', 'AI_COST_CEILING_REACHED', 'AI_DISABLED'];

export default function MessageRenter() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ tenancyId?: string }>();
  const [tenancyId, setTenancyId] = useState<string | null>(params.tenancyId ? String(params.tenancyId) : null);
  const list = useQuery({ queryKey: ['tenancies', owner, 'active'], enabled: !tenancyId, queryFn: () => api<any>('/api/v1/owner/tenancies?status=active', { ownerAccount: owner }) });
  const info = useQuery({ queryKey: ['message-info', tenancyId], enabled: !!tenancyId, queryFn: () => api<any>(`/api/v1/owner/tenancies/${tenancyId}/message-info`, { ownerAccount: owner }) });
  const chans = useQuery({ queryKey: ['message-channels'], queryFn: () => api<any>('/api/v1/owner/messages/channels', { ownerAccount: owner }) });
  const history = useQuery({ queryKey: ['messages', tenancyId], enabled: !!tenancyId, queryFn: () => api<any>(`/api/v1/owner/tenancies/${tenancyId}/messages?limit=5`, { ownerAccount: owner }) });

  const [fromLang, setFromLang] = useState<string>(i18n.language);          // the language I speak or type in
  const [toLang, setToLang] = useState<string | null>(null);                 // the language the renter should get; starts as the renter's own
  const [text, setText] = useState('');
  const [viaVoice, setViaVoice] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [sms, setSms] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const target = toLang ?? info.data?.renter_language ?? 'en';
  const renter = info.data?.renter_name as string | undefined;

  async function translate(to: string = target) {
    setErr(null); setSentTo(null);
    if (!text.trim()) return;
    if (to === fromLang) { setResult({ text: text.trim(), lang: fromLang, back: null, numbersOk: true, translated: false }); return; }
    setBusy(true);
    try {
      const r = await api<any>('/api/v1/owner/messages/translate', { ownerAccount: owner, body: { text: text.trim(), from_lang: fromLang, to_lang: to, request_id: newIdempotencyKey(), check_back: true } });
      setResult({ text: r.translation, lang: to, back: r.back_translation, numbersOk: r.numbers_ok, translated: true });
    } catch (e) { setErr(e); setResult(null); } finally { setBusy(false); }
  }
  async function send() {
    if (!result || !tenancyId) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/owner/tenancies/${tenancyId}/messages`, { ownerAccount: owner, body: {
        text: result.text, original_text: text.trim(), from_lang: fromLang, to_lang: result.lang, input_method: viaVoice ? 'voice' : 'typed',
        channels: [...(sms ? ['sms'] : []), ...(whatsapp ? ['whatsapp'] : [])], request_id: newIdempotencyKey() } });
      setSentTo(renter ?? ''); setText(''); setResult(null); setViaVoice(false);
      qc.invalidateQueries({ queryKey: ['messages', tenancyId] }); qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const noAi = err instanceof ApiError && AI_PLAN_ERRORS.includes(err.code);
  const ch = chans.data;
  const chanRow = (key: 'sms' | 'whatsapp', icon: string, label: string, on: boolean, set: (v: boolean) => void) => {
    const c = ch?.[key]; const usable = !!c?.available;
    return (
      <Pressable key={key} disabled={!usable} onPress={() => set(!on)} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !usable }} testID={`channel-${key}`}
                 style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, opacity: usable ? 1 : 0.55 }}>
        <Icon source={on ? 'checkbox-marked' : 'checkbox-blank-outline'} size={24} color={usable ? brand.teal700 : brand.disabled} />
        <Icon source={icon} size={20} color={brand.muted} />
        <Text style={{ flex: 1, fontWeight: '700' }}>{label}</Text>
        <Text variant="labelSmall" style={{ color: c?.mode === 'test' ? '#B45309' : brand.muted, fontWeight: '800' }}>{usable ? (c.mode === 'test' ? t('message.testMode') : '') : t('message.notConnected')}</Text>
      </Pressable>
    );
  };

  return (
    <Screen>
      <ErrorBanner error={noAi ? null : err} />
      {!tenancyId ? (
        <Panel title={t('message.pickRenter')} icon="account-circle-outline">
          <SearchableSelect label={t('tenancy.tenantName')} value={tenancyId} onChange={setTenancyId} testID="pick-renter"
            options={(list.data?.items ?? []).filter((x: any) => x.status === 'active').map((x: any) => ({ value: x.id, label: `${x.tenant_name} · ${x.identifier}` }))} />
        </Panel>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 12 }} testID="message-to">
            <Icon source="account-circle-outline" size={28} color={brand.teal700} />
            <View style={{ flex: 1 }}>
              <Text variant="labelSmall" style={{ color: brand.muted }}>{t('message.to')}</Text>
              <Text style={{ fontWeight: '800', fontSize: 16 }}>{renter ?? '…'}{info.data?.unit ? ` · ${info.data.unit}` : ''}</Text>
            </View>
          </View>
          {info.data && !info.data.can_message ? <Text style={{ color: '#B45309', fontWeight: '700' }}>{t('message.cannot')}</Text> : null}

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><LanguageSelect label={t('message.iSpeak')} value={fromLang} onChange={(c) => { setFromLang(c); setResult(null); }} testID="lang-from" /></View>
            <View style={{ flex: 1 }}>
              <LanguageSelect label={t('message.sendIn')} value={target} onChange={(c) => { setToLang(c); if (result || text.trim()) translate(c); }} testID="lang-to" />
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <DoneBar />
            <TextInput mode="outlined" multiline numberOfLines={4} style={{ flex: 1, minHeight: 120, textAlignVertical: 'top' }} value={text} maxLength={500} inputAccessoryViewID={DONE_ID} testID="message-text"
                       placeholder={t('message.placeholder', { lang: languageName(fromLang) })}
                       onChangeText={(v) => { setText(v); setViaVoice(false); setResult(null); setSentTo(null); }} />
            <MicButton lang={fromLang} onText={(s) => { setText((p) => (p ? `${p} ${s}` : s)); setViaVoice(true); setResult(null); setSentTo(null); }} />
          </View>
          {!speechAvailable ? <Text variant="bodySmall" style={{ color: brand.muted }}>{t('message.noMic')}</Text> : null}

          {!result ? (
            <AppButton label={t(fromLang === target ? 'message.review' : 'message.translate')} icon={fromLang === target ? 'eye-outline' : 'translate'} testID="translate"
                       disabled={!text.trim() || busy || !info.data?.can_message} loading={busy} onPress={() => translate()} />
          ) : null}
          {noAi ? (
            <Panel icon="information-outline" title={t('message.noAiTitle')} tone="amber">
              <Text style={{ marginBottom: 8 }}>{t('message.noAi')}</Text>
              <AppButton variant="outline" label={t('message.sendAsIs')} icon="send" testID="send-as-is"
                         onPress={() => { setErr(null); setResult({ text: text.trim(), lang: fromLang, back: null, numbersOk: true, translated: false }); }} />
            </Panel>
          ) : null}

          {result ? (
            <>
              <Panel icon={result.translated ? 'translate' : 'message-text-outline'} title={t('message.reviewTitle', { name: renter ?? '', lang: languageName(result.lang) })} tone="blue">
                <TextInput mode="outlined" multiline numberOfLines={4} style={{ minHeight: 110, textAlignVertical: 'top' }} value={result.text} maxLength={500} inputAccessoryViewID={DONE_ID} testID="final-text"
                           onChangeText={(v) => setResult({ ...result, text: v, back: result.back })} />
                {result.back ? (
                  <View style={{ marginTop: 10, backgroundColor: brand.teal50, borderRadius: radius.md, padding: 10, gap: 2 }} testID="check-back">
                    <Text variant="labelSmall" style={{ color: brand.muted, fontWeight: '800' }}>{t('message.checkBack', { lang: languageName(fromLang) })}</Text>
                    <Text style={{ fontWeight: '600' }}>{result.back}</Text>
                  </View>
                ) : null}
                {!result.numbersOk ? <Text style={{ color: brand.red600, fontWeight: '800', marginTop: 8 }} testID="numbers-warning">{t('message.numbersWarn')}</Text> : null}
                {result.translated ? <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 8 }}>{t('message.checkHelp')}</Text> : null}
              </Panel>

              <Panel icon="send-outline" title={t('message.channelsTitle')} tone="teal">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}>
                  <Icon source="checkbox-marked" size={24} color={brand.disabled} />
                  <Icon source="bell-ring-outline" size={20} color={brand.muted} />
                  <Text style={{ flex: 1, fontWeight: '700' }}>{t('message.bellAlways')}</Text>
                </View>
                {chanRow('sms', 'message-text-outline', 'SMS', sms, setSms)}
                {chanRow('whatsapp', 'whatsapp', 'WhatsApp', whatsapp, setWhatsapp)}
                <AppButton label={t('message.send')} icon="send" testID="send-message" disabled={busy || !result.text.trim()} loading={busy} onPress={send} />
              </Panel>
            </>
          ) : null}

          {sentTo !== null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: brand.green100, borderRadius: radius.md, padding: 12 }} testID="sent-ok">
              <Icon source="check-circle" size={24} color={brand.green600} />
              <Text style={{ flex: 1, fontWeight: '800', color: brand.green600 }}>{t('message.sentOk', { name: sentTo })}</Text>
            </View>
          ) : null}

          {(history.data?.items ?? []).length > 0 ? (
            <Panel icon="history" title={t('message.history')} tone="blue">
              {(history.data.items as any[]).map((m) => (
                <View key={m.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: brand.line, gap: 2 }} testID={`sent-${m.id}`}>
                  <Text>{m.sent_text}</Text>
                  <Text variant="bodySmall" style={{ color: brand.muted }}>{`${fmtDate(m.created_at)} · ${languageName(m.sent_lang)} · ${(m.channels as string[]).join(', ')}`}</Text>
                </View>
              ))}
            </Panel>
          ) : null}
        </>
      )}
    </Screen>
  );
}
