import 'expo-crypto';
import '@/i18n';

import { Montserrat_900Black_Italic, useFonts } from '@expo-google-fonts/montserrat';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

import { CACHE_MAX_AGE, persister, queryClient, shouldSave } from '@/lib/queryClient';
import { Stack } from 'expo-router';
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PaperProvider } from 'react-native-paper';

import { LANGUAGES } from '@/i18n';
import i18n from '@/i18n';
import { AuthProvider, useAuth } from '@/lib/auth';
import { loadLanguage } from '@/lib/language';
import { outbox, startOfflineSync } from '@/lib/offline';
import { startNetworkMonitor } from '@/lib/network';
import { usePendingRole } from '@/lib/landing';
import { setBrandRole, themeFor } from '@/theme';


/** Owner screens are teal, renter screens are blue: the role in use picks the colour set (before anything is drawn) and the Paper theme. */
function RoleThemed({ children }: { children: React.ReactNode }) {
  const { me, activeRole } = useAuth();
  const door = usePendingRole();   // before sign-in, the door chosen on the landing page: renter = blue, owner = green
  const role = me ? (activeRole ?? me.roles[0] ?? 'owner') : (door ?? 'owner');
  setBrandRole(role);
  return <PaperProvider theme={themeFor(role)} settings={{ icon: (props) => <MaterialCommunityIcons {...(props as any)} /> }}>{children}</PaperProvider>;
}

/** Once someone is signed in: their saved entries are loaded, and sent whenever the connection allows. */
function OfflineSync() {
  const { me } = useAuth();
  React.useEffect(() => { void outbox.setUser(me?.id ?? null); }, [me?.id]);
  React.useEffect(() => (me ? startOfflineSync() : undefined), [!!me]);   // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function RootLayout() {
  React.useEffect(() => startNetworkMonitor(), []);        // is the phone online? known from the first screen on
  useFonts({ Montserrat_900Black_Italic });   // the landing page headline font; the screen draws at once and the font fills in when it is ready
  React.useEffect(() => {   // the language chosen last time on this phone, applied as the app opens
    loadLanguage().then((c) => { if (c && LANGUAGES.some((l) => l.code === c) && c !== i18n.language) i18n.changeLanguage(c); });
  }, []);
  React.useEffect(() => {   // whatever the server wrote in the old language (bell items, updates, statements) is fetched again in the new one
    const refetch = () => { queryClient.invalidateQueries(); };
    i18n.on('languageChanged', refetch);
    return () => { i18n.off('languageChanged', refetch); };
  }, []);
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: CACHE_MAX_AGE, buster: 'cache-v1', dehydrateOptions: { shouldDehydrateQuery: shouldSave } }}>
      <PaperProvider theme={themeFor('owner')} settings={{ icon: (props) => <MaterialCommunityIcons {...(props as any)} /> }}>
        <StatusBar style="light" />
        <AuthProvider>
          <OfflineSync />
          <RoleThemed>
            <Stack screenOptions={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
          </RoleThemed>
        </AuthProvider>
      </PaperProvider>
    </PersistQueryClientProvider>
  );
}
