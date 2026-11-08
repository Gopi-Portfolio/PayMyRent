// Profile: name, locked login mobile, up to 2 mobiles + 2 emails (OTP-verified), language, per-channel
// destinations (only verified contacts are selectable), secure change-mobile, plan + AI usage for owners.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Dialog, Divider, List, Portal, Switch, Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { SearchableSelect } from '@/components/SearchableSelect';
import { Avatar, ErrorBanner, Field, GenderPicker, IdentityRow, Panel, PlanCard, Screen } from '@/components/ui';
import { LANGUAGES } from '@/i18n';
import { api } from '@/lib/api';
import { FormatSelect } from '@/components/FormatSelect';
import { OwnerPayDefault } from '@/components/OwnerPayDefault';
import { OwnerUpi } from '@/components/OwnerUpi';
import { Button } from '@/components/Buttons';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { normalizeMobile } from '@/lib/format';
import { otpSession } from '@/lib/otpSession';
import { brand } from '@/theme';

export default function ProfileScreen() {
  const { t, i18n } = useTranslation();
  const { me, refresh, signOut, requestOtp, verifyOtp } = useAuth();
  const owner = ownerAccountId(me);
  const isOwner = !!me?.roles.includes('owner');
  const sub = useQuery({ queryKey: ['sub', owner], enabled: isOwner, queryFn: () => api<any>('/api/v1/subscription', { ownerAccount: owner }) });
  const isRenter = !!me?.roles.includes('tenant');
  const rentals = useQuery({ queryKey: ['rentals'], enabled: isRenter, queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const liveRentals = (rentals.data?.items ?? []).filter((r: any) => r.status === 'active').length;
  const [name, setName] = useState(me?.full_name ?? '');
  const [address, setAddress] = useState(me?.address ?? '');
  const [closing, setClosing] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [adding, setAdding] = useState<null | 'mobile' | 'email'>(null);
  const [newValue, setNewValue] = useState('');
  const [verify, setVerify] = useState<{ id: string; code: string } | null>(null);
  const [change, setChange] = useState<{ step: 'new' | 'code'; phone: string; code: string; requestId?: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (!me) return null;
  const prefs = me.notification_preferences ?? {};
  const mobiles = me.contacts.filter((c) => c.kind === 'mobile');
  const emails = me.contacts.filter((c) => c.kind === 'email');
  const primary = mobiles.find((c) => c.is_primary);
  const verifiedOpts = (kind: 'mobile' | 'email') => me.contacts.filter((c) => c.kind === kind && c.verified).map((c) => ({ value: c.id, label: c.value }));
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await refresh(); } catch (e) { setErr(e); } };
  const savePrefs = (patch: Record<string, unknown>) => run(() => api('/api/v1/me/notification-preferences', { method: 'PUT', body: {
    sms_contact_id: prefs.sms_contact_id, whatsapp_contact_id: prefs.whatsapp_contact_id, email_contact_id: prefs.email_contact_id,
    sms_enabled: prefs.sms_enabled, whatsapp_enabled: prefs.whatsapp_enabled, email_enabled: prefs.email_enabled, push_enabled: prefs.push_enabled,
    ...patch } }));

  async function startChange() {
    // Step-up: re-verify the CURRENT number first (fresh token), then start the request.
    await run(async () => {
      otpSession.current = await requestOtp(primary!.value);
      setChange({ step: 'code', phone: '', code: '' });
    });
  }

  return (
    <Screen>
      <ErrorBanner error={err} />
      <Panel>
      <Field label={t('profile.fullName')} value={name} onChangeText={setName} kind="name" />
      <TextInput mode="outlined" label={t('profile.primaryMobile')} value={primary?.value ?? ''} editable={false} outlineStyle={{ borderRadius: 16 }} style={{ backgroundColor: brand.canvas }} right={<TextInput.Icon icon="lock" />} />
      <Field label={t('profile.address')} value={address} onChangeText={setAddress} kind="address" multiline />
      <GenderPicker />
      <SearchableSelect label={t('profile.language')} value={i18n.language} options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
        onChange={(lang) => run(async () => { await api('/api/v1/me/profile', { method: 'PUT', body: { full_name: name, address: address || null, preferred_language: lang, version: me.version } }); i18n.changeLanguage(lang); })} />
      <Button mode="contained" onPress={() => run(() => api('/api/v1/me/profile', { method: 'PUT', body: { full_name: name, address: address || null, preferred_language: i18n.language, version: me.version } }))}>
        {t('common.save')}
      </Button>
      </Panel>

      <Panel title={`${t('profile.addMobile')} / ${t('profile.addEmail')}`} icon="contacts-outline" tone="blue">
      {me.contacts.filter((c) => !c.is_primary || c.kind === 'email').map((c) => (
        <List.Item key={c.id} style={{ paddingHorizontal: 0 }} title={c.value} description={c.verified ? '✓' : 'not verified'}
          right={() => (!c.verified ? <Button onPress={() => setVerify({ id: c.id, code: '' })}>{t('auth.verify')}</Button>
                                    : <Button onPress={() => run(() => api(`/api/v1/me/contacts/${c.id}`, { method: 'DELETE' }))}>✕</Button>)} />
      ))}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {mobiles.length < 2 ? <Button icon="plus" onPress={() => setAdding('mobile')}>{t('profile.addMobile')}</Button> : null}
        {emails.length < 2 ? <Button icon="plus" onPress={() => setAdding('email')}>{t('profile.addEmail')}</Button> : null}
      </View>
      </Panel>

      <Panel title="SMS · WhatsApp · Email · Push" icon="bell-ring-outline" tone="amber">

      {/* Destination pickers appear only when there is a real choice to make. */}
      {verifiedOpts('mobile').length > 1 ? (
        <>
          <SearchableSelect label={t('profile.smsTo')} value={prefs.sms_contact_id ?? null} options={verifiedOpts('mobile')} onChange={(v) => savePrefs({ sms_contact_id: v })} />
          <SearchableSelect label={t('profile.whatsappTo')} value={prefs.whatsapp_contact_id ?? null} options={verifiedOpts('mobile')} onChange={(v) => savePrefs({ whatsapp_contact_id: v })} />
        </>
      ) : null}
      {verifiedOpts('email').length > 1 ? (
        <SearchableSelect label={t('profile.emailTo')} value={prefs.email_contact_id ?? null} options={verifiedOpts('email')} onChange={(v) => savePrefs({ email_contact_id: v })} />
      ) : null}
      {(['sms', 'whatsapp', 'email', 'push'] as const).map((ch) => (
        <List.Item key={ch} style={{ paddingHorizontal: 0 }} title={ch.toUpperCase()} left={(p) => <List.Icon {...p} icon={ch === 'sms' ? 'message-text-outline' : ch === 'whatsapp' ? 'whatsapp' : ch === 'email' ? 'email-outline' : 'cellphone-check'} />} right={() => (
          <Switch value={!!prefs[`${ch}_enabled`]} onValueChange={(v) => savePrefs({ [`${ch}_enabled`]: v })} accessibilityLabel={ch} />)} />
      ))}

      </Panel>

      <IdentityRow />

      {isOwner ? <OwnerPayDefault /> : null}

      {isOwner ? <OwnerUpi /> : null}

      {isOwner ? <PlanCard owner={owner} /> : null}

      <Panel>
        <Button icon="cellphone-key" onPress={startChange}>{t('profile.changeMobile')}</Button>
        {isOwner ? <Button icon="home-city-outline" onPress={() => router.push('/(app)/owner/properties')}>{t('property.title')}</Button> : null}
        {isOwner ? <Button icon="account-multiple-plus-outline" onPress={() => router.push('/(app)/owner/owner-numbers')}>{t('ownerNumbers.title')}</Button> : null}
        <Button icon="shield-account-outline" onPress={() => router.push('/privacy')}>{t('privacy.title')}</Button>
        <FormatSelect label={t('privacy.download')} path="/api/v1/me/export" fileName="paymyrent-my-data" onError={setErr} />
        <Button icon="account-remove-outline" textColor="crimson" onPress={() => { if (me.owner_accounts?.[0]?.role === 'owner') { router.push('/(app)/profile/close-account'); return; } if (liveRentals > 0) { router.push('/(app)/tenant/vacate'); return; } setConfirmText(''); setClosing(true); }} testID="close-account">{t('privacy.close')}</Button>
        <Button icon="logout" textColor="crimson" onPress={async () => { await signOut(); router.replace('/'); }}>{t('profile.signOut')}</Button>
      </Panel>

      <Portal>
        <Dialog visible={closing} onDismiss={() => setClosing(false)}>
          <Dialog.Title>{t('privacy.close')}</Dialog.Title>
          <Dialog.Content style={{ gap: 12 }}>
            <Text>{t('privacy.closeWarn')}</Text>
            <Field label={t('privacy.typeDelete')} value={confirmText} onChangeText={setConfirmText} kind="text" />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setClosing(false)}>{t('common.cancel')}</Button>
            <Button textColor="crimson" disabled={confirmText.trim().toUpperCase() !== 'DELETE'} onPress={async () => {
              try { await api('/api/v1/me/close-account', { body: { confirm: confirmText } }); } catch (e) { setClosing(false); setErr(e); return; }
              setClosing(false); await signOut(); router.replace('/');
            }}>{t('privacy.close')}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={!!adding} onDismiss={() => setAdding(null)}>
          <Dialog.Content>
            <Field label={adding === 'email' ? 'Email' : t('auth.enterMobile')} value={newValue} onChangeText={setNewValue}
                   kind={adding === 'email' ? 'email' : 'mobile'} />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => run(async () => {
              const r = await api<any>('/api/v1/me/contacts', { body: { kind: adding, value: newValue } });
              setAdding(null); setNewValue(''); setVerify({ id: r.contact_id, code: r.demo_code ?? '' });
            })}>{t('auth.sendOtp')}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={!!verify} onDismiss={() => setVerify(null)}>
          <Dialog.Content><Field label="OTP" value={verify?.code ?? ''} onChangeText={(c) => setVerify(verify && { ...verify, code: c })} kind="otp" /></Dialog.Content>
          <Dialog.Actions><Button onPress={() => run(async () => { await api(`/api/v1/me/contacts/${verify!.id}/verify`, { body: { code: verify!.code } }); setVerify(null); })}>{t('auth.verify')}</Button></Dialog.Actions>
        </Dialog>
        <Dialog visible={!!change} onDismiss={() => setChange(null)}>
          <Dialog.Title>{t('profile.changeMobile')}</Dialog.Title>
          <Dialog.Content style={{ gap: 12 }}>
            {change?.step === 'code' && !change.requestId ? (
              <>
                <Text>{t('auth.enterOtp', { phone: primary?.value })}</Text>
                {otpSession.current?.demoCode ? <Text>{t('auth.demoCode', { code: otpSession.current.demoCode })}</Text> : null}
                <Field label="OTP" value={change.code} onChangeText={(c) => setChange({ ...change, code: c })} kind="otp" />
                <Field label={t('auth.enterMobile')} value={change.phone} onChangeText={(p) => setChange({ ...change, phone: p })} kind="mobile" />
              </>
            ) : change?.requestId ? (
              <>
                <Text>{t('auth.enterOtp', { phone: normalizeMobile(change.phone) })}</Text>
                {otpSession.current?.demoCode ? <Text>{t('auth.demoCode', { code: otpSession.current.demoCode })}</Text> : null}
                <Field label="OTP" value={change.code} onChangeText={(c) => setChange({ ...change, code: c })} kind="otp" />
              </>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => run(async () => {
              if (!change) return;
              if (!change.requestId) {
                await verifyOtp(otpSession.current, change.code);                       // fresh sign-in on the OLD number
                const r = await api<any>('/api/v1/me/mobile-change/start', { body: { new_phone: change.phone } });
                otpSession.current = await requestOtp(normalizeMobile(change.phone)!, true);
                setChange({ ...change, code: '', requestId: r.request_id });
              } else {
                await verifyOtp(otpSession.current, change.code, true);                 // NEW number linked to same user
                await api('/api/v1/me/mobile-change/complete', { body: { request_id: change.requestId } });
                setChange(null);
                await signOut();                                                       // all sessions were revoked
                router.replace('/(public)/phone');
              }
            })}>{t('common.continue')}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
