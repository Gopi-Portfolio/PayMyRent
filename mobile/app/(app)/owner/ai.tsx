// Owner AI: usage bar, ask (typed or on-device voice), reminder draft → owner review → approve & send.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Card, Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { fmtDate } from '@/lib/dates';
import { MessageLink } from '@/components/MessageLink';
import { MicButton } from '@/components/NoteInput';
import { SearchableSelect } from '@/components/SearchableSelect';
import { ErrorBanner, Panel, Screen, UsageBar } from '@/components/ui';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { ownerAccountId, useAuth } from '@/lib/auth';

export default function Ai() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const usage = useQuery({ queryKey: ['ai-usage', owner], queryFn: () => api<any>('/api/v1/owner/ai/usage', { ownerAccount: owner }) });
  const list = useQuery({ queryKey: ['tenancies', owner, 'active'], queryFn: () => api<any>('/api/v1/owner/tenancies?status=active', { ownerAccount: owner }) });
  const [q, setQ] = useState('');
  const [voice, setVoice] = useState(false);
  const [answer, setAnswer] = useState<any>(null);
  const [tenancy, setTenancy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const u = usage.data;

  async function ask() {
    setBusy(true); setErr(null);
    try {
      setAnswer(await api('/api/v1/owner/ai/ask', { ownerAccount: owner, body: { question: q, request_id: newIdempotencyKey(), language: i18n.language,
                                                                                    voice: voice ? 'device_stt' : 'none' } }));
      qc.invalidateQueries({ queryKey: ['ai-usage'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function makeDraft() {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/api/v1/owner/ai/reminder-draft', { ownerAccount: owner, body: { tenancy_id: tenancy, request_id: newIdempotencyKey(), language: i18n.language } });
      setDraft(r.draft);
      qc.invalidateQueries({ queryKey: ['ai-usage'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function send() {
    setBusy(true);
    try { await api('/api/v1/owner/ai/reminder-send', { ownerAccount: owner, body: { tenancy_id: tenancy, text: draft, channels: ['push', 'sms'] } }); setDraft(''); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const exhausted = err instanceof ApiError && ['AI_QUOTA_EXHAUSTED', 'AI_COST_CEILING_REACHED'].includes(err.code);
  return (
    <Screen>
      <MessageLink />
      {u && !u.enabled ? <Text>{t('ai.notInPlan')}</Text> : null}
      {u?.enabled ? (
        <Panel title={t('owner.askAi')} icon="chart-donut" tone="blue">
          <Text variant="bodySmall" style={{ marginBottom: 6 }}>{t('ai.usage', { used: u.used, allowance: u.allowance, date: fmtDate(String(u.resets_at)) })}</Text>
          <UsageBar used={u.used} allowance={u.allowance} />
        </Panel>
      ) : null}
      {exhausted ? <Text style={{ color: '#b45309' }}>{t('ai.exhausted')}</Text> : <ErrorBanner error={err} />}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TextInput mode="outlined" style={{ flex: 1 }} value={q} onChangeText={(v) => { setQ(v); setVoice(false); }} placeholder={t('owner.askAi')} maxLength={300} />
        <MicButton onText={(s) => { setQ(s); setVoice(true); }} />
      </View>
      <Button mode="contained" disabled={!q.trim() || busy || !u?.enabled} loading={busy} onPress={ask}>{t('owner.askAi')}</Button>
      {answer ? (
        <Panel title="AI" icon="creation" tone="blue">
          <Text>{answer.answer}</Text>
          {answer.facts ? <Text variant="bodySmall" style={{ marginTop: 8, color: '#5B6B67' }}>{JSON.stringify(answer.facts, null, 1)}</Text> : null}
        </Panel>
      ) : null}
      <Panel title={t('owner.reminders')} icon="bell-ring" tone="amber">
      <SearchableSelect label={t('tenancy.tenantName')} value={tenancy} onChange={setTenancy}
        options={(list.data?.items ?? []).filter((x: any) => x.balance_paise > 0).map((x: any) => ({ value: x.id, label: `${x.identifier} · ${x.tenant_name}` }))} />
      <Button mode="outlined" icon="creation" disabled={!tenancy || busy || !u?.enabled} onPress={makeDraft}>{t('owner.draftAi')}</Button>
      {draft ? (
        <>
          <Text variant="labelMedium">{t('ai.draftReview')}</Text>
          <TextInput mode="outlined" multiline value={draft} onChangeText={setDraft} maxLength={500} />
          <Button mode="contained" icon="send" onPress={send} loading={busy}>{t('ai.send')}</Button>
        </>
      ) : null}
      </Panel>
    </Screen>
  );
}
