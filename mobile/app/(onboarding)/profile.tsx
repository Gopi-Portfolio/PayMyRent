// Minimal profile: name (required), verified mobile (locked), address & language optional.
import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { List, Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { SearchableSelect } from '@/components/SearchableSelect';
import { ErrorBanner, Field, GenderPicker, Screen } from '@/components/ui';
import { LANGUAGES } from '@/i18n';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { graphemeCount } from '@/lib/format';
import { nameSchema } from '@/lib/validation';

export default function Profile() {
  const { t, i18n } = useTranslation();
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.full_name ?? '');
  const [address, setAddress] = useState(me?.address ?? '');
  const [lang, setLang] = useState(i18n.language);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const primary = me?.contacts.find((c) => c.kind === 'mobile' && c.is_primary);
  const nameCheck = nameSchema.safeParse(name);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/me/profile', { method: 'PUT', body: { full_name: name, address: address || null, preferred_language: lang, version: me!.version } });
      i18n.changeLanguage(lang);
      await refresh();
      router.replace('/');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Field label={t('profile.fullName')} value={name} onChangeText={setName} kind="name"
             error={name && !nameCheck.success ? nameCheck.error.issues[0].message : undefined} testID="name-input" />
      <TextInput mode="outlined" label={t('profile.primaryMobile')} value={primary?.value ?? ''} editable={false}
                 right={<TextInput.Icon icon="lock" accessibilityLabel="locked" />} />
      <GenderPicker />
      <SearchableSelect label={t('profile.language')} value={lang} onChange={setLang}
                        options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />
      <List.Accordion title={t('common.optional')} expanded={more} onPress={() => setMore(!more)}>
        <View style={{ paddingVertical: 12 }}>
          <Field label={`${t('profile.address')} (${graphemeCount(address)}/250)`} value={address} onChangeText={setAddress} kind="address" multiline
                 error={graphemeCount(address) > 250 ? 'too_long' : undefined} />
        </View>
      </List.Accordion>
      <ErrorBanner error={err} />
      <AppButton label={t('common.continue')} icon="arrow-right" disabled={!nameCheck.success} loading={busy} onPress={save} />
    </Screen>
  );
}
